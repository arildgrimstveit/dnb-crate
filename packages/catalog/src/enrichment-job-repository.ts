import type { EnrichmentJob } from "@dnb-crate/domain";
import { DomainError } from "@dnb-crate/domain";

import type { SqliteDatabase } from "./db.ts";

type JobRow = {
  id: string;
  status: EnrichmentJob["status"];
  progress: number;
  track_ids_json: string;
  completed_ids_json: string;
  failed_ids_json: string;
  error_code: string | null;
  error_message: string | null;
  retryable: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  progress_message: string | null;
  dry_run: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function mapJob(row: JobRow): EnrichmentJob {
  return {
    id: row.id,
    status: row.status,
    progress: row.progress,
    trackIds: JSON.parse(row.track_ids_json) as string[],
    completedTrackIds: JSON.parse(row.completed_ids_json) as string[],
    failedTrackIds: JSON.parse(row.failed_ids_json) as string[],
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryable: row.retryable === 1,
    dryRun: row.dry_run === 1,
    progressMessage: row.progress_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export class EnrichmentJobRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insertQueued(trackIds: string[], dryRun: boolean): EnrichmentJob {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO enrichment_jobs (
          id, status, progress, track_ids_json, completed_ids_json, failed_ids_json,
          created_at, dry_run
        ) VALUES (?, 'queued', 0, ?, '[]', '[]', ?, ?)`,
      )
      .run(id, JSON.stringify(trackIds), nowIso(), dryRun ? 1 : 0);
    return this.require(id);
  }

  findById(id: string): EnrichmentJob | null {
    const row = this.db.prepare("SELECT * FROM enrichment_jobs WHERE id = ?").get(id) as
      JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  require(id: string): EnrichmentJob {
    const job = this.findById(id);
    if (!job) {
      throw new DomainError("ENRICHMENT_JOB_NOT_FOUND", `No enrichment job with id ${id}`);
    }
    return job;
  }

  claimNextQueued(): EnrichmentJob | null {
    const row = this.db
      .prepare(
        `SELECT * FROM enrichment_jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get() as JobRow | undefined;
    if (!row) {
      return null;
    }
    const result = this.db
      .prepare(
        `UPDATE enrichment_jobs SET status = 'running', started_at = ?, progress = 0
         WHERE id = ? AND status = 'queued'`,
      )
      .run(nowIso(), row.id);
    if (result.changes === 0) {
      return this.claimNextQueued();
    }
    return this.require(row.id);
  }

  updateProgress(
    id: string,
    progress: number,
    completedTrackIds: string[],
    failedTrackIds: string[],
    message: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE enrichment_jobs SET progress = ?, completed_ids_json = ?, failed_ids_json = ?,
          progress_message = ? WHERE id = ? AND status = 'running'`,
      )
      .run(
        Math.max(0, Math.min(1, progress)),
        JSON.stringify(completedTrackIds),
        JSON.stringify(failedTrackIds),
        message,
        id,
      );
  }

  markSucceeded(id: string, completedTrackIds: string[], failedTrackIds: string[]): EnrichmentJob {
    this.db
      .prepare(
        `UPDATE enrichment_jobs SET
          status = 'succeeded', progress = 1, completed_ids_json = ?, failed_ids_json = ?,
          error_code = NULL, error_message = NULL, retryable = 0, completed_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(completedTrackIds), JSON.stringify(failedTrackIds), nowIso(), id);
    return this.require(id);
  }

  markFailed(
    id: string,
    error: { code: string; message: string; retryable: boolean },
    completedTrackIds: string[],
    failedTrackIds: string[],
  ): EnrichmentJob {
    this.db
      .prepare(
        `UPDATE enrichment_jobs SET
          status = 'failed', error_code = ?, error_message = ?, retryable = ?,
          completed_ids_json = ?, failed_ids_json = ?, completed_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(
        error.code,
        error.message,
        error.retryable ? 1 : 0,
        JSON.stringify(completedTrackIds),
        JSON.stringify(failedTrackIds),
        nowIso(),
        id,
      );
    return this.require(id);
  }

  failRunningAsInterrupted(): number {
    const result = this.db
      .prepare(
        `UPDATE enrichment_jobs SET
          status = 'failed', error_code = 'ENRICHMENT_FAILED',
          error_message = 'Server restarted while this enrichment was running',
          retryable = 1, completed_at = ?
         WHERE status = 'running'`,
      )
      .run(nowIso());
    return result.changes;
  }

  list(limit = 20): EnrichmentJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM enrichment_jobs ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(Math.min(limit, 50)) as JobRow[];
    return rows.map(mapJob);
  }
}
