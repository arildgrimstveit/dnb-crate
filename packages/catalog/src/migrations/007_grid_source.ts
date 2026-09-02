import type { SqliteDatabase } from "../db.ts";
import type { Migration } from "../migrate.ts";

export const migration007GridSource: Migration = {
  id: 7,
  name: "007_grid_source",
  up(db: SqliteDatabase) {
    db.exec(`
      ALTER TABLE track_analyses ADD COLUMN grid_source TEXT;
      UPDATE track_analyses SET grid_source = 'analyzed' WHERE grid_source IS NULL;
    `);
  },
};
