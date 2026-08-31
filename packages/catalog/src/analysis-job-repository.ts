import type { AnalysisJob, AnalysisJobStatus } from "@dnb-crate/domain";
import { ANALYSIS_JOB_LIST_LIMIT_MAX, DomainError } from "@dnb-crate/domain";

import type { SqliteDatabase } from "./db.ts";

type JobRow = {
  id: string;
  status: AnalysisJobStatus;
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
};

function nowIso(): string {
  return new Date().toISOString();
}

function mapJob(row: JobRow): AnalysisJob {
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
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export class AnalysisJobRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insertQueued(trackIds: string[]): AnalysisJob {
    const id = crypto.randomUUID();
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO analysis_jobs (
          id, status, progress, track_ids_json, completed_ids_json, failed_ids_json, created_at
        ) VALUES (?, 'queued', 0, ?, '[]', '[]', ?)`,
      )
      .run(id, JSON.stringify(trackIds), timestamp);
    return this.require(id);
  }

  findById(id: string): AnalysisJob | null {
    const row = this.db.prepare("SELECT * FROM analysis_jobs WHERE id = ?").get(id) as
      JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  require(id: string): AnalysisJob {
    const job = this.findById(id);
    if (!job) {
      throw new DomainError("ANALYSIS_JOB_NOT_FOUND", `No analysis job with id ${id}`);
    }
    return job;
  }

  claimNextQueued(): AnalysisJob | null {
    const row = this.db
      .prepare(
        `SELECT * FROM analysis_jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get() as JobRow | undefined;
    if (!row) {
      return null;
    }
    const result = this.db
      .prepare(
        `UPDATE analysis_jobs SET status = 'running', started_at = ?, progress = 0
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
  ): void {
    this.db
      .prepare(
        `UPDATE analysis_jobs SET progress = ?, completed_ids_json = ?, failed_ids_json = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        Math.max(0, Math.min(1, progress)),
        JSON.stringify(completedTrackIds),
        JSON.stringify(failedTrackIds),
        id,
      );
  }

  markSucceeded(id: string, completedTrackIds: string[], failedTrackIds: string[]): AnalysisJob {
    this.db
      .prepare(
        `UPDATE analysis_jobs SET
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
  ): AnalysisJob {
    this.db
      .prepare(
        `UPDATE analysis_jobs SET
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
        `UPDATE analysis_jobs SET
          status = 'failed', error_code = 'ANALYSIS_FAILED',
          error_message = 'Server restarted while this analysis was running',
          retryable = 1, completed_at = ?
         WHERE status = 'running'`,
      )
      .run(nowIso());
    return result.changes;
  }

  list(limit?: number): AnalysisJob[] {
    const cap = Math.min(limit ?? 20, ANALYSIS_JOB_LIST_LIMIT_MAX);
    const rows = this.db
      .prepare(`SELECT * FROM analysis_jobs ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(cap) as JobRow[];
    return rows.map(mapJob);
  }
}
