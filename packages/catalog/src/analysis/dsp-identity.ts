import { DSP_ANALYZER_VERSION } from "@dnb-crate/domain";

/**
 * Versioned identity of the effective DSP analysis INPUTS (F9, repository
 * review 2026-10-08). Freshness is judged against this string, so any input
 * change — beat anchor, configured tempo bounds — forces re-analysis even
 * when the analyzer version and file fingerprint are unchanged.
 *
 * Unset optional inputs (no anchor, no configured bounds) produce the bare
 * analyzer version, which is the identity every row analyzed with the
 * historical defaults already carries: existing libraries stay current and
 * are not mass-invalidated. Reference BPM drift is handled separately by
 * comparing the stored row's referenceBpm against the live canonical value.
 *
 * Shared by the coordinator's freshness check, the stage rows it writes,
 * and the repository's stale-scope selection so all three agree.
 */
export function dspInputIdentity(input: {
  beatAnchorMs?: number | null;
  bpmMin?: number | null;
  bpmMax?: number | null;
  version?: string;
}): string {
  const version = input.version ?? DSP_ANALYZER_VERSION;
  if (input.beatAnchorMs == null && input.bpmMin == null && input.bpmMax == null) {
    return version;
  }
  return [
    version,
    `anchor=${input.beatAnchorMs == null ? "-" : Math.round(input.beatAnchorMs)}`,
    `bpmMin=${input.bpmMin ?? "-"}`,
    `bpmMax=${input.bpmMax ?? "-"}`,
  ].join("|");
}

/**
 * Reasoned DSP freshness decision (R10): ONE contract shared by the
 * analysis coordinator (skip/compute), the first-mix workflow's scheduling,
 * and the repository's stale-scope selection. Returns why a row is stale so
 * callers can log/explain instead of disagreeing silently.
 *
 * Legacy policy for rows with no stage record (pre-stage schemas, or a
 * rescan that lost the stage): current ONLY when the track row itself says
 * analysis completed with this analyzer version. Anything else re-analyzes.
 */
export type DspFreshnessReason =
  | "no-analysis-row"
  | "analyzer-version"
  | "analysis-status"
  | "reference-lock"
  | "missing-stage"
  | "stage-state"
  | "stage-fingerprint"
  | "stage-identity"
  | "legacy-complete";

export type DspFreshness = { current: boolean; reason: DspFreshnessReason | null };

export function dspFreshness(input: {
  hasAnalysisRow: boolean;
  analyzerVersion: string | null;
  analysisStatus: string | null;
  fileFingerprint: string | null;
  stageState: string | null;
  stageFingerprint: string | null;
  stageIdentity: string | null;
  referenceBpm: number | null;
  trackBpm: number | null;
  trackBpmSource: string | null;
  /** CURRENT manual beat anchor (not the anchor stored when the row ran). */
  beatAnchorMs: number | null;
  bpmMin?: number | null;
  bpmMax?: number | null;
}): DspFreshness {
  if (!input.hasAnalysisRow) {
    return { current: false, reason: "no-analysis-row" };
  }
  if (input.analyzerVersion !== DSP_ANALYZER_VERSION) {
    return { current: false, reason: "analyzer-version" };
  }
  if (input.analysisStatus === "pending" || input.analysisStatus === "failed") {
    return { current: false, reason: "analysis-status" };
  }
  // Reference-lock freshness: the stored reference must match what the
  // current manual/published BPM would lock to. The analyzed writeback
  // echo is the analyzer's own result and is not a reference input.
  const trackRef =
    input.trackBpm != null &&
    (input.trackBpmSource === "manual" || input.trackBpmSource === "published")
      ? input.trackBpm
      : null;
  if (
    (trackRef == null) !== (input.referenceBpm == null) ||
    (trackRef != null &&
      input.referenceBpm != null &&
      Math.abs(trackRef - input.referenceBpm) > 0.01)
  ) {
    return { current: false, reason: "reference-lock" };
  }
  if (input.stageState == null) {
    // Legacy row without a stage record: trust only a completed track row.
    return input.analysisStatus === "complete"
      ? { current: true, reason: "legacy-complete" }
      : { current: false, reason: "missing-stage" };
  }
  if (input.stageState !== "succeeded") {
    return { current: false, reason: "stage-state" };
  }
  if (input.stageFingerprint !== input.fileFingerprint) {
    return { current: false, reason: "stage-fingerprint" };
  }
  const identity = dspInputIdentity({
    beatAnchorMs: input.beatAnchorMs,
    bpmMin: input.bpmMin,
    bpmMax: input.bpmMax,
  });
  if (input.stageIdentity !== identity) {
    return { current: false, reason: "stage-identity" };
  }
  return { current: true, reason: null };
}
