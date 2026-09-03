import type {
  CuePoint,
  CuePointType,
  FieldSource,
  LibraryStats,
  PublicTrack,
  SearchTracksInput,
  SearchTracksResult,
  Track,
  TrackMetadataPatch,
} from "@dnb-crate/domain";
import {
  DomainError,
  DSP_ANALYZER_NAME,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  normalizeGenres,
  normalizeKey,
  normalizePersonName,
  recordingKeyFrom,
  resolveBpmHint,
  toPublicTrack,
  yearFromDate,
} from "@dnb-crate/domain";

import type { SqliteDatabase } from "./db.ts";
import { decodeCursor, encodeCursor, type SortDirection, type SortField } from "./pagination.ts";

type TrackRow = {
  id: string;
  file_path: string;
  file_fingerprint: string;
  artist: string | null;
  title: string;
  album: string | null;
  duration_ms: number;
  sample_rate_hz: number | null;
  channels: number | null;
  bpm: number | null;
  bpm_source: Track["bpmSource"];
  musical_key: string | null;
  camelot_key: string | null;
  key_source: Track["keySource"];
  energy: number | null;
  rating: number | null;
  notes: string | null;
  analysis_status: Track["analysisStatus"];
  file_missing: number;
  created_at: string;
  updated_at: string;
  label?: string | null;
  release_date?: string | null;
  isrc?: string | null;
  recording_mbid?: string | null;
  artist_canonical?: string | null;
  recording_key?: string | null;
  field_sources_json?: string | null;
};

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

export type UpsertTrackInput = Omit<
  Track,
  | "id"
  | "subgenres"
  | "moods"
  | "tags"
  | "energy"
  | "rating"
  | "notes"
  | "analysisStatus"
  | "fileMissing"
  | "createdAt"
  | "updatedAt"
