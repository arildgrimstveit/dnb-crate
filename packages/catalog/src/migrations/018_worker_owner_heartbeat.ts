import type { Migration } from "../migrate.ts";

export const migration018WorkerOwnerHeartbeat: Migration = {
  id: 18,
  name: "worker_owner_heartbeat",
  up(db) {
    // Idempotent guard: a catalog that already carries the column (for example
    // one whose schema_migrations bookkeeping was rolled back) must not fail.
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('worker_owner')")
      .all()
      .map((row) => String((row as { name: string }).name));
    if (columns.includes("heartbeat_at")) return;
    db.exec("ALTER TABLE worker_owner ADD COLUMN heartbeat_at TEXT");
  },
};
