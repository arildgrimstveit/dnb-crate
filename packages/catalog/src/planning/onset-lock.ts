import type { BarEnergySeries } from "@dnb-crate/domain";

export type OnsetLockResult = {
  offsetMs: number;
  periodMs: number;
  score: number;
  applied: boolean;
  beats: number;
};

const BEAT_SHIFTS = [-8, -4, -3, -2, -1, 0, 1, 2, 3, 4, 8] as const;
const BAR_SHIFTS = [-8, -4, 0, 4, 8] as const;
const SCORE_MARGIN = 0.08;
/**
 * Absolute evidence floor. Cosine sums for genuinely locking drumlines clear
 * ~1.0; sparse or ambiguous overlaps score ~0.5–0.8 on every shift. Below the
 * floor the lock abstains instead of crowning the least-bad slip.
 */
const SCORE_FLOOR = 0.9;

function cosine(left: number[], right: number[]): number {
  const n = Math.min(left.length, right.length);
  if (n < 4) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < n; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm < 1e-12 || rightNorm < 1e-12) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function slice(values: number[] | undefined, start: number, count: number): number[] | null {
  if (!values || values.length === 0 || count <= 0) {
    return null;
  }
  const begin = Math.max(0, Math.round(start));
  const end = Math.min(values.length, begin + count);
  if (end - begin < 4) {
    return null;
  }
  return values.slice(begin, end);
}

function scoreShift(
  outgoing: BarEnergySeries,
  incoming: BarEnergySeries,
  outBar: number,
  inBar: number,
  beatCount: number,
  beatShift: number,
  outBeatOffset: number,
  inBeatOffset: number,
): number | null {
  // Beat profiles are indexed from beat 0; bars are indexed from the first
  // downbeat (bar 0). The offsets bridge the two origins.
  const outStartBeat = outBeatOffset + outBar * 4;
  const inStart = inBeatOffset + inBar * 4 + beatShift;
  if (outStartBeat < 0 || inStart < 0) {
    return null;
  }
  const outKick = slice(outgoing.beatKick, outStartBeat, beatCount);
  const inKick = slice(incoming.beatKick, inStart, beatCount);
  if (outKick && inKick) {
    const outSnare = slice(outgoing.beatSnare, outStartBeat, beatCount);
    const inSnare = slice(incoming.beatSnare, inStart, beatCount);
    const outOnset = slice(outgoing.beatOnset, outStartBeat, beatCount);
    const inOnset = slice(incoming.beatOnset, inStart, beatCount);
    const kick = cosine(outKick, inKick);
    const snare = outSnare && inSnare ? cosine(outSnare, inSnare) : 0;
    const onset = outOnset && inOnset ? cosine(outOnset, inOnset) : 0;
    const kickVsSnare = inSnare ? cosine(outKick, inSnare) : 0;
    const snareVsKick = outSnare ? cosine(outSnare, inKick) : 0;
    return kick + snare + 0.45 * onset - 0.7 * (kickVsSnare + snareVsKick);
  }
  const barCount = Math.floor(beatCount / 4);
  const barShift = beatShift / 4;
  if (barShift !== Math.round(barShift)) {
    return null;
  }
  // Bar energy series are already bar-0 anchored: no beat offset applies here.
  const outStartBar = outBar;
  const inStartBar = inBar + barShift;
  if (outStartBar < 0 || inStartBar < 0) {
    return null;
  }
  const outOnset = slice(
    outgoing.onsetDensity ?? outgoing.sub ?? outgoing.rms,
    outStartBar,
    barCount,
  );
  const inOnset = slice(
    incoming.onsetDensity ?? incoming.sub ?? incoming.rms,
    inStartBar,
    barCount,
  );
  if (!outOnset || !inOnset) {
    return null;
  }
  const outSub = slice(outgoing.sub, outStartBar, barCount);
  const inSub = slice(incoming.sub, inStartBar, barCount);
  const outFlux = slice(outgoing.midFlux, outStartBar, barCount);
  const inFlux = slice(incoming.midFlux, inStartBar, barCount);
  return (
    cosine(outOnset, inOnset) +
    (outSub && inSub ? cosine(outSub, inSub) : 0) +
    0.35 * (outFlux && inFlux ? cosine(outFlux, inFlux) : 0)
  );
}

/**
 * Search nearby beat/bar slips so overlapping drums and vocals share a grid.
 * Positive beats delay the incoming source (or advance the outgoing mix-out).
 */
export function searchOnsetLockOffset(input: {
  outgoing: BarEnergySeries | null | undefined;
  incoming: BarEnergySeries | null | undefined;
  mixOutBar: number | null;
  mixInBar: number | null;
  barCount: number;
  beatMs: number;
  incomingRate?: number;
  /**
   * Beat-array index of bar 0 (the first downbeat's index in beatTimesMs).
   * Bar energy series need no offset; beat profiles do.
   */
  outBeatOffset?: number;
  inBeatOffset?: number;
}): OnsetLockResult {
  const periodMs = input.beatMs * 4;
  const empty = { offsetMs: 0, periodMs, score: 0, applied: false, beats: 0 };
  if (
    !input.outgoing ||
    !input.incoming ||
    input.mixOutBar == null ||
    input.mixInBar == null ||
    !(input.beatMs > 0) ||
    input.barCount < 8
  ) {
    return empty;
  }
  const rate = input.incomingRate && input.incomingRate > 0 ? input.incomingRate : 1;
  const hasBeats =
    (input.outgoing.beatKick?.length ?? 0) >= 16 && (input.incoming.beatKick?.length ?? 0) >= 16;
  const shifts = hasBeats ? BEAT_SHIFTS : BAR_SHIFTS;
  const outBar = input.mixOutBar;
  const inBar = input.mixInBar;
  const outBeatOffset = Math.round(input.outBeatOffset ?? 0);
  const inBeatOffset = Math.round(input.inBeatOffset ?? 0);
  const beatCount = input.barCount * 4;
  let bestShift = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  let zeroScore = Number.NEGATIVE_INFINITY;
  for (const shift of shifts) {
    const score = scoreShift(
      input.outgoing,
      input.incoming,
      outBar,
      inBar,
      beatCount,
      shift,
      outBeatOffset,
      inBeatOffset,
    );
    if (score == null) {
      continue;
    }
    if (shift === 0) {
      zeroScore = score;
    }
    if (
      score > bestScore + 1e-9 ||
      (Math.abs(score - bestScore) <= 1e-9 && Math.abs(shift) < Math.abs(bestShift))
    ) {
      bestScore = score;
      bestShift = shift;
    }
  }
  if (!Number.isFinite(bestScore) || bestShift === 0) {
    return { ...empty, score: Number.isFinite(zeroScore) ? zeroScore : 0 };
  }
  if (!(bestScore >= zeroScore + SCORE_MARGIN)) {
    return { ...empty, score: zeroScore };
  }
  if (!(bestScore >= SCORE_FLOOR)) {
    return { ...empty, score: zeroScore };
  }
  return {
    offsetMs: Math.round(bestShift * input.beatMs * rate),
    periodMs,
    score: bestScore,
    applied: true,
    beats: bestShift,
  };
}
