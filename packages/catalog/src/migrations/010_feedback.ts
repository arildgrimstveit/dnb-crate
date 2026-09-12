import type { SqliteDatabase } from "../db.ts";
import type { Migration } from "../migrate.ts";

export const migration010Feedback: Migration = {
  id: 10,
  name: "010_feedback",
  up(db: SqliteDatabase) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS transition_feedback (
        id TEXT PRIMARY KEY,
        recipe_fingerprint TEXT NOT NULL,
        outgoing_track_id TEXT,
        incoming_track_id TEXT,
        set_plan_id TEXT,
        render_job_id TEXT,
        transition_id TEXT,
        renderer_version TEXT,
        overall TEXT NOT NULL,
        timing TEXT NOT NULL,
        phrasing TEXT NOT NULL,
        bass_clarity TEXT NOT NULL,
        harmonic_fit TEXT NOT NULL,
        energy_continuity TEXT NOT NULL,
        vocal_clash TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transition_feedback_fingerprint
        ON transition_feedback (recipe_fingerprint, created_at);
      CREATE INDEX IF NOT EXISTS transition_feedback_pair
        ON transition_feedback (outgoing_track_id, incoming_track_id, created_at);
    `);
  },
};
