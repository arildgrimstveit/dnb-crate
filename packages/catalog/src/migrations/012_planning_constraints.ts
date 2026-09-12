import type { SqliteDatabase } from "../db.ts";
import type { Migration } from "../migrate.ts";

export const migration012PlanningConstraints: Migration = {
  id: 12,
  name: "012_planning_constraints",
  up(db: SqliteDatabase) {
    db.exec(`
      ALTER TABLE set_plans ADD COLUMN quality_policy TEXT;
      ALTER TABLE set_plans ADD COLUMN planning_constraints_json TEXT;
    `);
  },
};
