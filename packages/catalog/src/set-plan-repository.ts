import type { PlanExplanation, SetPlanEntry, SetPlanSummary, SetPlanV1 } from "@dnb-crate/domain";
import {
  DomainError,
  SET_PLAN_LIST_LIMIT_MAX,
  VARIETY_AUTO_HISTORY_SCAN,
  planExplanationSchema,
  planningConstraintsSchema,
  setPlanEntrySchema,
} from "@dnb-crate/domain";

import type { SqliteDatabase } from "./db.ts";
import { nowIso } from "./now-iso.ts";
import { decodeCursor, encodeCursor } from "./pagination.ts";

type PlanRow = {
  id: string;
  schema_version: number;
  name: string;
  target_duration_ms: number;
  target_bpm: number | null;
  requested_arc_json: string;
  seed: number;
  explanation_json: string;
  created_at: string;
  updated_at: string;
  rate_regions_version: number | null;
  handoff_policy: string | null;
  quality_policy: string | null;
  planning_constraints_json: string | null;
};

type EntryRow = {
  id: string;
  set_plan_id: string;
  track_id: string;
  order_index: number;
  source_start_ms: number;
  source_end_ms: number;
  timeline_start_ms: number;
  playback_rate: number;
  gain_db: number;
  transition_json: string | null;
};

export type StoredSetPlan = {
  plan: SetPlanV1;
  seed: number;
  explanation: PlanExplanation;
};

/** Minimal structural type of a zod schema so this package does not need a
 * direct zod dependency just to validate stored JSON. */
type SafeParseValidator = {
  safeParse: (data: unknown) => {
    success: boolean;
    error?: { issues?: Array<{ path: PropertyKey[]; message: string }> };
  };
};

