import type { Migration } from "../migrate.ts";

export const migration024EntryRateSource: Migration = {
  id: 24,
  name: "entry_rate_source",
  up(db) {
    // S3 (11 October review): distinguish intentional rate pins from derived
    // chain rates. "pinned" survives every rebuild verbatim; NULL means the
    // rate is chain-derived and re-derives when adjacency changes.
    // Idempotent guard like 018/022/023.
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('set_plan_entries')")
      .all()
      .map((row) => String((row as { name: string }).name));
    if (columns.includes("rate_source")) return;
    db.exec("ALTER TABLE set_plan_entries ADD COLUMN rate_source TEXT");
  },
};
