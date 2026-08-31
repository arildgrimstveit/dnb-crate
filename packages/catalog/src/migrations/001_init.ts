import type { SqliteDatabase } from "../db.ts";
import type { Migration } from "../migrate.ts";

export const migration001Init: Migration = {
  id: 1,
  name: "001_init",
  up(db: SqliteDatabase) {
    db.exec(`
      CREATE TABLE tracks (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL UNIQUE,
        file_fingerprint TEXT NOT NULL,
        artist TEXT,
        title TEXT NOT NULL,
        album TEXT,
        duration_ms INTEGER NOT NULL,
        sample_rate_hz INTEGER,
        channels INTEGER,
        bpm REAL,
        bpm_source TEXT CHECK (bpm_source IN ('tag', 'manual', 'analyzed') OR bpm_source IS NULL),
        musical_key TEXT,
        camelot_key TEXT,
        key_source TEXT CHECK (key_source IN ('tag', 'manual', 'analyzed') OR key_source IS NULL),
        energy INTEGER CHECK (energy IS NULL OR (energy BETWEEN 1 AND 10)),
        rating INTEGER CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
        notes TEXT,
        analysis_status TEXT NOT NULL DEFAULT 'not_analyzed'
          CHECK (analysis_status IN ('not_analyzed', 'pending', 'complete', 'failed')),
        file_missing INTEGER NOT NULL DEFAULT 0 CHECK (file_missing IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX tracks_fingerprint ON tracks (file_fingerprint);
      CREATE INDEX tracks_artist ON tracks (artist);
      CREATE INDEX tracks_title ON tracks (title);
      CREATE INDEX tracks_bpm ON tracks (bpm);
      CREATE INDEX tracks_updated_at ON tracks (updated_at);

      CREATE TABLE track_moods (
        track_id TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        mood TEXT NOT NULL,
        PRIMARY KEY (track_id, mood)
      );

      CREATE TABLE track_subgenres (
        track_id TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        subgenre TEXT NOT NULL,
        PRIMARY KEY (track_id, subgenre)
      );

      CREATE TABLE track_tags (
        track_id TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (track_id, tag)
      );
    `);
  },
};
