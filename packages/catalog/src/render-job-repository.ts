import type {
  RenderJob,
  RenderJobKind,
  RenderJobStatus,
  RenderManifestV1,
  RenderOutputFormat,
} from "@dnb-crate/domain";
import {
  DEFAULT_RENDER_OUTPUT_FORMAT,
  DomainError,
  RENDER_JOB_LIST_LIMIT_MAX,
} from "@dnb-crate/domain";

import type { SqliteDatabase } from "./db.ts";
import { decodeCursor, encodeCursor } from "./pagination.ts";

type JobRow = {
  id: string;
  kind: RenderJobKind;
  set_plan_id: string;
  status: RenderJobStatus;
  progress: number;
  output_format: RenderOutputFormat;
  output_relpath: string | null;
  output_checksum: string | null;
  transition_id: string | null;
  cache_key: string | null;
  params_json: string | null;
  error_code: string | null;
  error_message: string | null;
  retryable: number;
  manifest_json: string | null;
  warnings_json: string;
  progress_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type RenderJobParams = {
  windowMs?: number;
  edgeFadeMs?: number;
  template?: "crossfade" | "phrase_mix" | "bass_swap";
  barCount?: 8 | 16 | 32;
  allowLowConfidence?: boolean;
  allowExcessiveTempo?: boolean;
};

export type StoredRenderJob = RenderJob & {
  cacheKey: string | null;
  manifest: RenderManifestV1 | null;
  params: RenderJobParams;
};

function nowIso(): string {
  return new Date().toISOString();
}

function fileNameOf(relPath: string | null): string | null {
  if (!relPath) {
    return null;
  }
  const parts = relPath.split(/[/\\]/);
  return parts[parts.length - 1] ?? relPath;
}

function mapJob(row: JobRow): StoredRenderJob {
  return {
    id: row.id,
    setPlanId: row.set_plan_id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    outputFormat: row.output_format,
    outputRootRelativePath: row.output_relpath,
    outputFileName: fileNameOf(row.output_relpath),
    outputChecksumSha256: row.output_checksum,
    transitionId: row.transition_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryable: row.retryable === 1,
    warnings: JSON.parse(row.warnings_json) as string[],
    progressMessage: row.progress_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cacheKey: row.cache_key,
    params: row.params_json ? (JSON.parse(row.params_json) as RenderJobParams) : {},
    manifest: row.manifest_json ? (JSON.parse(row.manifest_json) as RenderManifestV1) : null,
  };
}

export class RenderJobRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insertQueued(input: {
    id: string;
    kind: RenderJobKind;
    setPlanId: string;
    transitionId?: string | null;
    cacheKey?: string | null;
    warnings?: string[];
    params?: RenderJobParams;
  }): StoredRenderJob {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO render_jobs (
          id, kind, set_plan_id, status, progress, output_format, transition_id, cache_key,
          params_json, warnings_json, created_at
        ) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.kind,
        input.setPlanId,
        DEFAULT_RENDER_OUTPUT_FORMAT,
        input.transitionId ?? null,
        input.cacheKey ?? null,
        JSON.stringify(input.params ?? {}),
        JSON.stringify(input.warnings ?? []),
        timestamp,
      );
    return this.require(input.id);
  }

  insertSucceededCache(input: {
    id: string;
    kind: RenderJobKind;
    setPlanId: string;
    transitionId: string | null;
    cacheKey: string;
    source: StoredRenderJob;
  }): StoredRenderJob {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO render_jobs (
          id, kind, set_plan_id, status, progress, output_format, output_relpath, output_checksum,
          transition_id, cache_key, manifest_json, warnings_json, progress_message,
          created_at, started_at, completed_at
        ) VALUES (?, ?, ?, 'succeeded', 1, ?, ?, ?, ?, ?, ?, ?, 'cache hit', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.kind,
        input.setPlanId,
        input.source.outputFormat,
        input.source.outputRootRelativePath,
        input.source.outputChecksumSha256,
        input.transitionId,
        input.cacheKey,
        input.source.manifest ? JSON.stringify(input.source.manifest) : null,
        JSON.stringify(["Returned cached preview with the same content hash."]),
        timestamp,
        timestamp,
        timestamp,
      );
    return this.require(input.id);
  }

  findById(id: string): StoredRenderJob | null {
    const row = this.db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(id) as
      JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  require(id: string): StoredRenderJob {
    const job = this.findById(id);
    if (!job) {
      throw new DomainError("RENDER_JOB_NOT_FOUND", `No render job with id ${id}`);
    }
    return job;
  }

  findSucceededByCacheKey(cacheKey: string): StoredRenderJob | null {
    const row = this.db
      .prepare(
        `SELECT * FROM render_jobs
         WHERE cache_key = ? AND status = 'succeeded' AND output_relpath IS NOT NULL
         ORDER BY completed_at DESC LIMIT 1`,
      )
      .get(cacheKey) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  claimNextQueued(): StoredRenderJob | null {
    const row = this.db
      .prepare(
        `SELECT * FROM render_jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get() as JobRow | undefined;
    if (!row) {
      return null;
    }
    const started = nowIso();
    const result = this.db
      .prepare(
        `UPDATE render_jobs SET status = 'running', started_at = ?, progress = 0, progress_message = 'starting'
         WHERE id = ? AND status = 'queued'`,
      )
      .run(started, row.id);
    if (result.changes === 0) {
      return this.claimNextQueued();
    }
    return this.require(row.id);
  }

  updateProgress(id: string, progress: number, message?: string): void {
    this.db
      .prepare(
        `UPDATE render_jobs SET progress = ?, progress_message = COALESCE(?, progress_message) WHERE id = ? AND status = 'running'`,
      )
      .run(Math.max(0, Math.min(1, progress)), message ?? null, id);
  }

  markSucceeded(
    id: string,
    input: {
      outputRelpath: string;
      checksum: string;
      manifest: RenderManifestV1;
      warnings: string[];
    },
  ): StoredRenderJob {
    this.db
      .prepare(
        `UPDATE render_jobs SET
          status = 'succeeded', progress = 1, output_format = ?, output_relpath = ?,
          output_checksum = ?, manifest_json = ?, warnings_json = ?, progress_message = 'complete',
          error_code = NULL, error_message = NULL, retryable = 0, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        input.manifest.outputFormat,
        input.outputRelpath,
        input.checksum,
        JSON.stringify(input.manifest),
        JSON.stringify(input.warnings),
        nowIso(),
        id,
      );
    return this.require(id);
  }

  markFailed(
    id: string,
    error: { code: string; message: string; retryable: boolean },
  ): StoredRenderJob {
    this.db
      .prepare(
        `UPDATE render_jobs SET
          status = 'failed', error_code = ?, error_message = ?, retryable = ?,
          progress_message = 'failed', completed_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(error.code, error.message, error.retryable ? 1 : 0, nowIso(), id);
    return this.require(id);
  }

  markCancelled(id: string): StoredRenderJob {
    this.db
      .prepare(
        `UPDATE render_jobs SET
          status = 'cancelled', progress_message = 'cancelled',
          error_code = NULL, error_message = 'Cancelled by user', retryable = 0, completed_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(nowIso(), id);
    return this.require(id);
  }

  failRunningAsInterrupted(): number {
    const result = this.db
      .prepare(
        `UPDATE render_jobs SET
          status = 'failed', error_code = 'RENDER_INTERRUPTED',
          error_message = 'Server restarted while this render was running',
          retryable = 1, progress_message = 'interrupted', completed_at = ?
         WHERE status = 'running'`,
      )
      .run(nowIso());
    return result.changes;
  }

  list(options: { limit?: number; cursor?: string; setPlanId?: string }): {
    jobs: StoredRenderJob[];
    nextCursor: string | null;
  } {
    const limit = Math.min(options.limit ?? 20, RENDER_JOB_LIST_LIMIT_MAX);
    const params: unknown[] = [];
    const where: string[] = [];
    if (options.setPlanId) {
      where.push("set_plan_id = ?");
      params.push(options.setPlanId);
    }
    if (options.cursor) {
      const decoded = decodeCursor(options.cursor);
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(decoded.value, decoded.value, decoded.id);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM render_jobs ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params, limit + 1) as JobRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      jobs: page.map(mapJob),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({
              sort: "createdAt",
              direction: "desc",
              value: last.created_at,
              id: last.id,
            })
          : null,
    };
  }

  toPublic(job: StoredRenderJob): RenderJob {
    const { cacheKey: _cacheKey, manifest: _manifest, params: _params, ...rest } = job;
    return rest;
  }
}