function parseStoredJson<T>(
  json: string | null,
  label: string,
  planId: string,
  schema?: SafeParseValidator,
): T | null {
  if (json === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new DomainError(
      "INVALID_SET_PLAN",
      `Stored plan ${planId} has an unreadable ${label} (corrupt JSON; ` +
        `the plan row is intact otherwise — re-save or clone the plan to rewrite it)`,
      { details: { planId, field: label } },
    );
  }
  if (schema) {
    const checked = schema.safeParse(parsed);
    if (!checked.success) {
      // Fail closed, but say WHICH stored shape failed and how to recover:
      // legacy rows written before a schema change land here (review item 2
      // — a raw "invalid" gave no remediation path).
      const issue = checked.error?.issues?.[0];
      const where = issue ? ` at ${issue.path.join(".")}` : "";
      throw new DomainError(
        "INVALID_SET_PLAN",
        `Stored plan ${planId} has an invalid ${label}${where}: it predates the current ` +
          `persisted schema or was written by another version. ` +
          `Re-create the plan (clone with replan) to rewrite it with the current shape.`,
        {
          details: {
            planId,
            field: label,
            issues: checked.error?.issues?.slice(0, 5).map((row) => ({
              path: row.path,
              message: row.message,
            })),
          },
        },
      );
    }
  }
  return parsed as T;
}
export class SetPlanRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(plan: SetPlanV1, seed: number, explanation: PlanExplanation): StoredSetPlan {
    const timestamp = nowIso();
    const createdAt = this.findRow(plan.id)?.created_at ?? plan.createdAt;
    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM set_plan_entries WHERE set_plan_id = ?").run(plan.id);
      this.db
        .prepare(
          `INSERT INTO set_plans (
            id, schema_version, name, target_duration_ms, target_bpm, requested_arc_json,
            seed, explanation_json, created_at, updated_at, rate_regions_version, handoff_policy,
            quality_policy, planning_constraints_json
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            target_duration_ms = excluded.target_duration_ms,
            target_bpm = excluded.target_bpm,
            requested_arc_json = excluded.requested_arc_json,
            seed = excluded.seed,
            explanation_json = excluded.explanation_json,
            updated_at = excluded.updated_at,
            rate_regions_version = excluded.rate_regions_version,
            handoff_policy = excluded.handoff_policy,
            quality_policy = excluded.quality_policy,
            planning_constraints_json = excluded.planning_constraints_json`,
        )
        .run(
          plan.id,
          plan.name,
          plan.targetDurationMs,
          plan.targetBpm,
          JSON.stringify(plan.requestedArc),
          seed,
          JSON.stringify(explanation),
          createdAt,
          timestamp,
          plan.rateRegionsVersion ?? null,
          plan.handoffPolicy ?? null,
          plan.qualityPolicy ?? null,
          plan.planningConstraints ? JSON.stringify(plan.planningConstraints) : null,
        );
      const stmt = this.db.prepare(
        `INSERT INTO set_plan_entries (
          id, set_plan_id, track_id, order_index, source_start_ms, source_end_ms,
          timeline_start_ms, playback_rate, gain_db, transition_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of plan.entries) {
        stmt.run(
          entry.id,
          plan.id,
          entry.trackId,
          entry.order,
          entry.sourceStartMs,
          entry.sourceEndMs,
          entry.timelineStartMs,
          entry.playbackRate,
          entry.gainDb,
          entry.transitionToNext === null ? null : JSON.stringify(entry.transitionToNext),
        );
      }
    });
    run();
    const stored = this.findById(plan.id);
    if (!stored) {
      throw new DomainError("INVALID_SET_PLAN", "Failed to read set plan after save");
    }
    return stored;
  }

  findById(id: string): StoredSetPlan | null {
    const row = this.findRow(id);
    if (!row) {
      return null;
    }
    const entries = this.db
      .prepare("SELECT * FROM set_plan_entries WHERE set_plan_id = ? ORDER BY order_index ASC")
      .all(id) as EntryRow[];
    return {
      seed: row.seed,
      explanation: parseStoredJson<PlanExplanation>(
        row.explanation_json,
        "explanation",
        row.id,
        planExplanationSchema,
      )!,
      plan: {
        schemaVersion: 1,
        id: row.id,
        name: row.name,
        targetDurationMs: row.target_duration_ms,
        targetBpm: row.target_bpm,
        requestedArc: JSON.parse(row.requested_arc_json) as SetPlanV1["requestedArc"],
        entries: entries.map(mapEntry),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        rateRegionsVersion:
          row.rate_regions_version === 2 || row.rate_regions_version === 1
            ? row.rate_regions_version
            : undefined,
        handoffPolicy: row.handoff_policy === "dj-continuity-v1" ? "dj-continuity-v1" : undefined,
        qualityPolicy:
          row.quality_policy === "strict" || row.quality_policy === "off"
            ? row.quality_policy
            : undefined,
        planningConstraints:
          parseStoredJson<SetPlanV1["planningConstraints"]>(
            row.planning_constraints_json,
            "planning constraints",
            row.id,
            planningConstraintsSchema,
          ) ?? undefined,
      },
    };
  }

  list(limitRaw?: number, cursor?: string): { plans: SetPlanSummary[]; nextCursor: string | null } {
    const limit = Math.min(limitRaw ?? 20, SET_PLAN_LIST_LIMIT_MAX);
    const params: unknown[] = [];
    let where = "";
    if (cursor) {
      const decoded = decodeCursor(cursor);
      where = "WHERE (updated_at < ? OR (updated_at = ? AND id < ?))";
      params.push(decoded.value, decoded.value, decoded.id);
    }
    const rows = this.db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM set_plan_entries e WHERE e.set_plan_id = p.id) AS entry_count
         FROM set_plans p ${where}
         ORDER BY p.updated_at DESC, p.id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as Array<PlanRow & { entry_count: number }>;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      plans: page.map((row) => ({
        id: row.id,
        name: row.name,
        targetDurationMs: row.target_duration_ms,
        entryCount: row.entry_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({
              sort: "updatedAt",
              direction: "desc",
              value: last.updated_at,
              id: last.id,
            })
          : null,
    };
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM set_plans WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** R7: the automatic variety history pages by ELIGIBILITY in SQL — the
   * entry-count filter runs inside the query, so a run of short drafts can
   * never hide older qualifying plans the way a raw page + filter did. */
  listEligibleForHistory(minEntryCount: number, limitRaw?: number): SetPlanSummary[] {
    const limit = Math.min(limitRaw ?? VARIETY_AUTO_HISTORY_SCAN, SET_PLAN_LIST_LIMIT_MAX);
    const rows = this.db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM set_plan_entries e WHERE e.set_plan_id = p.id) AS entry_count
         FROM set_plans p
         WHERE (SELECT COUNT(*) FROM set_plan_entries e WHERE e.set_plan_id = p.id) >= ?
         ORDER BY p.updated_at DESC, p.id DESC LIMIT ?`,
      )
      .all(minEntryCount, limit) as Array<PlanRow & { entry_count: number }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      targetDurationMs: row.target_duration_ms,
      entryCount: row.entry_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  private findRow(id: string): PlanRow | undefined {
    return this.db.prepare("SELECT * FROM set_plans WHERE id = ?").get(id) as PlanRow | undefined;
  }
}

function mapEntry(row: EntryRow): SetPlanEntry {
  const entry: SetPlanEntry = {
    id: row.id,
    trackId: row.track_id,
    order: row.order_index,
    sourceStartMs: row.source_start_ms,
    sourceEndMs: row.source_end_ms,
    timelineStartMs: row.timeline_start_ms,
    playbackRate: row.playback_rate,
    gainDb: row.gain_db,
    transitionToNext: parseStoredJson<SetPlanEntry["transitionToNext"]>(
      row.transition_json,
      "transition",
      row.set_plan_id,
    ),
  };
  if (!setPlanEntrySchema.safeParse(entry).success) {
    throw new DomainError(
      "INVALID_SET_PLAN",
      `Stored plan ${row.set_plan_id} has an invalid entry ${row.id}`,
    );
  }
  return entry;
}
