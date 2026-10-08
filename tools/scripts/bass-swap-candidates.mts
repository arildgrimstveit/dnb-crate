/**
 * Noise-era bass-swap candidates (post-calibration follow-up): stored
 * bass_swap joins that the tightened decisive-conflict trigger would NOT
 * select today (overlap-local groove score above -0.45) and that carry no
 * liked feedback or applied recipe for the pair — the unprotected residue
 * of the old `groove < 0.0` bar. Read-only; nothing is changed.
 *
 * Usage: pnpm tsx tools/scripts/bass-swap-candidates.mts
 */
import { loadConfig } from "../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";
import {
  beatIndexAtOrAfter,
  grooveCompatibility,
  localBeatProfile,
} from "../../packages/catalog/src/planning/shared.ts";
import type { TimelineTrack } from "../../packages/catalog/src/planning/timeline.ts";

const config = loadConfig();
const runtime = createCatalogRuntime(config, undefined, { passive: true });
try {
  const tracks = runtime.repository.listAll();
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const timelines = new Map(
    tracks.map((track) => [track.id, runtime.service.toTimeline(track)] as const),
  );
  const summaries = runtime.setPlans.list(50).plans;
  const seen = new Set<string>();
  const rows: Array<{
    plan: string;
    outgoing: string;
    incoming: string;
    score: number;
    protectedBy: string | null;
  }> = [];
  for (const summary of summaries) {
    let stored: ReturnType<typeof runtime.setPlans.findById>;
    try {
      stored = runtime.setPlans.findById(summary.id);
    } catch {
      continue;
    }
    if (!stored) continue;
    const entries = [...stored.plan.entries].sort((a, b) => a.order - b.order);
    for (let i = 0; i < entries.length - 1; i += 1) {
      const transition = entries[i]!.transitionToNext;
      if (transition?.type !== "bass_swap") continue;
      const outTrack = byId.get(entries[i]!.trackId);
      const inTrack = byId.get(entries[i + 1]!.trackId);
      if (!outTrack || !inTrack) continue;
      const key = `${outTrack.id}|${inTrack.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Protection: liked pair feedback or an applied recipe on the join.
      const feedback = runtime.service.listTransitionFeedback({
        outgoingTrackId: outTrack.id,
        incomingTrackId: inTrack.id,
      }).ratings;
      const liked = feedback.some((row) => typeof row.overall === "number" && row.overall >= 0.7);
      const recipe = typeof transition.parameters.appliedRecipeId === "string" ? "recipe" : null;
      const protectedBy = liked ? "liked feedback" : recipe;

      // Overlap-local trigger score at the stored join's own window.
      const outTl = { ...outTrack, analysis: timelines.get(outTrack.id) } as TimelineTrack;
      const inTl = { ...inTrack, analysis: timelines.get(inTrack.id) } as TimelineTrack;
      const mixOut = transition.parameters.mixOutMs;
      const mixIn = transition.parameters.mixInMs;
      const bars =
        typeof transition.parameters.barCount === "number" ? transition.parameters.barCount : 16;
      let score: number | null = null;
      if (typeof mixOut === "number" && typeof mixIn === "number") {
        const outProfile = outTl.analysis?.bars;
        const inProfile = inTl.analysis?.bars;
        const outStart =
          outTl.analysis?.beatTimesMs && outProfile
            ? beatIndexAtOrAfter(outTl.analysis.beatTimesMs, mixOut)
            : null;
        const inStart =
          inTl.analysis?.beatTimesMs && inProfile
            ? beatIndexAtOrAfter(inTl.analysis.beatTimesMs, mixIn)
            : null;
        if (outProfile && inProfile && outStart != null && inStart != null) {
          score = grooveCompatibility(
            localBeatProfile(outProfile, outStart),
            localBeatProfile(inProfile, inStart),
            bars * 4,
            {
              outgoingSyncopation: outTl.analysis?.descriptors?.grooveSyncopation ?? null,
              incomingSyncopation: inTl.analysis?.descriptors?.grooveSyncopation ?? null,
            },
            { positioned: true },
          );
        }
      }
      rows.push({
        plan: stored.plan.name,
        outgoing: outTrack.title,
        incoming: inTrack.title,
        score: score ?? Number.NaN,
        protectedBy,
      });
    }
  }
  const unprotected = rows.filter((row) => row.protectedBy == null);
  const candidates = unprotected.filter((row) => Number.isFinite(row.score) && row.score >= -0.45);
  const stillDecisive = unprotected.filter((row) => row.score < -0.45);
  console.log(
    `stored bass_swap joins: ${rows.length} distinct pairs across ${summaries.length} plans`,
  );
  console.log(`  protected (liked feedback / recipe): ${rows.length - unprotected.length}`);
  console.log(
    `  unprotected and WOULD NOT auto-swap today (score >= -0.45): ${candidates.length}  <-- re-audition candidates`,
  );
  console.log(`  unprotected and still decisive (score < -0.45): ${stillDecisive.length}`);
  console.log("\nCandidates (most mild first):");
  for (const row of candidates.sort((a, b) => b.score - a.score)) {
    console.log(`  ${row.score.toFixed(3)}  ${row.outgoing} -> ${row.incoming}  (${row.plan})`);
  }
  if (stillDecisive.length > 0) {
    console.log("\nStill decisive (leave as bass_swap):");
    for (const row of stillDecisive.sort((a, b) => a.score - b.score)) {
      console.log(`  ${row.score.toFixed(3)}  ${row.outgoing} -> ${row.incoming}  (${row.plan})`);
    }
  }
} finally {
  await runtime.close();
}
