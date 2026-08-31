import type { SqliteDatabase } from "../db.ts";
import type { Migration } from "../migrate.ts";

export const migration003Renders: Migration = {
  id: 3,
  name: "003_renders",
  up(db: SqliteDatabase) {
    db.exec(`
      CREATE TABLE render_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('preview', 'full')),
        set_plan_id TEXT NOT NULL REFERENCES set_plans (id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        progress REAL NOT NULL DEFAULT 0,
        output_format TEXT NOT NULL DEFAULT 'wav',
        output_relpath TEXT,
        output_checksum TEXT,
        transition_id TEXT,
        cache_key TEXT,
        params_json TEXT,
        error_code TEXT,
        error_message TEXT,
        retryable INTEGER NOT NULL DEFAULT 0,
        manifest_json TEXT,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        progress_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX render_jobs_status ON render_jobs (status, created_at);
      CREATE INDEX render_jobs_plan ON render_jobs (set_plan_id, created_at);
      CREATE INDEX render_jobs_cache ON render_jobs (cache_key);
    `);
  },
};
