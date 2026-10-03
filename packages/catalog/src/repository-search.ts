import type { SearchTracksInput, SearchTracksResult, Track } from "@dnb-crate/domain";
import {
  DomainError,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  toPublicTrack,
} from "@dnb-crate/domain";

import type { SqliteDatabase } from "./db.ts";
import { decodeCursor, encodeCursor, type SortDirection, type SortField } from "./pagination.ts";
import type { TrackRow } from "./repository.ts";

const SORT_COLUMNS: Record<SortField, string> = {
  title: "tracks.title",
  artist: "tracks.artist",
  album: "tracks.album",
  bpm: "tracks.bpm",
  energy: "tracks.energy",
  rating: "tracks.rating",
  durationMs: "tracks.duration_ms",
  createdAt: "tracks.created_at",
  updatedAt: "tracks.updated_at",
};

function likePattern(query: string): string {
  return `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function sortValue(track: Track, sort: SortField): string | number | null {
  switch (sort) {
    case "title":
      return track.title;
    case "artist":
      return track.artist;
    case "album":
      return track.album;
    case "bpm":
      return track.bpm;
    case "energy":
      return track.energy;
    case "rating":
      return track.rating;
    case "durationMs":
      return track.durationMs;
    case "createdAt":
      return track.createdAt;
    case "updatedAt":
      return track.updatedAt;
  }
}

function pushListFilter(
  where: string[],
  params: unknown[],
  table: string,
  column: string,
  values: string[] | undefined,
  mode: "any" | "all",
): void {
  if (values === undefined || values.length === 0) {
    return;
  }
  const placeholders = values.map(() => "LOWER(?)").join(", ");
  if (mode === "all") {
    where.push(
      `(SELECT COUNT(DISTINCT LOWER(${column})) FROM ${table} WHERE track_id = tracks.id AND LOWER(${column}) IN (${placeholders})) = ?`,
    );
    params.push(...values, values.length);
    return;
  }
  where.push(
    `EXISTS (SELECT 1 FROM ${table} WHERE track_id = tracks.id AND LOWER(${column}) IN (${placeholders}))`,
  );
  params.push(...values);
}

/** Compile and run the catalog search; hydration is provided by the owning
 * repository so relation loading stays in one place. */
export function searchTracks(
  db: SqliteDatabase,
  hydrateRows: (rows: TrackRow[]) => Track[],
  input: SearchTracksInput,
): SearchTracksResult {
  const sort: SortField = input.sort ?? "title";
  const direction: SortDirection = input.direction ?? "asc";
  const limit = Math.min(input.limit ?? SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
  const column = SORT_COLUMNS[sort];

  const where: string[] = [];
  const params: unknown[] = [];

  if (input.query !== undefined && input.query.trim().length > 0) {
    const pattern = likePattern(input.query.trim());
    where.push(`(
        tracks.title LIKE ? ESCAPE '\\' OR
        IFNULL(tracks.artist, '') LIKE ? ESCAPE '\\' OR
        IFNULL(tracks.album, '') LIKE ? ESCAPE '\\' OR
        IFNULL(tracks.notes, '') LIKE ? ESCAPE '\\' OR
        EXISTS (SELECT 1 FROM track_tags tt WHERE tt.track_id = tracks.id AND tt.tag LIKE ? ESCAPE '\\')
      )`);
    params.push(pattern, pattern, pattern, pattern, pattern);
  }

  if (input.artist !== undefined) {
    where.push("LOWER(tracks.artist) = LOWER(?)");
    params.push(input.artist);
  }
  if (input.bpmMin !== undefined) {
    where.push("tracks.bpm >= ?");
    params.push(input.bpmMin);
  }
  if (input.bpmMax !== undefined) {
    where.push("tracks.bpm <= ?");
    params.push(input.bpmMax);
  }
  if (input.musicalKey !== undefined) {
    where.push("(LOWER(tracks.musical_key) = LOWER(?) OR LOWER(tracks.camelot_key) = LOWER(?))");
    params.push(input.musicalKey, input.musicalKey);
  }
  if (input.camelotKey !== undefined) {
    where.push("LOWER(tracks.camelot_key) = LOWER(?)");
    params.push(input.camelotKey);
  }
  if (input.energyMin !== undefined) {
    where.push("tracks.energy >= ?");
    params.push(input.energyMin);
  }
  if (input.energyMax !== undefined) {
    where.push("tracks.energy <= ?");
    params.push(input.energyMax);
  }
  if (input.minRating !== undefined) {
    where.push("tracks.rating >= ?");
    params.push(input.minRating);
  }
  if (input.analysisStatus !== undefined) {
    where.push("tracks.analysis_status = ?");
    params.push(input.analysisStatus);
  }

  pushListFilter(
    where,
    params,
    "track_subgenres",
    "subgenre",
    input.subgenres,
    input.subgenresMatch ?? "any",
  );
  pushListFilter(where, params, "track_moods", "mood", input.moods, input.moodsMatch ?? "any");
  pushListFilter(where, params, "track_tags", "tag", input.tags, input.tagsMatch ?? "any");

  const descriptorBounds: Array<{ path: string; min?: number; max?: number }> = [];
  if (input.subBassMin !== undefined || input.subBassMax !== undefined) {
    descriptorBounds.push({
      path: "$.subBassRatio",
      min: input.subBassMin,
      max: input.subBassMax,
    });
  }
  if (input.brightnessMin !== undefined || input.brightnessMax !== undefined) {
    descriptorBounds.push({
      path: "$.brightness",
      min: input.brightnessMin,
      max: input.brightnessMax,
    });
  }
  const nested = input.descriptors;
  if (nested) {
    const map: Array<[string, string]> = [
      ["energy", "$.energy"],
      ["danceability", "$.danceability"],
      ["valence", "$.valence"],
      ["acousticness", "$.acousticness"],
      ["melodicness", "$.melodicness"],
      ["subBass", "$.subBassRatio"],
      ["brightness", "$.brightness"],
    ];
    for (const [key, jsonPath] of map) {
      const range = nested[key as keyof typeof nested];
      if (range?.min !== undefined || range?.max !== undefined) {
        descriptorBounds.push({ path: jsonPath, min: range.min, max: range.max });
      }
    }
  }
  for (const bound of descriptorBounds) {
    where.push(`EXISTS (
        SELECT 1 FROM track_analyses ta
        WHERE ta.track_id = tracks.id
          AND (? IS NULL OR json_extract(ta.descriptors_json, '${bound.path}') >= ?)
          AND (? IS NULL OR json_extract(ta.descriptors_json, '${bound.path}') <= ?)
      )`);
    params.push(bound.min ?? null, bound.min ?? 0, bound.max ?? null, bound.max ?? 1);
  }

  if (input.genres?.include && input.genres.include.length > 0) {
    const include = input.genres.include.map((item) => item.trim().toLowerCase());
    const placeholders = include.map(() => "LOWER(?)").join(", ");
    where.push(
      `EXISTS (SELECT 1 FROM track_genres WHERE track_id = tracks.id AND LOWER(genre) IN (${placeholders}))`,
    );
    params.push(...include);
  }
  if (input.genres?.exclude && input.genres.exclude.length > 0) {
    const exclude = input.genres.exclude.map((item) => item.trim().toLowerCase());
    const placeholders = exclude.map(() => "LOWER(?)").join(", ");
    where.push(
      `NOT EXISTS (SELECT 1 FROM track_genres WHERE track_id = tracks.id AND LOWER(genre) IN (${placeholders}))`,
    );
    params.push(...exclude);
  }

  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    if (cursor.sort !== sort || cursor.direction !== direction) {
      throw new DomainError("INVALID_CURSOR", "Pagination cursor does not match the current sort");
    }
    const operator = direction === "asc" ? ">" : "<";
    // NULLS LAST in either direction: enter the null group after a non-null cursor,
    // and never return to non-null values once the cursor is in the null group.
    where.push(`(
        (${column} IS NULL AND ? IS NULL AND tracks.id ${operator} ?)
        OR (${column} IS NULL AND ? IS NOT NULL)
        OR (${column} IS NOT NULL AND ? IS NOT NULL AND (${column} ${operator} ? OR (${column} = ? AND tracks.id ${operator} ?)))
      )`);
    params.push(
      cursor.value,
      cursor.id,
      cursor.value,
      cursor.value,
      cursor.value,
      cursor.value,
      cursor.id,
    );
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const orderSql = `ORDER BY (${column} IS NULL), ${column} ${direction.toUpperCase()}, tracks.id ${direction.toUpperCase()}`;
  const rows = db
    .prepare(`SELECT tracks.* FROM tracks ${whereSql} ${orderSql} LIMIT ?`)
    .all(...params, limit + 1) as TrackRow[];

  const page = hydrateRows(rows.slice(0, limit));
  const last = page[page.length - 1];
  let nextCursor: string | null = null;
  if (rows.length > limit && last) {
    nextCursor = encodeCursor({
      sort,
      direction,
      value: sortValue(last, sort),
      id: last.id,
    });
  }

  return {
    tracks: page.map(toPublicTrack),
    nextCursor,
    limit,
    sort,
    direction,
  };
}
