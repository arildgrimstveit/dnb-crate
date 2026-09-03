import type { SqliteDatabase } from "../db.ts";
import type { Migration } from "../migrate.ts";

export const migration008CrateV3: Migration = {
  id: 8,
  name: "008_crate_v3",
  up(db: SqliteDatabase) {
    db.exec(`
      ALTER TABLE track_analyses ADD COLUMN reference_bpm REAL;

      ALTER TABLE tracks ADD COLUMN label TEXT;
      ALTER TABLE tracks ADD COLUMN release_date TEXT;
      ALTER TABLE tracks ADD COLUMN isrc TEXT;
      ALTER TABLE tracks ADD COLUMN recording_mbid TEXT;
      ALTER TABLE tracks ADD COLUMN artist_canonical TEXT;
      ALTER TABLE tracks ADD COLUMN recording_key TEXT;
      ALTER TABLE tracks ADD COLUMN field_sources_json TEXT;

      CREATE TABLE IF NOT EXISTS track_genres (
        track_id TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        genre TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('tag', 'published', 'manual')),
        PRIMARY KEY (track_id, genre)
      );

      CREATE TABLE IF NOT EXISTS track_enrichment (
        track_id TEXT PRIMARY KEY REFERENCES tracks (id) ON DELETE CASCADE,
        release_mbid TEXT,
        release_group_mbid TEXT,
        artist_mbids_json TEXT,
        catalog_number TEXT,
        original_date TEXT,
        deezer_track_id TEXT,
        deezer_bpm REAL,
        deezer_gain REAL,
        acoustid_id TEXT,
        match_method TEXT CHECK (match_method IN ('file-tags', 'isrc', 'acoustid', 'search')),
        match_score REAL,
        matched_at TEXT,
        raw_json TEXT
      );

      CREATE TABLE IF NOT EXISTS enrichment_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        progress REAL NOT NULL DEFAULT 0,
        track_ids_json TEXT NOT NULL,
        completed_ids_json TEXT NOT NULL DEFAULT '[]',
        failed_ids_json TEXT NOT NULL DEFAULT '[]',
        error_code TEXT,
        error_message TEXT,
        retryable INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        progress_message TEXT,
        dry_run INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS enrichment_jobs_status ON enrichment_jobs (status, created_at);
    `);
  },
};
