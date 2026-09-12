import {
  ATEMPO_DRIFT_BUDGET_MS,
  ATEMPO_SKIP_THRESHOLD,
  DNB_BPM_MAX,
  DNB_BPM_MIN,
  MAX_TEMPO_DEVIATION,
  MIN_BPM_HINT_CONFIDENCE,
  PUBLISHED_BPM_FRACTION_TOLERANCE,
  PUBLISHED_BPM_INTEGER_TOLERANCE,
} from "./constants.ts";
import { DomainError } from "./errors.ts";

export function beatPeriodMs(bpm: number): number {
  return 60_000 / bpm;
}

export function barDurationMs(bpm: number): number {
  return 4 * beatPeriodMs(bpm);
}

export function phraseDurationMs(bars: number, bpm: number): number {
  return bars * barDurationMs(bpm);
}

export function playbackRateForBpm(sourceBpm: number, targetBpm: number): number {
  if (!(sourceBpm > 0) || !(targetBpm > 0)) {
    throw new DomainError(
      "PLAYBACK_RATE_OUT_OF_RANGE",
      "BPM must be positive to compute playback rate",
    );
  }
  return snapPlaybackRate(targetBpm / sourceBpm);
}

/**
 * Tempo the beat grid is actually on. Published canonical can disagree
 * (Like a Memory: analyzed 175, published 176) — atempo must use the grid.
 */
export function sourceBpmForRate(
  gridBpm: number | null | undefined,
  fallbackBpm: number | null | undefined,
): number | null {
  if (gridBpm != null && Number.isFinite(gridBpm) && gridBpm > 0) {
    return gridBpm;
  }
  if (fallbackBpm != null && Number.isFinite(fallbackBpm) && fallbackBpm > 0) {
    return fallbackBpm;
  }
  return null;
}

export function snapPlaybackRate(
  rate: number,
  epsilon = ATEMPO_SKIP_THRESHOLD,
): number {
  return Math.abs(rate - 1) < epsilon ? 1 : rate;
}

export function sourceToOutputMs(sourceDeltaMs: number, rate: number): number {
  const safe = rate > 0 ? rate : 1;
  return sourceDeltaMs / safe;
}

export function outputToSourceMs(outputDeltaMs: number, rate: number): number {
  const safe = rate > 0 ? rate : 1;
  return outputDeltaMs * safe;
}

export function playbackRateDriftMs(rate: number, durationMs: number): number {
  if (!(rate > 0) || !Number.isFinite(rate) || !Number.isFinite(durationMs)) {
    return 0;
  }
  return Math.abs(rate - 1) * durationMs;
}

export function shouldSkipAtempo(
  rate: number,
  durationMs: number,
  budgetMs = ATEMPO_DRIFT_BUDGET_MS,
): boolean {
  if (!(rate > 0) || !Number.isFinite(rate)) {
    return true;
  }
  if (Math.abs(rate - 1) < ATEMPO_SKIP_THRESHOLD) {
    return true;
  }
  return playbackRateDriftMs(rate, durationMs) < budgetMs;
}

export function effectivePlaybackRate(
  rate: number | undefined,
  sourceDurationMs: number,
  budgetMs = ATEMPO_DRIFT_BUDGET_MS,
): number {
  if (rate === undefined || !(rate > 0)) {
    return 1;
  }
  return shouldSkipAtempo(rate, sourceDurationMs, budgetMs) ? 1 : rate;
}

/**
 * Featured body stays at rate 1. Only the join head/tail is stretched.
 * Drift skip uses the overlap, not the whole window (175→174 over 16 bars still stretches).
 */
export function overlapOnlyPlayableMs(input: {
  sourceMs: number;
  rate: number;
  overlapToNextMs?: number | null;
  overlapFromPrevMs?: number | null;
}): number {
  const source = Math.max(0, input.sourceMs);
  const rate = input.rate > 0 ? input.rate : 1;
  const right = Math.max(0, input.overlapToNextMs ?? 0);
  const left = Math.max(0, input.overlapFromPrevMs ?? 0);
  const stretchMs = Math.max(left, right);
  if (stretchMs <= 0) {
    return source / (shouldSkipAtempo(rate, source) ? 1 : rate);
  }
  if (shouldSkipAtempo(rate, stretchMs)) {
    return source;
  }
  const rightSrc = right > 0 ? outputToSourceMs(right, rate) : 0;
  const leftSrc = left > 0 ? outputToSourceMs(left, rate) : 0;
  if (leftSrc + rightSrc >= source) {
    return source / rate;
  }
  return left + Math.max(0, source - leftSrc - rightSrc) + right;
}

