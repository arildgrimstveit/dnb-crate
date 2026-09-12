import type { Migration } from "../migrate.ts";
export const migration013HourFeedback: Migration = {
  id: 13,
  name: "013_hour_feedback",
  up(db) {
    db.exec(`CREATE TABLE hour_feedback (
      id TEXT PRIMARY KEY, render_job_id TEXT NOT NULL, output_checksum TEXT NOT NULL,
      set_plan_id TEXT NOT NULL, plan_content_hash TEXT NOT NULL,
      accepted INTEGER NOT NULL, quote TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(render_job_id, output_checksum, accepted, quote)
    ); CREATE INDEX hour_feedback_render ON hour_feedback(render_job_id, created_at);`);
  },
};
