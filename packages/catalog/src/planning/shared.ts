import {
  normalizePersonName,
  PLANNER_GROOVE_LOCAL_WINDOW_BARS,
  PLANNER_GROOVE_SYNCOPATION_PENALTY_SLOPE,
  PLANNER_GROOVE_SYNCOPATION_TOLERANCE,
  type Track,
} from "@dnb-crate/domain";

/** Canonical artist identity for spacing/penalties: the published canonical
 * name when present, else the normalized artist. Shared by the planner and
 * the quality report so both agree on who counts as "the same artist". */
export function artistKey(track: Track): string | null {
  if (track.artistCanonical) {
    return track.artistCanonical;
  }
  return track.artist ? normalizePersonName(track.artist) : null;
}

/** Primary-artist identity for cross-plan freshness: the lead name before
 * the first collaborator comma ("Pendulum, Venus Demilo" → "Pendulum").
 * Used by both the variety-history builder (service) and the planner
 * penalty so prolific lead artists rotate out of recent sets instead of
 * just cycling through their catalogs. */
export function primaryArtistKey(track: Track): string | null {
  const full = artistKey(track);
  if (full == null) {
    return null;
  }
  const first = full.split(",")[0]!.trim();
  return first.length > 0 ? normalizePersonName(first) : null;
}

function cosineSim(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) + 1e-12);
}

/**
 * Groove compatibility between the outgoing tail and the incoming head,
 * measured from the stored per-beat kick/snare profiles. High = the drum
 * patterns align at the join; low = they fight (the "very noisy" or
 * "galloping" perception when two incompatible grooves are blended by
 * phrase_mix). Returns null when either track lacks beat profiles.
 *
 * Uses the same shape as the onset-lock's scoreShift: kick cosine dominates,
 * snare confirms, and cross-terms (outgoing kick vs incoming snare) penalize
 * label swaps. Compared over the default 16-bar overlap (64 beats).
 */
export function grooveCompatibility(
  outgoingBars:
    | {
        beatKick?: number[];
        beatSnare?: number[];
        beatOnset?: number[];
      }
    | null
    | undefined,
  incomingBars:
    | {
        beatKick?: number[];
        beatSnare?: number[];
        beatOnset?: number[];
      }
    | null
    | undefined,
  beatCount = 64,
  groove?: {
    outgoingSyncopation?: number | null;
    incomingSyncopation?: number | null;
  },
): number | null {
  const outKick = outgoingBars?.beatKick;
  const inKick = incomingBars?.beatKick;
  if (!outKick || !inKick || outKick.length < beatCount || inKick.length < beatCount) {
    return null;
  }
  const outTail = outKick.slice(-beatCount);
  const inHead = inKick.slice(0, beatCount);
  const kick = cosineSim(outTail, inHead);
  const outSnare = outgoingBars?.beatSnare;
  const inSnare = incomingBars?.beatSnare;
  const hasSnare =
    outSnare != null &&
    inSnare != null &&
    outSnare.length >= beatCount &&
    inSnare.length >= beatCount;
  const snare = hasSnare ? cosineSim(outSnare.slice(-beatCount), inSnare.slice(0, beatCount)) : 0;
  const outOnset = outgoingBars?.beatOnset;
  const inOnset = incomingBars?.beatOnset;
  const hasOnset =
    outOnset != null &&
    inOnset != null &&
    outOnset.length >= beatCount &&
    inOnset.length >= beatCount;
  const onset = hasOnset ? cosineSim(outOnset.slice(-beatCount), inOnset.slice(0, beatCount)) : 0;
  const kickVsSnare = hasSnare ? cosineSim(outTail, inSnare.slice(0, beatCount)) : 0;
  const snareVsKick = hasSnare ? cosineSim(outSnare.slice(-beatCount), inHead) : 0;
  // Kick dominates: in DnB the kick pattern is the rhythmic anchor. If kicks
  // don't lock, the gallop is immediate regardless of snare agreement.
  // Snare confirms but can't rescue a kick conflict. Calibrated on X-Ray
  // (rolling syncopation) → Somewhere (sparse big-hits): kick cosine 0.038,
  // snare 0.49 — the combined 50/50 score (0.53) didn't trigger the penalty,
  // but the user heard clear galloping.
  let score = 0.8 * kick + 0.3 * snare + 0.45 * onset - 0.7 * (kickVsSnare + snareVsKick);
  // Syncopation mismatch: the strongest gallop predictor. A straight two-step
  // blended with a syncopated two-step gallops under ANY alignment because
  // the off-grid hits fill the gaps the other track leaves empty. Penalize
  // proportionally to the syncopation gap (0 = both straight or both
  // syncopated, 0.3+ = one straight + one heavily syncopated).
  if (groove?.outgoingSyncopation != null && groove?.incomingSyncopation != null) {
    const syncGap = Math.abs(groove.outgoingSyncopation - groove.incomingSyncopation);
    if (syncGap > PLANNER_GROOVE_SYNCOPATION_TOLERANCE) {
      // Linear penalty above the tolerance zone
      score -=
        (syncGap - PLANNER_GROOVE_SYNCOPATION_TOLERANCE) * PLANNER_GROOVE_SYNCOPATION_PENALTY_SLOPE;
    }
  }
  return score;
}

