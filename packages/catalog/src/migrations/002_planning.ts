import type { SqliteDatabase } from "../db.ts";
import type { Migration } from "../migrate.ts";

export const migration002Planning: Migration = {
  id: 2,
  name: "002_planning",
  up(db: SqliteDatabase) {
    db.exec(`
      CREATE TABLE cue_points (
        id TEXT PRIMARY KEY,
        track_id TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        position_ms INTEGER NOT NULL,
        beat_index INTEGER,
        bar_index INTEGER,
        confidence REAL,
        source TEXT NOT NULL CHECK (source IN ('manual', 'analyzed', 'imported')),
        label TEXT
      );

      CREATE INDEX cue_points_track ON cue_points (track_id);

      CREATE TABLE set_plans (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        name TEXT NOT NULL,
        target_duration_ms INTEGER NOT NULL,
        target_bpm REAL,
        requested_arc_json TEXT NOT NULL,
        seed INTEGER NOT NULL,
        explanation_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE set_plan_entries (
        id TEXT PRIMARY KEY,
        set_plan_id TEXT NOT NULL REFERENCES set_plans (id) ON DELETE CASCADE,
        track_id TEXT NOT NULL REFERENCES tracks (id),
        order_index INTEGER NOT NULL,
        source_start_ms INTEGER NOT NULL,
        source_end_ms INTEGER NOT NULL,
        timeline_start_ms INTEGER NOT NULL,
        playback_rate REAL NOT NULL,
        gain_db REAL NOT NULL,
        transition_json TEXT,
        UNIQUE (set_plan_id, order_index)
      );

      CREATE INDEX set_plan_entries_plan ON set_plan_entries (set_plan_id, order_index);
    `);
  },
};
