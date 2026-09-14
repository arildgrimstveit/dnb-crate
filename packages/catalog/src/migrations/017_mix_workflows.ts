import type { Migration } from "../migrate.ts";
export const migration017MixWorkflows: Migration = {
  id: 17,
  name: "mix_workflows",
  up(db) {
    db.exec(`CREATE TABLE mix_workflows (
    id TEXT PRIMARY KEY, request_token TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL,
    status TEXT NOT NULL, data_json TEXT NOT NULL
  );`);
  },
};
