import type { SqliteDatabase } from "../db.ts";
import type { Migration } from "../migrate.ts";

export const migration004Analysis: Migration = {
  id: 4,
  name: "004_analysis",
  up(db: SqliteDatabase) {
    db.exec(`
      CREATE TABLE track_analyses (
        track_id TEXT PRIMARY KEY REFERENCES tracks (id) ON DELETE CASCADE,
        analyzer_name TEXT NOT NULL,
        analyzer_version TEXT NOT NULL,
        bpm REAL,
        bpm_confidence REAL,
        bpm_raw REAL,
        beat_times_json TEXT NOT NULL DEFAULT '[]',
        downbeat_times_json TEXT NOT NULL DEFAULT '[]',
        grid_rejected INTEGER NOT NULL DEFAULT 0 CHECK (grid_rejected IN (0, 1)),
        grid_rejection_reason TEXT,
        musical_key TEXT,
        key_confidence REAL,
        integrated_lufs REAL,
        true_peak_db REAL,
        low_band_energy REAL,
        mid_band_energy REAL,
        high_band_energy REAL,
        waveform_summary_json TEXT,
        beat_anchor_ms REAL,
        suggested_cues_json TEXT NOT NULL DEFAULT '[]',
        analyzed_at TEXT NOT NULL
      );

      CREATE TABLE beat_anchors (
        track_id TEXT PRIMARY KEY REFERENCES tracks (id) ON DELETE CASCADE,
        position_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE analysis_jobs (
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
        completed_at TEXT
      );

      CREATE INDEX analysis_jobs_status ON analysis_jobs (status, created_at);
    `);
  },
};
