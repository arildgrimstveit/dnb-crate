import type { Migration } from "../migrate.ts";

export const migration023JobClaimFencingAll: Migration = {
  id: 23,
  name: "job_claim_fencing_all",
  up(db) {
    // R12 follow-up: the same claim fencing migration 022 added to
    // render_jobs, for analysis and enrichment jobs. Idempotent guards so a
    // catalog that already carries a column must not fail.
    const analysisColumns = db
      .prepare("SELECT name FROM pragma_table_info('analysis_jobs')")
      .all()
      .map((row) => String((row as { name: string }).name));
    if (!analysisColumns.includes("claimed_by")) {
      db.exec("ALTER TABLE analysis_jobs ADD COLUMN claimed_by TEXT");
    }
    const enrichmentColumns = db
      .prepare("SELECT name FROM pragma_table_info('enrichment_jobs')")
      .all()
      .map((row) => String((row as { name: string }).name));
    if (!enrichmentColumns.includes("claimed_by")) {
      db.exec("ALTER TABLE enrichment_jobs ADD COLUMN claimed_by TEXT");
    }
  },
};