/**
 * Sparse-overlap detection: measures whether the join region (outgoing tail +
 * incoming head) has enough rhythmic content for a phrase_mix blend to feel
 * continuous. Returns a penalty score where 0 = fine (enough rhythm on at
 * least one side) and negative = the overlap lacks a rhythmic thread.
 *
 * Two tiers:
 * - Both sides below 0.15 avg onsetDensity → strong penalty (no thread)
 * - Incoming below 0.05 (extremely sparse head) → moderate penalty (the
 *   incoming hasn't started; even a busy outgoing thins out in the blend)
 *
 * Calibrated on the Phase 4 test mix: all six user-identified problem joins
 * had sparse overlap regions; all "good" joins had ≥0.15 on at least one side.
 */
export function sparseOverlapPenalty(
  outgoingBars: { onsetDensity?: number[] } | null | undefined,
  incomingBars: { onsetDensity?: number[] } | null | undefined,
  barCount = 16,
): number {
  const outOnset = outgoingBars?.onsetDensity;
  const inOnset = incomingBars?.onsetDensity;
  if (!outOnset || !inOnset || outOnset.length === 0 || inOnset.length === 0) {
    return 0; // no data, no penalty
  }
  const outTail = outOnset.slice(-barCount);
  const inHead = inOnset.slice(0, barCount);
  const avg = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
  const outAvg = avg(outTail);
  const inAvg = avg(inHead);
  if (outAvg < 0.15 && inAvg < 0.15) return -1; // no rhythmic thread at all
  if (inAvg < 0.05) return -0.5; // incoming head is essentially silent
  return 0;
}

/** One side of an overlap-local groove window. */
export type LocalGrooveSide = {
  /** Per-bar backbone syncopation series (bars.syncopation). */
  syncopation?: Array<number | null>;
  bpm?: number | null;
  /** First downbeat time, the bar-series origin. */
  downbeat0Ms?: number | null;
  /** Start of the window in source time: mix-out minus the window length
   * for the outgoing side, mix-in for the incoming side. */
  windowStartMs: number;
};

function localSyncopation(side: LocalGrooveSide): number | null {
  const series = side.syncopation;
  const bpm = side.bpm;
  if (!Array.isArray(series) || series.length === 0 || !bpm || !(bpm > 0)) {
    return null;
  }
  const barMs = (4 * 60_000) / bpm;
  const origin = side.downbeat0Ms ?? 0;
  const fromBar = Math.round((side.windowStartMs - origin) / barMs);
  const slice = series.slice(
    Math.max(0, fromBar),
    Math.max(0, fromBar) + PLANNER_GROOVE_LOCAL_WINDOW_BARS,
  );
  const measured = slice.filter((v): v is number => v != null);
  // A drum-sparse window has no groove to conflict with; below two measured
  // bars the estimate is noise.
  if (measured.length < 2) {
    return null;
  }
  return measured.reduce((sum, v) => sum + v, 0) / measured.length;
}

/**
 * Overlap-local structural groove conflict: |syncopation gap| between the
 * outgoing's last bars before mix-out and the incoming's first bars after
 * mix-in, measured from the per-bar series. True only when BOTH sides are
 * locally measurable — a drum-sparse side cannot gallop against anything,
 * and whole-track averages demonstrably cannot separate praised joins
 * (LAMG→Barren 0.365 praised) from bad ones (X-Ray→Somewhere 0.400 gallops).
 */
export function structuralGrooveConflict(
  outgoing: LocalGrooveSide,
  incoming: LocalGrooveSide,
  threshold: number,
): boolean {
  const outSync = localSyncopation(outgoing);
  const inSync = localSyncopation(incoming);
  if (outSync == null || inSync == null) {
    return false;
  }
  return Math.abs(outSync - inSync) > threshold;
}
