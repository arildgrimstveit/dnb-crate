import type { Migration } from "../migrate.ts";

export const migration026StageContentIdentity: Migration = {
  id: 26,
  name: "stage_content_identity",
  up(db) {
    // Q02 (12 October roadmap): the fast fingerprint (size + head/tail
    // 64 KiB) cannot see middle-byte edits, so stale analysis could stay
    // "current". DSP stages now carry a strong content identity - the
    // full-file SHA-256 observed at analysis time - plus the stat
    // (size, whole-ms mtime) observed with it, enabling a stat-assisted
    // freshness fast path that re-hashes on stat drift. Legacy rows keep
    // NULL here and remain on the weak fingerprint contract until their
    // next analysis upgrades them.
    // Idempotent guard like 018/022/023/024/025.
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('analysis_stages')")
      .all()
      .map((row) => String((row as { name: string }).name));
    if (columns.includes("content_hash")) return;
    db.exec("ALTER TABLE analysis_stages ADD COLUMN content_hash TEXT");
    db.exec("ALTER TABLE analysis_stages ADD COLUMN content_size INTEGER");
    db.exec("ALTER TABLE analysis_stages ADD COLUMN content_mtime_ms INTEGER");
  },
};