> & {
  id?: string;
  label?: string | null;
  releaseDate?: string | null;
  isrc?: string | null;
  recordingMbid?: string | null;
  genres?: string[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function likePattern(query: string): string {
  return `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function parseFieldSources(raw: string | null | undefined): Record<string, FieldSource> {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, FieldSource> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === "tag" || value === "published" || value === "manual") {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function canWriteField(
  sources: Record<string, FieldSource>,
  field: string,
  incoming: FieldSource,
): boolean {
  const current = sources[field];
  if (incoming === "manual") {
    return true;
  }
  if (incoming === "published") {
    return current !== "manual";
  }
  return current == null || current === "tag";
}

export class TrackRepository {
  constructor(private readonly db: SqliteDatabase) {}

  findById(id: string): Track | null {
    const row = this.db.prepare("SELECT * FROM tracks WHERE id = ?").get(id) as
      TrackRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  findByFilePath(filePath: string): Track | null {
    const row = this.db.prepare("SELECT * FROM tracks WHERE file_path = ?").get(filePath) as
      TrackRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  findByFingerprint(fingerprint: string): Track[] {
    const rows = this.db
      .prepare("SELECT * FROM tracks WHERE file_fingerprint = ?")
      .all(fingerprint) as TrackRow[];
    return rows.map((row) => this.hydrate(row));
  }

  listPathIndex(): Array<{ id: string; filePath: string }> {
    const rows = this.db.prepare("SELECT id, file_path FROM tracks").all() as {
      id: string;
      file_path: string;
    }[];
    return rows.map((row) => ({ id: row.id, filePath: row.file_path }));
  }

  listAll(): Track[] {
    const rows = this.db.prepare("SELECT * FROM tracks").all() as TrackRow[];
    return rows.map((row) => this.hydrate(row));
  }

  listCuePoints(trackId: string): CuePoint[] {
    const rows = this.db
      .prepare("SELECT * FROM cue_points WHERE track_id = ? ORDER BY position_ms, id")
      .all(trackId) as Array<{
      id: string;
      track_id: string;
      type: CuePointType;
      position_ms: number;
      beat_index: number | null;
      bar_index: number | null;
      confidence: number | null;
      source: CuePoint["source"];
      label: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      trackId: row.track_id,
      type: row.type,
      positionMs: row.position_ms,
      beatIndex: row.beat_index,
      barIndex: row.bar_index,
      confidence: row.confidence,
      source: row.source,
      label: row.label,
    }));
  }

  replaceCuePoints(
    trackId: string,
    cuePoints: Array<{
      type: CuePointType;
      positionMs: number;
      beatIndex?: number | null;
      barIndex?: number | null;
      confidence?: number | null;
      label?: string | null;
    }>,
  ): CuePoint[] {
    const existing = this.findById(trackId);
    if (!existing) {
      throw new DomainError("TRACK_NOT_FOUND", `No track with id ${trackId}`);
    }
    for (const cue of cuePoints) {
      if (cue.positionMs > existing.durationMs) {
        throw new DomainError(
          "INVALID_METADATA",
          `Cue ${cue.type} at ${cue.positionMs}ms is past track duration ${existing.durationMs}ms`,
        );
      }
    }
    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM cue_points WHERE track_id = ?").run(trackId);
      const stmt = this.db.prepare(
        `INSERT INTO cue_points (id, track_id, type, position_ms, beat_index, bar_index, confidence, source, label)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
      );
      for (const cue of cuePoints) {
        stmt.run(
          crypto.randomUUID(),
          trackId,
          cue.type,
          cue.positionMs,
          cue.beatIndex ?? null,
          cue.barIndex ?? null,
          cue.confidence ?? null,
          cue.label ?? null,
        );
      }
    });
    run();
    return this.listCuePoints(trackId);
  }

  setAnalysisStatus(trackId: string, status: Track["analysisStatus"]): void {
    const existing = this.findById(trackId);
    if (!existing) {
      throw new DomainError("TRACK_NOT_FOUND", `No track with id ${trackId}`);
    }
    this.db
      .prepare("UPDATE tracks SET analysis_status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), trackId);
  }

  applyAnalyzedMetadata(
    trackId: string,
    input: { bpm: number | null; musicalKey: string | null },
  ): Track {
    const existing = this.findById(trackId);
    if (!existing) {
      throw new DomainError("TRACK_NOT_FOUND", `No track with id ${trackId}`);
    }
    let bpm = existing.bpm;
    let bpmSource = existing.bpmSource;
    let musicalKey = existing.musicalKey;
    let camelotKey = existing.camelotKey;
    let keySource = existing.keySource;
    if (existing.bpmSource !== "manual" && existing.bpmSource !== "published" && input.bpm !== null) {
      bpm = input.bpm;
      bpmSource = "analyzed";
    }
    if (existing.keySource !== "manual" && existing.keySource !== "published" && input.musicalKey !== null) {
      const normalized = normalizeKey(input.musicalKey);
      musicalKey = normalized?.musicalKey ?? input.musicalKey;
      camelotKey = normalized?.camelotKey ?? null;
      keySource = "analyzed";
    }
    this.db
      .prepare(
        `UPDATE tracks SET bpm = ?, bpm_source = ?, musical_key = ?, camelot_key = ?, key_source = ?,
          analysis_status = 'complete', updated_at = ? WHERE id = ?`,
      )
      .run(bpm, bpmSource, musicalKey, camelotKey, keySource, nowIso(), trackId);
    return this.findById(trackId)!;
  }

  insertAnalyzedCuesIfAbsent(
    trackId: string,
    cues: Array<{
      type: CuePointType;
      positionMs: number;
      beatIndex: number | null;
      barIndex: number | null;
      confidence: number;
    }>,
  ): void {
    const existing = this.listCuePoints(trackId);
    const present = new Set(existing.map((cue) => cue.type));
    const stmt = this.db.prepare(
      `INSERT INTO cue_points (id, track_id, type, position_ms, beat_index, bar_index, confidence, source, label)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'analyzed', NULL)`,
    );
    const run = this.db.transaction(() => {
      for (const cue of cues) {
        if (present.has(cue.type)) {
          continue;
        }
        stmt.run(
          crypto.randomUUID(),
          trackId,
          cue.type,
          cue.positionMs,
          cue.beatIndex,
          cue.barIndex,
          cue.confidence,
        );
        present.add(cue.type);
      }
    });
    run();
  }

  listForResource(limit: number): PublicTrack[] {
    const rows = this.db
      .prepare("SELECT * FROM tracks ORDER BY updated_at DESC, id ASC LIMIT ?")
      .all(limit) as TrackRow[];
    return rows.map((row) => toPublicTrack(this.hydrate(row)));
  }

  upsertFromScan(input: UpsertTrackInput): { track: Track; moved: boolean } {
    const existingByPath = this.findByFilePath(input.filePath);
    if (existingByPath) {
      return { track: this.updateScanFields(existingByPath.id, input), moved: false };
    }

    const fingerprintMatches = this.findByFingerprint(input.fileFingerprint);
    const moveCandidate = fingerprintMatches.find((track) => track.fileMissing);
    if (moveCandidate) {
      return { track: this.updateScanFields(moveCandidate.id, input), moved: true };
    }

    const id = input.id ?? crypto.randomUUID();
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO tracks (
          id, file_path, file_fingerprint, artist, title, album, duration_ms, sample_rate_hz, channels,
          bpm, bpm_source, musical_key, camelot_key, key_source, analysis_status, file_missing, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_analyzed', 0, ?, ?)`,
      )
      .run(
        id,
        input.filePath,
        input.fileFingerprint,
        input.artist,
        input.title,
        input.album,
        input.durationMs,
        input.sampleRateHz,
        input.channels,
        input.bpm,
        input.bpmSource,
        input.musicalKey,
        input.camelotKey,
        input.keySource,
        timestamp,
        timestamp,
      );
    this.applyTagFields(id, input);
    const created = this.findById(id);
    if (!created) {
      throw new DomainError("SCAN_FAILED", "Failed to read track after insert");
    }
    return { track: created, moved: false };
  }

  markMissing(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    const timestamp = nowIso();
    const stmt = this.db.prepare("UPDATE tracks SET file_missing = 1, updated_at = ? WHERE id = ?");
    const run = this.db.transaction(() => {
      for (const id of ids) {
        stmt.run(timestamp, id);
      }
    });
    run();
  }

  updateMetadata(id: string, patch: TrackMetadataPatch): Track {
    const existing = this.findById(id);
    if (!existing) {
      throw new DomainError("TRACK_NOT_FOUND", `No track with id ${id}`);
    }

    const energy = patch.energy === undefined ? existing.energy : patch.energy;
    const rating = patch.rating === undefined ? existing.rating : patch.rating;
    let bpm = existing.bpm;
    let bpmSource = existing.bpmSource;
    let musicalKey = existing.musicalKey;
    let camelotKey = existing.camelotKey;
    let keySource = existing.keySource;
    if (patch.bpm !== undefined) {
      bpm = patch.bpm;
      bpmSource =
        patch.bpm === null ? null : (patch.bpmSource ?? "manual");
    }
    if (patch.musicalKey !== undefined) {
      if (patch.musicalKey === null) {
        musicalKey = null;
        camelotKey = null;
        keySource = null;
      } else {
        const normalized = normalizeKey(patch.musicalKey);
        musicalKey = normalized?.musicalKey ?? patch.musicalKey;
        camelotKey = normalized?.camelotKey ?? null;
        keySource = patch.keySource ?? "manual";
      }
    }
    let notes = patch.notes === undefined ? existing.notes : patch.notes;
    if (patch.metadataSourceNote) {
      const stamp = `[source] ${patch.metadataSourceNote}`;
      notes = notes ? `${notes}\n${stamp}` : stamp;
    }
    const timestamp = nowIso();
    const sources = { ...(existing.fieldSources ?? {}) };
    const album = patch.album === undefined ? existing.album : patch.album;
    const label = patch.label === undefined ? existing.label ?? null : patch.label;
    const releaseDate =
      patch.releaseDate === undefined ? existing.releaseDate ?? null : patch.releaseDate;
    const isrc = patch.isrc === undefined ? existing.isrc ?? null : patch.isrc;
    if (patch.album !== undefined) {
      sources.album = "manual";
    }
    if (patch.label !== undefined) {
      sources.label = "manual";
    }
    if (patch.releaseDate !== undefined) {
      sources.releaseDate = "manual";
    }
    if (patch.isrc !== undefined) {
      sources.isrc = "manual";
    }
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE tracks SET energy = ?, rating = ?, notes = ?, bpm = ?, bpm_source = ?,
            musical_key = ?, camelot_key = ?, key_source = ?, album = ?, label = ?,
            release_date = ?, isrc = ?, field_sources_json = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          energy,
          rating,
          notes,
          bpm,
          bpmSource,
          musicalKey,
          camelotKey,
          keySource,
          album,
          label,
          releaseDate,
          isrc,
          JSON.stringify(sources),
          timestamp,
          id,
        );

      if (patch.moods !== undefined) {
        this.replaceList("track_moods", "mood", id, patch.moods);
      }
      if (patch.subgenres !== undefined) {
        this.replaceList("track_subgenres", "subgenre", id, patch.subgenres);
      }
      if (patch.tags !== undefined) {
        this.replaceList("track_tags", "tag", id, patch.tags);
      }
      if (patch.genres !== undefined) {
        this.replaceGenres(id, patch.genres, "manual");
        sources.genres = "manual";
        this.db
          .prepare("UPDATE tracks SET field_sources_json = ? WHERE id = ?")
          .run(JSON.stringify(sources), id);
      }
    });
    run();
    this.refreshRecordingIdentity(id);

    const updated = this.findById(id);
    if (!updated) {
      throw new DomainError("TRACK_NOT_FOUND", `No track with id ${id} after update`);
    }
    return updated;
  }

  search(input: SearchTracksInput): SearchTracksResult {
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

    this.pushListFilter(
      where,
      params,
      "track_subgenres",
      "subgenre",
      input.subgenres,
      input.subgenresMatch ?? "any",
    );
    this.pushListFilter(
      where,
      params,
      "track_moods",
      "mood",
      input.moods,
      input.moodsMatch ?? "any",
    );
    this.pushListFilter(where, params, "track_tags", "tag", input.tags, input.tagsMatch ?? "any");

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
        throw new DomainError(
          "INVALID_CURSOR",
          "Pagination cursor does not match the current sort",
        );
      }
      const operator = direction === "asc" ? ">" : "<";
      // NULLS LAST for both directions: missing values sort after present ones in asc,
      // and still last in desc by putting IS NULL first only for the opposite of SQL default.
      where.push(`(
        (${column} IS NULL AND ? IS NULL AND tracks.id ${operator} ?)
        OR (${column} IS NOT NULL AND ? IS NULL)
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
    const rows = this.db
      .prepare(`SELECT tracks.* FROM tracks ${whereSql} ${orderSql} LIMIT ?`)
      .all(...params, limit + 1) as TrackRow[];

    const page = rows.slice(0, limit).map((row) => this.hydrate(row));
    const last = page[page.length - 1];
    let nextCursor: string | null = null;
    if (rows.length > limit && last) {
      nextCursor = encodeCursor({
        sort,
        direction,
        value: this.sortValue(last, sort),
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

  stats(): LibraryStats {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) AS track_count,
          SUM(file_missing) AS missing_file_count,
          IFNULL(SUM(duration_ms), 0) AS total_duration_ms,
          SUM(CASE WHEN artist IS NULL THEN 1 ELSE 0 END) AS missing_artist_count,
          SUM(CASE WHEN bpm IS NULL THEN 1 ELSE 0 END) AS missing_bpm_count,
          SUM(CASE WHEN musical_key IS NULL THEN 1 ELSE 0 END) AS missing_key_count,
          SUM(CASE WHEN energy IS NULL THEN 1 ELSE 0 END) AS missing_energy_count,
          SUM(CASE WHEN rating IS NULL THEN 1 ELSE 0 END) AS missing_rating_count
         FROM tracks`,
      )
      .get() as {
      track_count: number;
      missing_file_count: number | null;
      total_duration_ms: number;
      missing_artist_count: number;
      missing_bpm_count: number;
      missing_key_count: number;
      missing_energy_count: number;
      missing_rating_count: number;
    };

    const paths = this.db.prepare("SELECT title, file_path FROM tracks").all() as {
      title: string;
      file_path: string;
    }[];
    const extensionCounts: Record<string, number> = {};
    let missingTitleFromTagsCount = 0;
    for (const item of paths) {
      const ext = (/\.[^.]+$/.exec(item.file_path)?.[0] ?? "").toLowerCase();
      if (ext.length > 0) {
        extensionCounts[ext] = (extensionCounts[ext] ?? 0) + 1;
      }
      const stem = item.file_path
        .replaceAll("\\", "/")
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "");
      if (stem !== undefined && stem === item.title) {
        missingTitleFromTagsCount += 1;
      }
    }

    return {
      trackCount: row.track_count,
      missingFileCount: row.missing_file_count ?? 0,
      totalDurationMs: row.total_duration_ms,
      extensionCounts,
      missingTitleFromTagsCount,
      missingArtistCount: row.missing_artist_count,
      missingBpmCount: row.missing_bpm_count,
      missingKeyCount: row.missing_key_count,
      missingEnergyCount: row.missing_energy_count,
      missingRatingCount: row.missing_rating_count,
      analysisCoverage: this.analysisCoverage(),
      metadataCoverage: this.metadataCoverage(),
      descriptorPercentiles: this.descriptorPercentiles(),
    };
  }

  private tableExists(name: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as { ok: number } | undefined;
    return row !== undefined;
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.some((item) => item.name === column);
  }

  private sourceCounts(column: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(${column}, 'NULL') AS source, COUNT(*) AS n FROM tracks GROUP BY ${column}`,
      )
      .all() as { source: string; n: number }[];
    const out: Record<string, number> = {};
    for (const item of rows) {
      out[item.source] = item.n;
    }
    return out;
  }

  private percentileTriple(values: number[]): LibraryStats["descriptorPercentiles"]["energy"] {
    if (values.length === 0) {
      return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p: number): number => {
      const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
      return sorted[index]!;
    };
    return { p10: at(0.1), p50: at(0.5), p90: at(0.9) };
  }

  private descriptorPercentiles(): LibraryStats["descriptorPercentiles"] {
    const empty = {
      energy: null,
      danceability: null,
      valence: null,
      acousticness: null,
      melodicness: null,
      subBass: null,
      brightness: null,
    };
    if (!this.tableExists("track_analyses") || !this.hasColumn("track_analyses", "descriptors_json")) {
      return empty;
    }
    const rows = this.db
      .prepare("SELECT descriptors_json FROM track_analyses WHERE descriptors_json IS NOT NULL")
      .all() as { descriptors_json: string }[];
    const buckets: Record<string, number[]> = {
      energy: [],
      danceability: [],
      valence: [],
      acousticness: [],
      melodicness: [],
      subBass: [],
      brightness: [],
    };
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.descriptors_json) as Record<string, unknown>;
        const push = (key: string, value: unknown): void => {
          if (typeof value === "number" && Number.isFinite(value)) {
            buckets[key]?.push(value);
          }
        };
        push("energy", parsed.energy);
        push("danceability", parsed.danceability);
        push("valence", parsed.valence);
        push("acousticness", parsed.acousticness);
        push("melodicness", parsed.melodicness);
        push("subBass", parsed.subBassRatio);
        push("brightness", parsed.brightness);
      } catch {
        // skip malformed rows
      }
    }
    return {
      energy: this.percentileTriple(buckets.energy ?? []),
      danceability: this.percentileTriple(buckets.danceability ?? []),
      valence: this.percentileTriple(buckets.valence ?? []),
      acousticness: this.percentileTriple(buckets.acousticness ?? []),
      melodicness: this.percentileTriple(buckets.melodicness ?? []),
      subBass: this.percentileTriple(buckets.subBass ?? []),
      brightness: this.percentileTriple(buckets.brightness ?? []),
    };
  }

  private analysisCoverage(): LibraryStats["analysisCoverage"] {
    const statusRows = this.db
      .prepare("SELECT analysis_status AS status, COUNT(*) AS n FROM tracks GROUP BY analysis_status")
      .all() as { status: string; n: number }[];
    let analyzed = 0;
    let notAnalyzed = 0;
    for (const item of statusRows) {
      if (item.status === "complete") {
        analyzed = item.n;
      } else if (item.status === "not_analyzed") {
        notAnalyzed = item.n;
      }
    }

    const byEngineVersion: Record<string, number> = {};
    let accepted = 0;
    let rejected = 0;
    let reference = 0;
    let bpmHintOnly = 0;
    if (this.tableExists("track_analyses")) {
      const engineRows = this.db
        .prepare(
          `SELECT analyzer_name || '@' || analyzer_version AS key, COUNT(*) AS n
           FROM track_analyses GROUP BY analyzer_name, analyzer_version`,
        )
        .all() as { key: string; n: number }[];
      for (const item of engineRows) {
        byEngineVersion[item.key] = item.n;
      }
      const dsp = this.db
        .prepare(
          `SELECT
             SUM(CASE WHEN grid_rejected = 0 AND IFNULL(grid_source, 'analyzed') <> 'reference' THEN 1 ELSE 0 END) AS accepted,
             SUM(CASE WHEN grid_rejected = 1 THEN 1 ELSE 0 END) AS rejected,
             SUM(CASE WHEN grid_source = 'reference' AND grid_rejected = 0 THEN 1 ELSE 0 END) AS reference
           FROM track_analyses WHERE analyzer_name = ?`,
        )
        .get(DSP_ANALYZER_NAME) as {
        accepted: number | null;
        rejected: number | null;
        reference: number | null;
      };
      accepted = dsp.accepted ?? 0;
      rejected = dsp.rejected ?? 0;
      reference = dsp.reference ?? 0;
      const hintRows = this.db
        .prepare(
          `SELECT bpm_raw, bpm_confidence, grid_rejected
           FROM track_analyses WHERE analyzer_name = ?`,
        )
        .all(DSP_ANALYZER_NAME) as Array<{
        bpm_raw: number | null;
        bpm_confidence: number | null;
        grid_rejected: number;
      }>;
      bpmHintOnly = hintRows.filter(
        (row) =>
          resolveBpmHint({
            gridRejected: row.grid_rejected === 1,
            bpmRaw: row.bpm_raw,
            bpmConfidence: row.bpm_confidence,
          }).bpm != null,
      ).length;
    }

    return { analyzed, notAnalyzed, byEngineVersion, accepted, rejected, reference, bpmHintOnly };
  }

  private metadataCoverage(): LibraryStats["metadataCoverage"] {
    const energy = (
      this.db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE energy IS NOT NULL").get() as {
        n: number;
      }
    ).n;
    const moods = this.tableExists("track_moods")
      ? (this.db.prepare("SELECT COUNT(DISTINCT track_id) AS n FROM track_moods").get() as { n: number })
          .n
      : 0;
    const genres = this.tableExists("track_genres")
      ? (this.db.prepare("SELECT COUNT(DISTINCT track_id) AS n FROM track_genres").get() as { n: number })
          .n
      : 0;
    const countNonEmpty = (column: string): number => {
      if (!this.hasColumn("tracks", column)) {
        return 0;
      }
      return (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM tracks WHERE ${column} IS NOT NULL AND ${column} <> ''`,
          )
          .get() as { n: number }
      ).n;
    };
    let duplicateGroups = 0;
    if (this.hasColumn("tracks", "recording_key")) {
      duplicateGroups = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM (
               SELECT recording_key FROM tracks
               WHERE recording_key IS NOT NULL
               GROUP BY recording_key
               HAVING COUNT(*) > 1
             )`,
          )
          .get() as { n: number }
      ).n;
    }
    return {
      bpmBySource: this.sourceCounts("bpm_source"),
      keyBySource: this.sourceCounts("key_source"),
      energy,
      moods,
      genres,
      isrc: countNonEmpty("isrc"),
      label: countNonEmpty("label"),
      releaseDate: countNonEmpty("release_date"),
      recordingMbid: countNonEmpty("recording_mbid"),
      duplicateGroups,
    };
  }

  private sortValue(track: Track, sort: SortField): string | number | null {
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

  private pushListFilter(
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

  private replaceList(
    table: "track_moods" | "track_subgenres" | "track_tags",
    column: string,
    trackId: string,
    values: string[],
  ): void {
    this.db.prepare(`DELETE FROM ${table} WHERE track_id = ?`).run(trackId);
    const stmt = this.db.prepare(`INSERT INTO ${table} (track_id, ${column}) VALUES (?, ?)`);
    const unique = [
      ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
    ];
    for (const value of unique) {
      stmt.run(trackId, value);
    }
  }

  applyTagFields(
    id: string,
    input: {
      album?: string | null;
      label?: string | null;
      releaseDate?: string | null;
      isrc?: string | null;
      recordingMbid?: string | null;
      genres?: string[];
    },
  ): void {
    const row = this.db.prepare("SELECT * FROM tracks WHERE id = ?").get(id) as TrackRow | undefined;
    if (!row) {
      return;
    }
    const sources = parseFieldSources(row.field_sources_json);
    const assignments: string[] = [];
    const values: unknown[] = [];
    const setIf = (column: string, field: string, value: string | null | undefined): void => {
      if (value == null || value === "") {
        return;
      }
      if (!canWriteField(sources, field, "tag")) {
        return;
      }
      assignments.push(`${column} = ?`);
      values.push(value);
      sources[field] = "tag";
    };
    setIf("album", "album", input.album);
    setIf("label", "label", input.label);
    setIf("release_date", "releaseDate", input.releaseDate);
    setIf("isrc", "isrc", input.isrc);
    setIf("recording_mbid", "recordingMbid", input.recordingMbid);
    if (assignments.length > 0) {
      assignments.push("field_sources_json = ?", "updated_at = ?");
      values.push(JSON.stringify(sources), nowIso(), id);
      this.db.prepare(`UPDATE tracks SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    }
    if ((input.genres?.length ?? 0) > 0 && canWriteField(sources, "genres", "tag")) {
      this.replaceGenres(id, input.genres ?? [], "tag");
      sources.genres = "tag";
      this.writeFieldSources(id, sources);
    }
    this.refreshRecordingIdentity(id);
  }

  refreshRecordingIdentity(trackId: string): void {
    const row = this.db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId) as
      | TrackRow
      | undefined;
    if (!row) {
      return;
    }
    const sources = parseFieldSources(row.field_sources_json);
    const artistCanonical =
      sources.artistCanonical === "published" && row.artist_canonical
        ? row.artist_canonical
        : row.artist
          ? normalizePersonName(row.artist)
          : (row.artist_canonical ?? null);
    const recordingKey = recordingKeyFrom({
      recordingMbid: row.recording_mbid ?? null,
      isrc: row.isrc ?? null,
      artistCanonical,
      artist: row.artist,
      title: row.title,
      durationMs: row.duration_ms,
    });
    this.db
      .prepare(
        `UPDATE tracks SET artist_canonical = ?, recording_key = ?, updated_at = ? WHERE id = ?`,
      )
      .run(artistCanonical, recordingKey, nowIso(), trackId);
  }

  applyPublishedEnrichment(
    trackId: string,
    patch: {
      album: string | null;
      label: string | null;
      releaseDate: string | null;
      isrc: string | null;
      recordingMbid: string | null;
      artistCanonical: string | null;
      genres: string[];
      bpm: number | null;
    },
  ): void {
    const row = this.db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId) as
      | TrackRow
      | undefined;
    if (!row) {
      throw new DomainError("TRACK_NOT_FOUND", `No track with id ${trackId}`);
    }
    const sources = parseFieldSources(row.field_sources_json);
    const assignments: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, field: string, value: unknown): void => {
      if (value == null || value === "") {
        return;
      }
      if (!canWriteField(sources, field, "published")) {
        return;
      }
      assignments.push(`${column} = ?`);
      values.push(value);
      sources[field] = "published";
    };
    set("album", "album", patch.album);
    set("label", "label", patch.label);
    set("release_date", "releaseDate", patch.releaseDate);
    set("isrc", "isrc", patch.isrc);
    set("recording_mbid", "recordingMbid", patch.recordingMbid);
    if (patch.artistCanonical && canWriteField(sources, "artistCanonical", "published")) {
      assignments.push("artist_canonical = ?");
      values.push(patch.artistCanonical);
      sources.artistCanonical = "published";
    }
    if (patch.bpm != null && row.bpm_source !== "manual" && row.bpm_source !== "published") {
      assignments.push("bpm = ?", "bpm_source = ?");
      values.push(patch.bpm, "published");
    }
    assignments.push("field_sources_json = ?", "updated_at = ?");
    values.push(JSON.stringify(sources), nowIso(), trackId);
    this.db.prepare(`UPDATE tracks SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    if (patch.genres.length > 0 && canWriteField(sources, "genres", "published")) {
      this.replaceGenres(trackId, patch.genres, "published");
      sources.genres = "published";
      this.writeFieldSources(trackId, sources);
    }
    this.refreshRecordingIdentity(trackId);
  }

  private writeFieldSources(trackId: string, sources: Record<string, FieldSource>): void {
    this.db
      .prepare("UPDATE tracks SET field_sources_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(sources), nowIso(), trackId);
  }

  private replaceGenres(trackId: string, genres: string[], source: FieldSource): void {
    this.db.prepare("DELETE FROM track_genres WHERE track_id = ?").run(trackId);
    const insert = this.db.prepare(
      "INSERT INTO track_genres (track_id, genre, source) VALUES (?, ?, ?)",
    );
    for (const genre of normalizeGenres(genres)) {
      insert.run(trackId, genre, source);
    }
  }

  private updateScanFields(id: string, input: UpsertTrackInput): Track {
    const existing = this.findById(id);
    const keepBpm =
      existing?.bpmSource === "manual" ||
      existing?.bpmSource === "analyzed" ||
      existing?.bpmSource === "published";
    const keepKey =
      existing?.keySource === "manual" ||
      existing?.keySource === "analyzed" ||
      existing?.keySource === "published";
    const timestamp = nowIso();
    this.db
      .prepare(
        `UPDATE tracks SET
          file_path = ?,
          file_fingerprint = ?,
          artist = ?,
          title = ?,
          duration_ms = ?,
          sample_rate_hz = ?,
          channels = ?,
          bpm = ?,
          bpm_source = ?,
          musical_key = ?,
          camelot_key = ?,
          key_source = ?,
          file_missing = 0,
          updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.filePath,
        input.fileFingerprint,
        input.artist,
        input.title,
        input.durationMs,
        input.sampleRateHz,
        input.channels,
        keepBpm && existing ? existing.bpm : input.bpm,
        keepBpm && existing ? existing.bpmSource : input.bpmSource,
        keepKey && existing ? existing.musicalKey : input.musicalKey,
        keepKey && existing ? existing.camelotKey : input.camelotKey,
        keepKey && existing ? existing.keySource : input.keySource,
        timestamp,
        id,
      );
    this.applyTagFields(id, input);
    const updated = this.findById(id);
    if (!updated) {
      throw new DomainError("SCAN_FAILED", "Failed to read track after upsert");
    }
    return updated;
  }

  private hydrate(row: TrackRow): Track {
    const moods = this.db
      .prepare("SELECT mood FROM track_moods WHERE track_id = ? ORDER BY mood")
      .all(row.id) as { mood: string }[];
    const subgenres = this.db
      .prepare("SELECT subgenre FROM track_subgenres WHERE track_id = ? ORDER BY subgenre")
      .all(row.id) as { subgenre: string }[];
    const tags = this.db
      .prepare("SELECT tag FROM track_tags WHERE track_id = ? ORDER BY tag")
      .all(row.id) as { tag: string }[];
    const genres = this.tableExists("track_genres")
      ? (
          this.db
            .prepare("SELECT genre FROM track_genres WHERE track_id = ? ORDER BY genre")
            .all(row.id) as { genre: string }[]
        ).map((item) => item.genre)
      : [];
    const fieldSources = parseFieldSources(row.field_sources_json);
    const artistCanonical =
      row.artist_canonical ?? (row.artist ? normalizePersonName(row.artist) : null);
    const recordingKey =
      row.recording_key ??
      recordingKeyFrom({
        recordingMbid: row.recording_mbid ?? null,
        isrc: row.isrc ?? null,
        artistCanonical,
        artist: row.artist,
        title: row.title,
        durationMs: row.duration_ms,
      });

    return {
      id: row.id,
      filePath: row.file_path,
      fileFingerprint: row.file_fingerprint,
      artist: row.artist,
      title: row.title,
      album: row.album,
      durationMs: row.duration_ms,
      sampleRateHz: row.sample_rate_hz,
      channels: row.channels,
      bpm: row.bpm,
      bpmSource: row.bpm_source,
      musicalKey: row.musical_key,
      camelotKey: row.camelot_key,
      keySource: row.key_source,
      energy: row.energy,
      rating: row.rating,
      subgenres: subgenres.map((item) => item.subgenre),
      moods: moods.map((item) => item.mood),
      tags: tags.map((item) => item.tag),
      notes: row.notes,
      analysisStatus: row.analysis_status,
      fileMissing: row.file_missing === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      label: row.label ?? null,
      releaseDate: row.release_date ?? null,
      year: yearFromDate(row.release_date ?? null),
      isrc: row.isrc ?? null,
      recordingMbid: row.recording_mbid ?? null,
      artistCanonical,
      recordingKey,
      genres,
      fieldSources,
    };
  }
}
