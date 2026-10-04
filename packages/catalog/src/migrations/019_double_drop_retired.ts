import type { Migration } from "../migrate.ts";

/** The reserved `double_drop` transition type is retired. Rows that carry it
 * (hand-made in early sessions; nothing in current code creates them) are
 * rewritten to `phrase_mix` so reads keep working under the narrowed schema.
 * Both rewrites are JSON-aware, not string replaces. */
export const migration019DoubleDropRetired: Migration = {
  id: 19,
  name: "double_drop_retired",
  up(db) {
    const entries = db
      .prepare(
        "SELECT set_plan_id, id, transition_json FROM set_plan_entries WHERE transition_json IS NOT NULL",
      )
      .all() as Array<{ set_plan_id: string; id: string; transition_json: string }>;
    const updateEntry = db.prepare(
      "UPDATE set_plan_entries SET transition_json = ? WHERE set_plan_id = ? AND id = ?",
    );
    for (const row of entries) {
      try {
        const parsed = JSON.parse(row.transition_json) as { type?: unknown };
        if (parsed.type === "double_drop") {
          parsed.type = "phrase_mix";
          updateEntry.run(JSON.stringify(parsed), row.set_plan_id, row.id);
        }
      } catch {
        // Unreadable transition JSON is left untouched; reads fail closed
        // with the plan id (set-plan-repository validating parse).
      }
    }

    const recipes = db
      .prepare("SELECT id, payload_json FROM approved_recipes WHERE payload_json IS NOT NULL")
      .all() as Array<{ id: string; payload_json: string }>;
    const updateRecipe = db.prepare("UPDATE approved_recipes SET payload_json = ? WHERE id = ?");
    for (const row of recipes) {
      try {
        const parsed = JSON.parse(row.payload_json) as { type?: unknown };
        if (parsed.type === "double_drop") {
          parsed.type = "phrase_mix";
          updateRecipe.run(JSON.stringify(parsed), row.id);
        }
      } catch {
        // Same policy as entries: leave corrupt rows to fail closed on read.
      }
    }
  },
};
