import type { Migration } from "../migrate.ts";

export const migration015WorkerOwner: Migration = {
  id: 15,
  name: "worker_owner",
  up(db) {
    db.exec(`CREATE TABLE worker_owner (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token TEXT NOT NULL,
      pid INTEGER NOT NULL
    )`);
  },
};
