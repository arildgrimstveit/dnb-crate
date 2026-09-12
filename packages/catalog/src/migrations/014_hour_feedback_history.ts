import type { Migration } from "../migrate.ts";

export const migration014HourFeedbackHistory: Migration = {
  id: 14,
  name: "014_hour_feedback_history",
  up(db) {
    // A repeated verdict after a reversal is a new event. Preserve insertion order.
    db.exec(`CREATE TABLE hour_feedback_history (
      id TEXT PRIMARY KEY, render_job_id TEXT NOT NULL, output_checksum TEXT NOT NULL,
      set_plan_id TEXT NOT NULL, plan_content_hash TEXT NOT NULL,
      accepted INTEGER NOT NULL, quote TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO hour_feedback_history SELECT * FROM hour_feedback ORDER BY rowid;
    DROP TABLE hour_feedback;
    ALTER TABLE hour_feedback_history RENAME TO hour_feedback;
    CREATE INDEX hour_feedback_render ON hour_feedback(render_job_id, created_at);`);
  },
};
