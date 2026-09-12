import { randomUUID } from "node:crypto";
import type { RenderManifestV1 } from "@dnb-crate/domain";
import type { SqliteDatabase } from "./db.ts";

export type HourFeedback = {
  id: string;
  renderJobId: string;
  outputChecksum: string;
  setPlanId: string;
  planContentHash: string;
  accepted: boolean;
  quote: string;
  createdAt: string;
};
export class HourFeedbackRepository {
  constructor(private readonly db: SqliteDatabase) {}
  list(renderJobId?: string): HourFeedback[] {
    const rows = this.db
      .prepare(
        `SELECT id, render_job_id AS renderJobId, output_checksum AS outputChecksum, set_plan_id AS setPlanId, plan_content_hash AS planContentHash, accepted, quote, created_at AS createdAt FROM hour_feedback ${renderJobId ? "WHERE render_job_id = ?" : ""} ORDER BY rowid DESC`,
      )
      .all(...(renderJobId ? [renderJobId] : [])) as Array<
      Omit<HourFeedback, "accepted"> & { accepted: number }
    >;
    return rows.map((row) => ({ ...row, accepted: row.accepted === 1 }));
  }
  record(manifest: RenderManifestV1, accepted: boolean, quote: string): HourFeedback {
    const existing = this.list(manifest.renderJobId)[0];
    if (
      existing?.outputChecksum === manifest.outputChecksumSha256 &&
      existing.accepted === accepted &&
      existing.quote === quote
    )
      return existing;
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO hour_feedback VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        id,
        manifest.renderJobId,
        manifest.outputChecksumSha256,
        manifest.setPlanId,
        manifest.setPlanContentHash,
        accepted ? 1 : 0,
        quote,
        new Date().toISOString(),
      );
    return this.list(manifest.renderJobId).find((row) => row.id === id)!;
  }
  acceptedPlan(planId: string, contentHash: string): boolean {
    const seen = new Set<string>();
    return this.list().some((row) => {
      if (seen.has(row.renderJobId)) return false;
      seen.add(row.renderJobId);
      return row.setPlanId === planId && row.planContentHash === contentHash && row.accepted;
    });
  }
}
