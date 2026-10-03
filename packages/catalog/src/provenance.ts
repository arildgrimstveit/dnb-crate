import type { FieldSource } from "@dnb-crate/domain";
import { DomainError, normalizeGenres, normalizePersonName } from "@dnb-crate/domain";
import { recordingKeyFrom } from "@dnb-crate/domain";

import type { SqliteDatabase } from "./db.ts";
import { nowIso } from "./now-iso.ts";
import type { TrackRow } from "./repository.ts";

export function parseFieldSources(raw: string | null | undefined): Record<string, FieldSource> {
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

export function canWriteField(
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

/** Recording identity input shared by the identity refresh and row hydration. */
export function recordingKeyOfRow(row: TrackRow, artistCanonical: string | null): string {
  return recordingKeyFrom({
    recordingMbid: row.recording_mbid ?? null,
    isrc: row.isrc ?? null,
    artistCanonical,
    artist: row.artist,
    title: row.title,
    durationMs: row.duration_ms,
  });
}

export function writeFieldSources(
  db: SqliteDatabase,
  trackId: string,
  sources: Record<string, FieldSource>,
): void {
  db.prepare("UPDATE tracks SET field_sources_json = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(sources),
    nowIso(),
    trackId,
  );
}

export function replaceGenres(
  db: SqliteDatabase,
  trackId: string,
  genres: string[],
  source: FieldSource,
): void {
  db.prepare("DELETE FROM track_genres WHERE track_id = ?").run(trackId);
  const insert = db.prepare("INSERT INTO track_genres (track_id, genre, source) VALUES (?, ?, ?)");
  for (const genre of normalizeGenres(genres)) {
    insert.run(trackId, genre, source);
  }
}

export function refreshRecordingIdentity(db: SqliteDatabase, trackId: string): void {
  const row = db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId) as TrackRow | undefined;
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
  const recordingKey = recordingKeyOfRow(row, artistCanonical);
  db.prepare(
    `UPDATE tracks SET artist_canonical = ?, recording_key = ?, updated_at = ? WHERE id = ?`,
  ).run(artistCanonical, recordingKey, nowIso(), trackId);
}

export type TagLikeFields = {
  album?: string | null;
  label?: string | null;
  releaseDate?: string | null;
  isrc?: string | null;
  recordingMbid?: string | null;
  genres?: string[];
  artistCanonical?: string | null;
  bpm?: number | null;
};

/** Shared writer for tag and published provenance: applies the same
 * field-source rules, source bookkeeping, genre replacement, and identity
 * refresh for both routes. */
export function writeTagLikeFields(
  db: SqliteDatabase,
  trackId: string,
  source: "tag" | "published",
  fields: TagLikeFields,
  options: { missingRow: "skip" | "throw" } = { missingRow: "skip" },
): void {
  const row = db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId) as TrackRow | undefined;
  if (!row) {
    if (options.missingRow === "throw") {
      throw new DomainError("TRACK_NOT_FOUND", `No track with id ${trackId}`);
    }
    return;
  }
  const sources = parseFieldSources(row.field_sources_json);
  const assignments: string[] = [];
  const values: unknown[] = [];
  const setIf = (
    column: string,
    field: string,
    value: string | number | null | undefined,
  ): void => {
    if (value == null || value === "") {
      return;
    }
    if (!canWriteField(sources, field, source)) {
      return;
    }
    assignments.push(`${column} = ?`);
    values.push(value);
    sources[field] = source;
  };
  setIf("album", "album", fields.album);
  setIf("label", "label", fields.label);
  setIf("release_date", "releaseDate", fields.releaseDate);
  setIf("isrc", "isrc", fields.isrc);
  setIf("recording_mbid", "recordingMbid", fields.recordingMbid);
  if (fields.artistCanonical && canWriteField(sources, "artistCanonical", source)) {
    assignments.push("artist_canonical = ?");
    values.push(fields.artistCanonical);
    sources.artistCanonical = source;
  }
  if (
    fields.bpm != null &&
    source === "published" &&
    row.bpm_source !== "manual" &&
    row.bpm_source !== "published"
  ) {
    assignments.push("bpm = ?", "bpm_source = ?");
    values.push(fields.bpm, "published");
  }
  if (assignments.length > 0) {
    assignments.push("field_sources_json = ?", "updated_at = ?");
    values.push(JSON.stringify(sources), nowIso(), trackId);
    db.prepare(`UPDATE tracks SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  }
  if ((fields.genres?.length ?? 0) > 0 && canWriteField(sources, "genres", source)) {
    replaceGenres(db, trackId, fields.genres ?? [], source);
    sources.genres = source;
    writeFieldSources(db, trackId, sources);
  }
  refreshRecordingIdentity(db, trackId);
}
