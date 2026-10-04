import type { Migration } from "../migrate.ts";

/** Analyzer 3.5.0 renamed the stored descriptor keys `shortTermLufsMean/Max`
 * to `shortTermRmsDbfsMean/Max` — the values were always short-term RMS dBFS,
 * never K-weighted LUFS. Rows are renamed in place so pre-re-analysis reads
 * keep working; the version bump separately marks them stale. */
export const migration020DescriptorKeysRenamed: Migration = {
  id: 20,
  name: "descriptor_keys_renamed",
  up(db) {
    const rows = db
      .prepare(
        "SELECT track_id, analyzer_name, descriptors_json FROM track_analyses WHERE descriptors_json IS NOT NULL",
      )
      .all() as Array<{ track_id: string; analyzer_name: string; descriptors_json: string }>;
    const update = db.prepare(
      "UPDATE track_analyses SET descriptors_json = ? WHERE track_id = ? AND analyzer_name = ?",
    );
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.descriptors_json) as Record<string, unknown>;
        const renamed =
          "shortTermLufsMean" in parsed || "shortTermLufsMax" in parsed ? { ...parsed } : null;
        if (!renamed) continue;
        if ("shortTermLufsMean" in renamed) {
          renamed.shortTermRmsDbfsMean = renamed.shortTermLufsMean;
          delete renamed.shortTermLufsMean;
        }
        if ("shortTermLufsMax" in renamed) {
          renamed.shortTermRmsDbfsMax = renamed.shortTermLufsMax;
          delete renamed.shortTermLufsMax;
        }
        update.run(JSON.stringify(renamed), row.track_id, row.analyzer_name);
      } catch {
        // Unreadable descriptors JSON is left untouched; the row is stale
        // under 3.5.0 and will be replaced by re-analysis.
      }
    }
  },
};
