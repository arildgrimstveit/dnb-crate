import type { SqliteDatabase } from "../db.ts";
import type { Migration } from "../migrate.ts";

export const migration005AnalysisV2: Migration = {
  id: 5,
  name: "005_analysis_v2",
  up(db: SqliteDatabase) {
    db.exec(`
      CREATE TABLE track_analyses_v2 (
        track_id TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
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
        key_mode TEXT CHECK (key_mode IS NULL OR key_mode IN ('major', 'minor')),
        camelot_key TEXT,
        tempo_stability REAL,
        downbeat_confidence REAL,
        integrated_lufs REAL,
        true_peak_db REAL,
        low_band_energy REAL,
        mid_band_energy REAL,
        high_band_energy REAL,
        waveform_summary_json TEXT,
        beat_anchor_ms REAL,
        suggested_cues_json TEXT NOT NULL DEFAULT '[]',
        descriptors_json TEXT,
        engine_runtime_ms REAL,
        analyzed_at TEXT NOT NULL,
        PRIMARY KEY (track_id, analyzer_name)
      );

      INSERT INTO track_analyses_v2 (
        track_id, analyzer_name, analyzer_version, bpm, bpm_confidence, bpm_raw,
        beat_times_json, downbeat_times_json, grid_rejected, grid_rejection_reason,
        musical_key, key_confidence, key_mode, camelot_key, tempo_stability, downbeat_confidence,
        integrated_lufs, true_peak_db, low_band_energy, mid_band_energy, high_band_energy,
        waveform_summary_json, beat_anchor_ms, suggested_cues_json, descriptors_json,
        engine_runtime_ms, analyzed_at
      )
      SELECT
        track_id, analyzer_name, analyzer_version, bpm, bpm_confidence, bpm_raw,
        beat_times_json, downbeat_times_json, grid_rejected, grid_rejection_reason,
        musical_key, key_confidence, NULL, NULL, NULL, NULL,
        integrated_lufs, true_peak_db, low_band_energy, mid_band_energy, high_band_energy,
        waveform_summary_json, beat_anchor_ms, suggested_cues_json, NULL,
        NULL, analyzed_at
      FROM track_analyses;

      DROP TABLE track_analyses;
      ALTER TABLE track_analyses_v2 RENAME TO track_analyses;
      CREATE INDEX track_analyses_track ON track_analyses (track_id);

      CREATE TABLE track_sections (
        id TEXT PRIMARY KEY,
        track_id TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        analyzer_name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('intro', 'build', 'drop', 'breakdown', 'bridge', 'outro')),
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        start_bar INTEGER,
        end_bar INTEGER,
        confidence REAL NOT NULL,
        energy REAL NOT NULL
      );
      CREATE INDEX track_sections_track_engine ON track_sections (track_id, analyzer_name);

      ALTER TABLE analysis_jobs ADD COLUMN engines_json TEXT NOT NULL DEFAULT '["dnb-crate-dsp"]';
    `);
  },
};
