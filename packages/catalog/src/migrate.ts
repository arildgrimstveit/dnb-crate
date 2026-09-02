import type { SqliteDatabase } from "./db.ts";
import { migration001Init } from "./migrations/001_init.ts";
import { migration002Planning } from "./migrations/002_planning.ts";
import { migration003Renders } from "./migrations/003_renders.ts";
import { migration004Analysis } from "./migrations/004_analysis.ts";
import { migration005AnalysisV2 } from "./migrations/005_analysis_v2.ts";
import { migration006PublishedProvenance } from "./migrations/006_published_provenance.ts";

export type Migration = {
  id: number;
  name: string;
  up: (db: SqliteDatabase) => void;
  foreignKeysOff?: boolean;
};

const MIGRATIONS: Migration[] = [
  migration001Init,
  migration002Planning,
  migration003Renders,
  migration004Analysis,
  migration005AnalysisV2,
  migration006PublishedProvenance,
];

export function runMigrations(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare("SELECT id FROM schema_migrations")
      .all()
      .map((row) => Number((row as { id: number }).id)),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) {
      continue;
    }
    if (migration.foreignKeysOff === true) {
      db.pragma("foreign_keys = OFF");
    }
    const run = db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
    });
    run();
    if (migration.foreignKeysOff === true) {
      db.pragma("foreign_keys = ON");
    }
  }
}
