import type { SqliteDatabase } from "../db.ts";
import type { Migration } from "../migrate.ts";

export const migration009SelectedEvidence: Migration = {
  id: 9,
  name: "009_selected_evidence",
  up(db: SqliteDatabase) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS track_evidence_selection (
        track_id TEXT PRIMARY KEY REFERENCES tracks (id) ON DELETE CASCADE,
        rhythm_engine TEXT,
        structure_engine TEXT,
        key_engine TEXT,
        selected_at TEXT NOT NULL,
        reason TEXT
      );
    `);
  },
};
