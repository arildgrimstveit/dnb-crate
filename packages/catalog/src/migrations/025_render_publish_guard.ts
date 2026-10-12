import type { Migration } from "../migrate.ts";

export const migration025RenderPublishGuard: Migration = {
  id: 25,
  name: "render_publish_guard",
  up(db) {
    // Q01 (12 October roadmap): publishUnderClaim previously held
    // BEGIN IMMEDIATE across the awaited filesystem publication on the
    // runtime's SHARED connection - any unrelated repository write that
    // landed during the await joined the open transaction and was
    // discarded by the publication rollback. Publication now runs outside
    // any transaction behind a row-level guard: writers that could depose
    // the publisher (cancel, restart recovery) must respect it.
    // Idempotent guard like 018/022/023/024.
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('render_jobs')")
      .all()
      .map((row) => String((row as { name: string }).name));
    if (columns.includes("publish_guard")) return;
    db.exec("ALTER TABLE render_jobs ADD COLUMN publish_guard TEXT");
    db.exec("ALTER TABLE render_jobs ADD COLUMN publish_guard_at TEXT");
  },
};
