import type { Migration } from "../migrate.ts";

export const migration028TrackLoudness: Migration = {
  id: 28,
  name: "track_loudness",
  up(db) {
    // Q04 (12 October roadmap): cached time-indexed loudness on the
    // ORIGINAL stereo signal - per-hop momentary/short-term LUFS with
    // silence kept as null, plus derived summary statistics and the
    // strong content hash observed at measurement time (Q02 identity
    // discipline: the row describes those bytes).
    db.exec(`
      CREATE TABLE IF NOT EXISTS track_loudness (
        track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
        hop_ms INTEGER NOT NULL,
        source_identity TEXT NOT NULL,
        short_term_json TEXT NOT NULL,
        momentary_json TEXT NOT NULL,
        coverage REAL NOT NULL,
        median_short_term_lufs REAL,
        p10_short_term_lufs REAL,
        p90_short_term_lufs REAL,
        integrated_lufs REAL,
        true_peak_db REAL,
        content_hash TEXT,
        measured_at TEXT NOT NULL
      )
    `);
  },
};
