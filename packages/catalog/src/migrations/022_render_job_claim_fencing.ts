import type { Migration } from "../migrate.ts";

export const migration022RenderJobClaimFencing: Migration = {
  id: 22,
  name: "render_job_claim_fencing",
  up(db) {
    // R12 (review 2026-10-10): completion writes must be fenced to the
    // owner token that claimed the job, so a deposed worker cannot
    // overwrite takeover recovery or the winner's published artifact.
    // Idempotent guard like 018: a catalog that already carries the column
    // must not fail.
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('render_jobs')")
      .all()
      .map((row) => String((row as { name: string }).name));
    if (columns.includes("claimed_by")) return;
    db.exec("ALTER TABLE render_jobs ADD COLUMN claimed_by TEXT");
  },
};
