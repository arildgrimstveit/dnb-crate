import type { SqliteDatabase } from "../db.ts";
import type { Migration } from "../migrate.ts";

export const migration011ApprovedRecipes: Migration = {
  id: 11,
  name: "011_approved_recipes",
  up(db: SqliteDatabase) {
    db.exec(`
      ALTER TABLE set_plans ADD COLUMN rate_regions_version INTEGER;
      ALTER TABLE set_plans ADD COLUMN handoff_policy TEXT;

      CREATE TABLE IF NOT EXISTS approved_recipes (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        pair_key TEXT NOT NULL,
        reusable_fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        heard_render_fingerprint TEXT,
        render_job_id TEXT,
        transition_id TEXT,
        set_plan_id TEXT,
        outgoing_track_id TEXT NOT NULL,
        incoming_track_id TEXT NOT NULL,
        outgoing_title TEXT,
        incoming_title TEXT,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS approved_recipes_pair ON approved_recipes (pair_key, created_at);
      CREATE INDEX IF NOT EXISTS approved_recipes_fingerprint
        ON approved_recipes (reusable_fingerprint, status);
    `);
  },
};
