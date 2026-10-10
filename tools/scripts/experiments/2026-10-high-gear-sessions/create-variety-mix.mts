/** Creates "High gear variety": same shape as High gear, variety against it,
 *  replanned until every join is a phrase_mix (no decisive conflicts). */
import { loadConfig } from "../../../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../../../packages/catalog/src/index.ts";
import {
  beatIndexAtOrAfter,
  grooveCompatibility,
  localBeatProfile,
} from "../../../../packages/catalog/src/planning/shared.ts";
import type { TimelineTrack } from "../../../../packages/catalog/src/planning/timeline.ts";

const SOURCE_PLAN_ID = "6b21e8fa-a597-4ea6-ad89-8a85490d3736";
const NEW_NAME = "High gear variety";

const config = loadConfig();
const runtime = createCatalogRuntime(config, undefined, { passive: true });
try {
  const source = runtime.setPlans.findById(SOURCE_PLAN_ID)!;
  const titleOf = new Map(runtime.repository.listAll().map((track) => [track.id, track.title]));

  const excluded = new Set<string>();
  let created: ReturnType<typeof runtime.service.createSetPlan> | null = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    created = runtime.service.createSetPlan({
      name: NEW_NAME,
      targetDurationMs: source.plan.targetDurationMs,
      requestedArc: source.plan.requestedArc,
      seed: 40 + attempt,
      variety: { referencePlanIds: [SOURCE_PLAN_ID], strength: 0.9 },
      ...(excluded.size > 0 ? { excludedTrackIds: [...excluded] } : {}),
    });
    const entries = [...created.plan.entries].sort((a, b) => a.order - b.order);
    const offenders: string[] = [];
    for (let i = 0; i < entries.length - 1; i += 1) {
      const type = entries[i]!.transitionToNext?.type;
      if (type && type !== "phrase_mix") {
        offenders.push(
          `join ${i} ${titleOf.get(entries[i]!.trackId)} -> ${titleOf.get(entries[i + 1]!.trackId)} [${type}]`,
        );
        // Exclude the incoming side so the next attempt picks a different pair.
        excluded.add(entries[i + 1]!.trackId);
      }
    }
    console.log(
      `attempt ${attempt}: ${entries.length} entries, ${offenders.length} non-blend join(s)${offenders.length > 0 ? ` — ${offenders.join("; ")}` : ""}`,
    );
    if (offenders.length === 0) break;
  }
  if (!created) process.exit(1);
  const entries = [...created.plan.entries].sort((a, b) => a.order - b.order);
  const overlap = new Set(entries.map((entry) => entry.trackId)).size;
  const sourceTracks = new Set(source.plan.entries.map((entry) => entry.trackId));
  const shared = entries.filter((entry) => sourceTracks.has(entry.trackId));
  console.log(
    `\nplan ${created.plan.id} "${NEW_NAME}" — ${entries.length} entries, ${overlap} distinct tracks`,
  );
  console.log(
    `overlap with High gear: ${shared.length} track(s): ${shared.map((e) => titleOf.get(e.trackId)).join(", ") || "none"}`,
  );

  // Report each join's overlap-local groove score so "no decisive conflict"
  // is verified by measurement, not just by template type.
  const timelines = new Map(
    runtime.repository
      .listAll()
      .map((track) => [track.id, runtime.service.toTimeline(track)] as const),
  );
  let worst: { label: string; score: number } | null = null;
  for (let i = 0; i < entries.length - 1; i += 1) {
    const transition = entries[i]!.transitionToNext!;
    const outTl = {
      ...runtime.repository.findById(entries[i]!.trackId)!,
      analysis: timelines.get(entries[i]!.trackId),
    } as TimelineTrack;
    const inTl = {
      ...runtime.repository.findById(entries[i + 1]!.trackId)!,
      analysis: timelines.get(entries[i + 1]!.trackId),
    } as TimelineTrack;
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
    const label = `${titleOf.get(entries[i]!.trackId)} -> ${titleOf.get(entries[i + 1]!.trackId)}`;
    if (score != null && (!worst || score < worst.score)) {
      worst = { label, score };
    }
    console.log(
      `  join ${i}: ${label} [${transition.type}] groove=${score == null ? "n/a" : score.toFixed(3)}`,
    );
  }
  if (worst) {
    console.log(
      `\nworst groove score: ${worst.score.toFixed(3)} (${worst.label}) — decisive bar is -0.450`,
    );
  }
} finally {
  await runtime.close();
}
