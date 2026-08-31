import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { runMigrations } from "./migrate.ts";

export type SqliteDatabase = Database.Database;

export function openDatabase(databasePath: string): SqliteDatabase {
  if (databasePath !== ":memory:") {
    mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  runMigrations(db);
  return db;
}
