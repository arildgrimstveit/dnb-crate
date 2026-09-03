import {
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
  return targetBpm / sourceBpm;
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
