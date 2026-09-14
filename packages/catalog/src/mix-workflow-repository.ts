import { createSetPlanInputSchema, DomainError, type CreateSetPlanInput } from "@dnb-crate/domain";

import type { SqliteDatabase } from "./db.ts";

import type { MixIssue } from "./preflight.ts";

export type MixWorkflow = {
  id: string;
  brief: CreateSetPlanInput;
  status: "queued" | "running" | "blocked" | "succeeded" | "failed" | "cancelled";
  stage: "preflight" | "scan" | "analysis" | "plan" | "validate" | "render" | "check";
  completedStages: string[];
  analysisJobIds: string[];
  planId: string | null;
  renderJobId: string | null;
  candidates: Record<string, string> | null;
  settingsIdentity: string;
  effectiveSettings: Record<string, string | number | boolean | null>;
  dependencies: Record<string, string | null>;
  renderJobIds: string[];
  progress: { completed: number; total: number } | null;
  issues: MixIssue[];
  createdAt: string;
  updatedAt: string;
  result: {
    verified: boolean;
    master: string | null;
    listen: string | null;
    trackCount: number;
    durationMs: number;
  } | null;
};

export class MixWorkflowRepository {
  constructor(readonly db: SqliteDatabase) {}

  start(
    input: { brief: CreateSetPlanInput; requestToken: string },
    settingsIdentity: string,
    effectiveSettings: MixWorkflow["effectiveSettings"] = {},
  ): MixWorkflow {
    const requestToken = input.requestToken.trim();
    if (!requestToken || requestToken.length > 200)
      throw new DomainError("CONFIG_INVALID", "requestToken must contain 1–200 characters.");

    const brief = createSetPlanInputSchema.parse(input.brief);

    if (brief.qualityPolicy === "off")
      throw new DomainError(
        "INVALID_SET_PLAN",
        "First-mix workflows require strict qualityPolicy.",
      );

    const request = JSON.stringify(brief);

    return this.db.transaction(() => {
      const old = this.db
        .prepare("SELECT request_json, data_json FROM mix_workflows WHERE request_token = ?")
        .get(requestToken) as { request_json: string; data_json: string } | undefined;

      if (old) {
        if (old.request_json !== request)
          throw new DomainError(
            "CONFIG_INVALID",
            "requestToken was already used with a different brief. Use a new token.",
          );

        return JSON.parse(old.data_json) as MixWorkflow;
      }

      const now = new Date().toISOString();

      const row: MixWorkflow = {
        id: crypto.randomUUID(),
        brief: { ...brief, seed: brief.seed ?? 1, qualityPolicy: "strict" },
        status: "queued",
        stage: "preflight",
        completedStages: [],
        analysisJobIds: [],
        planId: null,
        renderJobId: null,
        candidates: null,
        settingsIdentity,
        effectiveSettings,
        dependencies: {},
        renderJobIds: [],
        progress: null,
        issues: [],
        createdAt: now,
        updatedAt: now,
        result: null,
      };

      this.db
        .prepare("INSERT INTO mix_workflows VALUES (?, ?, ?, ?, ?)")
        .run(row.id, requestToken, request, row.status, JSON.stringify(row));

      return row;
    })();
  }

  get(id: string): MixWorkflow {
    const row = this.db.prepare("SELECT data_json FROM mix_workflows WHERE id = ?").get(id) as
      { data_json: string } | undefined;

    if (!row) throw new DomainError("INVALID_SET_PLAN", "Mix workflow was not found.");

    return JSON.parse(row.data_json) as MixWorkflow;
  }

  save(row: MixWorkflow): void {
    row.updatedAt = new Date().toISOString();

    this.db
      .prepare("UPDATE mix_workflows SET status = ?, data_json = ? WHERE id = ?")
      .run(row.status, JSON.stringify(row), row.id);
  }

  next(): MixWorkflow | null {
    const row = this.db
      .prepare(
        "SELECT data_json FROM mix_workflows WHERE status IN ('queued','running') ORDER BY rowid LIMIT 1",
      )
      .get() as { data_json: string } | undefined;

    return row ? (JSON.parse(row.data_json) as MixWorkflow) : null;
  }
}
