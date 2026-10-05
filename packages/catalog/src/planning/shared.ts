import { normalizePersonName, type Track } from "@dnb-crate/domain";

/** Canonical artist identity for spacing/penalties: the published canonical
 * name when present, else the normalized artist. Shared by the planner and
 * the quality report so both agree on who counts as "the same artist". */
export function artistKey(track: Track): string | null {
  if (track.artistCanonical) {
    return track.artistCanonical;
  }
  return track.artist ? normalizePersonName(track.artist) : null;
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
  return kick + snare + 0.45 * onset - 0.7 * (kickVsSnare + snareVsKick);
}
