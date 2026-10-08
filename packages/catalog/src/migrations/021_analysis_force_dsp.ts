import type { Migration } from "../migrate.ts";

/** Analysis jobs can request a forced DSP pass: explicitly named tracks and
 *  `scope: "all"` requests mean "recompute now", and must not be skipped by
 *  the freshness check (F9, repository review 2026-10-08). Existing rows
 *  default to 0 — freshness-gated like today. */
export const migration021AnalysisForceDsp: Migration = {
  id: 21,
  name: "analysis_force_dsp",
  up(db) {
    // Idempotent: catalog rewound past this migration (tests simulate prior
    // versions by deleting migration rows) may still carry the column.
    const columns = db.prepare("PRAGMA table_info(analysis_jobs)").all() as Array<{
      name: string;
    }>;
    if (columns.some((column) => column.name === "force_dsp")) {
      return;
    }
    db.exec(`ALTER TABLE analysis_jobs ADD COLUMN force_dsp INTEGER NOT NULL DEFAULT 0`);
  },
};
