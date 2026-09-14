import type { Migration } from "../migrate.ts";
export const migration016AnalysisStages: Migration = {
  id: 16,
  name: "analysis_stages",
  up(db) {
    db.exec(`CREATE TABLE analysis_stages (
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK(stage IN ('dsp','key')),
    state TEXT NOT NULL CHECK(state IN ('pending','running','succeeded','failed','skipped')),
    fingerprint TEXT NOT NULL, identity TEXT NOT NULL, reason TEXT,
    analyzed_at TEXT NOT NULL, PRIMARY KEY(track_id, stage)
  );`);
  },
};
