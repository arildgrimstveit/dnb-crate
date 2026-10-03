import type {
  CuePoint,
  CuePointType,
  LibraryStats,
  PublicTrack,
  SearchTracksInput,
  SearchTracksResult,
  Track,
  TrackMetadataPatch,
} from "@dnb-crate/domain";
import {
  DomainError,
  MIN_KEY_CONFIDENCE,
  normalizeKey,
  normalizePersonName,
  toPublicTrack,
  yearFromDate,
} from "@dnb-crate/domain";

import type { SqliteDatabase } from "./db.ts";
import { nowIso } from "./now-iso.ts";
import {
  parseFieldSources,
  recordingKeyOfRow,
  refreshRecordingIdentity,
  replaceGenres,
  writeTagLikeFields,
} from "./provenance.ts";
import { tableExists } from "./repository-stats.ts";
import { buildLibraryStats } from "./repository-stats.ts";
import { searchTracks } from "./repository-search.ts";

export type TrackRow = {
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
export class TrackRepository {
  constructor(private readonly db: SqliteDatabase) {}

  withTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  findById(id: string): Track | null {
    const row = this.db.prepare("SELECT * FROM tracks WHERE id = ?").get(id) as
      TrackRow | undefined;
    return row ? this.hydrateRows([row])[0]! : null;
  }

  findByFilePath(filePath: string): Track | null {
    const row = this.db.prepare("SELECT * FROM tracks WHERE file_path = ?").get(filePath) as
      TrackRow | undefined;
    return row ? this.hydrateRows([row])[0]! : null;
  }

  findByFingerprint(fingerprint: string): Track[] {
    const rows = this.db
      .prepare("SELECT * FROM tracks WHERE file_fingerprint = ?")
      .all(fingerprint) as TrackRow[];
    return this.hydrateRows(rows);
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
    return this.hydrateRows(rows);
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
    input: {
      bpm: number | null;
      musicalKey: string | null;
      keyConfidence?: number | null;
      gridRejected?: boolean;
      preserveKey?: boolean;
    },
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
    const canWriteBpm =
      existing.bpmSource !== "manual" &&
      existing.bpmSource !== "published" &&
      input.bpm !== null &&
      input.gridRejected !== true;
    if (canWriteBpm) {
      bpm = input.bpm;
      bpmSource = "analyzed";
    }
    const gatedKey =
      input.musicalKey !== null && (input.keyConfidence ?? 0) >= MIN_KEY_CONFIDENCE
        ? input.musicalKey
        : null;
    if (
      !input.preserveKey &&
      existing.keySource !== "manual" &&
      existing.keySource !== "published"
    ) {
      if (gatedKey) {
        const normalized = normalizeKey(gatedKey);
        musicalKey = normalized?.musicalKey ?? gatedKey;
        camelotKey = normalized?.camelotKey ?? null;
        keySource = "analyzed";
      } else if (existing.keySource === "analyzed") {
        musicalKey = null;
        camelotKey = null;
        keySource = null;
      }
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
    return this.hydrateRows(rows).map(toPublicTrack);
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
      bpmSource = patch.bpm === null ? null : (patch.bpmSource ?? "manual");
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
    const label = patch.label === undefined ? (existing.label ?? null) : patch.label;
    const releaseDate =
      patch.releaseDate === undefined ? (existing.releaseDate ?? null) : patch.releaseDate;
    const isrc = patch.isrc === undefined ? (existing.isrc ?? null) : patch.isrc;
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
        replaceGenres(this.db, id, patch.genres, "manual");
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
    return searchTracks(this.db, (rows) => this.hydrateRows(rows), input);
  }
  stats(): LibraryStats {
    return buildLibraryStats(this.db);
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
    writeTagLikeFields(this.db, id, "tag", input);
  }

  refreshRecordingIdentity(trackId: string): void {
    refreshRecordingIdentity(this.db, trackId);
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
    writeTagLikeFields(this.db, trackId, "published", patch, { missingRow: "throw" });
  }
  private updateScanFields(id: string, input: UpsertTrackInput): Track {
    const existing = this.findById(id);
    const keepBpm =
      existing?.bpmSource === "manual" ||
      (existing?.bpmSource === "analyzed" && existing.fileFingerprint === input.fileFingerprint) ||
      existing?.bpmSource === "published";
    const keepKey =
      existing?.keySource === "manual" ||
      (existing?.keySource === "analyzed" && existing.fileFingerprint === input.fileFingerprint) ||
      existing?.keySource === "published";
    if (existing && existing.fileFingerprint !== input.fileFingerprint) {
      this.setAnalysisStatus(id, "pending");
      for (const stage of ["dsp", "key"]) {
        this.db
          .prepare(
            "UPDATE analysis_stages SET state='pending', reason='Source fingerprint changed' WHERE track_id=? AND stage=?",
          )
          .run(id, stage);
      }
    }
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

  /** Fetch each metadata relation once for a result set, rather than once per track. */
  private hydrateRows(rows: TrackRow[]): Track[] {
    if (rows.length === 0) return [];
    const ids = JSON.stringify(rows.map((row) => row.id));
    const relations = [
      ["moods", "track_moods", "mood"],
      ["subgenres", "track_subgenres", "subgenre"],
      ["tags", "track_tags", "tag"],
      ["genres", "track_genres", "genre"],
    ] as const;
    const values = new Map<
      string,
      Required<Pick<Track, "moods" | "subgenres" | "tags" | "genres">>
    >();
    for (const row of rows) values.set(row.id, { moods: [], subgenres: [], tags: [], genres: [] });
    for (const [field, table, column] of relations) {
      if (field === "genres" && !tableExists(this.db, table)) continue;
      // JSON supplies one bound parameter even for libraries beyond SQLite's variable limit.
      // Table and column identifiers come only from the fixed relation list above.
      const items = this.db
        .prepare(
          `SELECT track_id, ${column} AS value FROM ${table}
         WHERE track_id IN (SELECT value FROM json_each(?)) ORDER BY ${column}`,
        )
        .all(ids) as { track_id: string; value: string }[];
      for (const item of items) values.get(item.track_id)![field].push(item.value);
    }
    return rows.map((row) => this.hydrate(row, values.get(row.id)!));
  }

  private hydrate(
    row: TrackRow,
    relations: Required<Pick<Track, "moods" | "subgenres" | "tags" | "genres">>,
  ): Track {
    const fieldSources = parseFieldSources(row.field_sources_json);
    const artistCanonical =
      row.artist_canonical ?? (row.artist ? normalizePersonName(row.artist) : null);
    const recordingKey = row.recording_key ?? recordingKeyOfRow(row, artistCanonical);

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
      subgenres: relations.subgenres,
      moods: relations.moods,
      tags: relations.tags,
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
      genres: relations.genres,
      fieldSources,
    };
  }
}