export function foldedIntegerBpm(bpm: number): number | null {
  const folded = normalizeDnbBpm(bpm);
  if (!folded) {
    return null;
  }
  return Math.round(folded.bpm);
}

export function pairTargetBpm(
  outCanon: number,
  inCanon: number,
  options: { chainTargetBpm?: number | null; outgoingLocked?: boolean } = {},
): number {
  if (options.outgoingLocked) {
    return outCanon;
  }
  const outFold = foldedIntegerBpm(outCanon) ?? Math.round(outCanon);
  const inFold = foldedIntegerBpm(inCanon) ?? Math.round(inCanon);
  const fits = (source: number, target: number): boolean =>
    Math.abs(playbackRateForBpm(source, target) - 1) <= MAX_TEMPO_DEVIATION + 1e-9;
  if (options.chainTargetBpm != null && options.chainTargetBpm > 0) {
    const chain = foldedIntegerBpm(options.chainTargetBpm) ?? options.chainTargetBpm;
    if (fits(outCanon, chain) && fits(inCanon, chain)) {
      return chain;
    }
  }
  if (outFold === inFold) {
    return outFold;
  }
  if (fits(inCanon, outFold)) {
    return outFold;
  }
  return normalizeDnbBpm((outCanon + inCanon) / 2)?.bpm ?? (outCanon + inCanon) / 2;
}

export function assertPlaybackRate(
  rate: number,
  options: { maxDeviation?: number; allowExcessive?: boolean } = {},
): void {
  const maxDeviation = options.maxDeviation ?? MAX_TEMPO_DEVIATION;
  if (!(rate > 0) || rate < 0.5 || rate > 2) {
    throw new DomainError(
      "PLAYBACK_RATE_OUT_OF_RANGE",
      `Playback rate ${rate.toFixed(4)} is outside the hard 0.5–2.0 window`,
    );
  }
  if (!options.allowExcessive && Math.abs(rate - 1) > maxDeviation + 1e-9) {
    throw new DomainError(
      "PLAYBACK_RATE_OUT_OF_RANGE",
      `Playback rate ${rate.toFixed(4)} exceeds ±${(maxDeviation * 100).toFixed(1)}%. Pass allowExcessiveTempo to override.`,
    );
  }
}

export type NormalizedDnbBpm = {
  bpm: number;
  foldedFrom: number | null;
};

/**
 * Fold half/double-time estimates into the configured DnB range.
 * Returns null when no fold lands inside the range.
 */
export function normalizeDnbBpm(
  bpm: number,
  minBpm = DNB_BPM_MIN,
  maxBpm = DNB_BPM_MAX,
): NormalizedDnbBpm | null {
  if (!(bpm > 0) || !Number.isFinite(bpm)) {
    return null;
  }
  const candidates = [bpm, bpm * 2, bpm / 2];
  const inRange = candidates.filter((value) => value >= minBpm - 1e-6 && value <= maxBpm + 1e-6);
  if (inRange.length === 0) {
    return null;
  }
  inRange.sort((a, b) => Math.abs(a - (minBpm + maxBpm) / 2) - Math.abs(b - (minBpm + maxBpm) / 2));
  const chosen = inRange[0]!;
  const foldedFrom = Math.abs(chosen - bpm) < 1e-6 ? null : bpm;
  return { bpm: chosen, foldedFrom };
}

export function publishedBpmTolerance(referenceBpm: number): number {
  return Number.isInteger(referenceBpm)
    ? PUBLISHED_BPM_INTEGER_TOLERANCE
    : PUBLISHED_BPM_FRACTION_TOLERANCE;
}

/**
 * Published/manual BPM used as the analyzer lock. Half-time tags (87, 86.49)
 * fold into 160–190; a tag that cannot fold (150) is returned unchanged so a
 * failing lock can still be scored, then discarded if a free grid already passed.
 */
export function resolvePublishedReferenceBpm(
  publishedBpm: number,
  minBpm = DNB_BPM_MIN,
  maxBpm = DNB_BPM_MAX,
): { bpm: number; foldedFrom: number | null } {
  const folded = normalizeDnbBpm(publishedBpm, minBpm, maxBpm);
  if (folded) {
    return { bpm: folded.bpm, foldedFrom: folded.foldedFrom };
  }
  return { bpm: publishedBpm, foldedFrom: null };
}

