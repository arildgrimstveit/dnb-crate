import {
  recipeApplicability,
  reusableRecipeFingerprint,
  RENDERER_VERSION,
  type ApprovedRecipeRecord,
  type SetPlanEntry,
  type Track,
} from "@dnb-crate/domain";

/** Verify the actual audible join; featured context outside the join may differ. */
export function verifiesAppliedRecipe(
  record: ApprovedRecipeRecord,
  outgoing: SetPlanEntry,
  incoming: SetPlanEntry,
  a: Track,
  b: Track,
): boolean {
  const transition = outgoing.transitionToNext;
  if (!transition || record.status === "unreviewed_candidate") return false;
  const actual = transition.parameters;
  const expected = record.payload;
  if (
    actual.appliedRecipeId !== record.id ||
    actual.appliedRecipeFingerprint !== record.reusableFingerprint ||
    reusableRecipeFingerprint(expected) !== record.reusableFingerprint
  )
    return false;
  if (
    !recipeApplicability(expected, {
      outgoingTrackId: a.id,
      incomingTrackId: b.id,
      outgoingSourceFingerprint: a.fileFingerprint,
      incomingSourceFingerprint: b.fileFingerprint,
      outgoingRate: outgoing.playbackRate,
      incomingRate: incoming.playbackRate,
      outgoingDurationMs: a.durationMs,
      incomingDurationMs: b.durationMs,
      engine: {
        rendererVersion: RENDERER_VERSION,
        tempoEngine: "rubberband-r3",
        stretchScope: "overlap",
      },
      selectedEvidence: null,
    }).ok
  )
    return false;
  const near = (x: number, y: number) => Math.abs(x - y) <= 0.051;
  if (
    transition.type !== expected.type ||
    !near(transition.durationMs, expected.durationMs) ||
    !near(Number(actual.mixOutMs), expected.mixOutMs) ||
    !near(Number(actual.mixInMs), expected.mixInMs) ||
    !near(incoming.sourceStartMs, expected.mixInMs) ||
    !near(outgoing.sourceEndMs, expected.outgoingSourceEndMs) ||
    incoming.sourceEndMs < incoming.sourceStartMs + transition.durationMs * incoming.playbackRate ||
    outgoing.sourceStartMs > expected.mixOutMs
  )
    return false;
  if (
    actual.barCount !== expected.barCount ||
    actual.phraseShape !== expected.phraseShape ||
    actual.intent !== expected.intent ||
    (actual.sequentialHandoff ?? "legacy") !== expected.sequentialHandoff
  )
    return false;
  for (const key of [
    "targetBpm",
    "crossoverHz",
    "swapAtBar",
    "lowHandoverBar",
    "rampMs",
    "lowAttenuationDb",
    "midDipDb",
    "incomingDropMs",
    "downbeatOffsetMs",
    "rateRegionsVersion",
  ]) {
    const fallback = key === "downbeatOffsetMs" ? 0 : undefined;
    if ((actual[key] ?? fallback) !== (expected.parameters[key] ?? fallback)) return false;
  }
  return near(outgoing.gainDb - expected.outgoingGainDb, incoming.gainDb - expected.incomingGainDb);
}
