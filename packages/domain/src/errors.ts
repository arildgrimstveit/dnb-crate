export type DomainErrorCode =
  | "TRACK_NOT_FOUND"
  | "SET_PLAN_NOT_FOUND"
  | "INVALID_SET_PLAN"
  | "MISSING_METADATA"
  | "MISSING_CUE_POINTS"
  | "AUDIO_FILE_UNAVAILABLE"
  | "FFMPEG_UNAVAILABLE"
  | "RENDER_FAILED"
  | "RENDER_JOB_NOT_FOUND"
  | "RENDER_INTERRUPTED"
  | "ANALYSIS_FAILED"
  | "ANALYSIS_JOB_NOT_FOUND"
  | "ANALYSIS_ENGINE_UNAVAILABLE"
  | "ANALYSIS_ENGINE_FAILED"
  | "LOW_CONFIDENCE_ANALYSIS"
  | "PLAYBACK_RATE_OUT_OF_RANGE"
  | "INVALID_BEAT_GRID"
  | "PATH_OUTSIDE_LIBRARY_ROOT"
  | "RESULT_LIMIT_EXCEEDED"
  | "INVALID_CURSOR"
  | "INVALID_METADATA"
  | "CONFIG_INVALID"
  | "SCAN_FAILED"
  | "ENRICHMENT_FAILED"
  | "ENRICHMENT_JOB_NOT_FOUND";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: DomainErrorCode,
    message: string,
    options?: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "DomainError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