/** Half/double, 3:2, 5:4 (140↔175), 4:3 (130↔173), 5:3 (105↔175), 6:5 (145↔174). */
const PUBLISHED_REFERENCE_RATIOS = [
  1,
  2,
  1 / 2,
  3 / 2,
  2 / 3,
  5 / 4,
  4 / 5,
  4 / 3,
  3 / 4,
  5 / 3,
  3 / 5,
  6 / 5,
  5 / 6,
];

/**
 * In-range tempos a published/manual/prior-analyzed tag might actually mean.
 * The analyzer scores these; it does not pick one blindly.
 */
export function publishedReferenceCandidates(
  publishedBpm: number,
  minBpm = DNB_BPM_MIN,
  maxBpm = DNB_BPM_MAX,
): number[] {
  if (!(publishedBpm > 0) || !Number.isFinite(publishedBpm)) {
    return [];
  }
  const found = new Map<number, number>();
  for (const ratio of PUBLISHED_REFERENCE_RATIOS) {
    const value = publishedBpm * ratio;
    if (value >= minBpm - 1e-6 && value <= maxBpm + 1e-6) {
      const key = Number(value.toFixed(3));
      if (!found.has(key)) {
        found.set(key, value);
      }
    }
  }
  return [...found.values()];
}

export function analyzerVersionLessThan(have: string, current: string): boolean {
  const left = have.split(".").map((part) => Number(part) || 0);
  const right = current.split(".").map((part) => Number(part) || 0);
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    if ((left[i] ?? 0) < (right[i] ?? 0)) {
      return true;
    }
    if ((left[i] ?? 0) > (right[i] ?? 0)) {
      return false;
    }
  }
  return false;
}

export function resolveBpmHint(
  analysis: {
    gridRejected: boolean;
    bpmRaw?: number | null;
    bpmConfidence: number | null;
  },
  minBpm = DNB_BPM_MIN,
  maxBpm = DNB_BPM_MAX,
): { bpm: number | null; confidence: number | null } {
  if (!analysis.gridRejected || analysis.bpmRaw == null) {
    return { bpm: null, confidence: null };
  }
  if ((analysis.bpmConfidence ?? 0) < MIN_BPM_HINT_CONFIDENCE) {
    return { bpm: null, confidence: null };
  }
  const folded = normalizeDnbBpm(analysis.bpmRaw, minBpm, maxBpm);
  if (!folded) {
    return { bpm: null, confidence: null };
  }
  return { bpm: folded.bpm, confidence: analysis.bpmConfidence };
}

export function reconstructGrid(
  anchorMs: number,
  bpm: number,
  durationMs: number,
): { beatTimesMs: number[]; downbeatTimesMs: number[] } {
  const period = beatPeriodMs(bpm);
  let first = anchorMs % period;
  if (first > 0) {
    first -= period;
  }
  while (first < 0) {
    first += period;
  }
  const beatTimesMs: number[] = [];
  for (let t = first; t <= durationMs + 0.5; t += period) {
    beatTimesMs.push(Math.round(t));
  }
  const anchorBeat = beatTimesMs.reduce(
    (best, time, index) =>
      Math.abs(time - anchorMs) < Math.abs(beatTimesMs[best]! - anchorMs) ? index : best,
    0,
  );
  const phase = anchorBeat % 4;
  const downbeatTimesMs = beatTimesMs.filter((_, index) => (index - phase) % 4 === 0);
  return { beatTimesMs, downbeatTimesMs };
}

export function snapToNearestBeat(
  positionMs: number,
  beatTimesMs: number[],
): { positionMs: number; beatIndex: number } | null {
  if (beatTimesMs.length === 0) {
    return null;
  }
  let best = 0;
  for (let i = 1; i < beatTimesMs.length; i += 1) {
    if (Math.abs(beatTimesMs[i]! - positionMs) < Math.abs(beatTimesMs[best]! - positionMs)) {
      best = i;
    }
  }
  return { positionMs: beatTimesMs[best]!, beatIndex: best };
}

export function barIndexForBeat(beatIndex: number): number {
  return Math.floor(beatIndex / 4);
}
