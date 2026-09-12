/** Recreate a brief/seed in the live catalog and compare join payloads to a snapshot plan. Never renders. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";
import { createSetPlanInputSchema, loadConfig, type SetPlanEntry, type SetPlanV1 } from "../../packages/domain/src/index.ts";

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const briefPath = value("--brief");
const snapshotPlanPath = value("--snapshot-plan");
const seed = Number(value("--seed") ?? "12");
if (!briefPath || !snapshotPlanPath || !Number.isSafeInteger(seed)) {
  throw new Error(
    "Usage: recreate-and-compare-plan.mts --brief path --snapshot-plan path --seed 12",
  );
}

const joinPayload = (entries: SetPlanEntry[], index: number) => {
  const outgoing = entries[index]!;
  const incoming = entries[index + 1]!;
  const t = outgoing.transitionToNext;
  return {
    outgoingTrackId: outgoing.trackId,
    incomingTrackId: incoming.trackId,
    type: t?.type ?? null,
    barCount: t?.parameters.barCount ?? null,
    phraseShape: t?.parameters.phraseShape ?? null,
    sequentialHandoff: t?.parameters.sequentialHandoff ?? null,
    intent: t?.parameters.intent ?? null,
    appliedRecipeId: t?.parameters.appliedRecipeId ?? null,
    overlapMs: t?.durationMs ?? null,
    targetBpm: t?.parameters.targetBpm ?? null,
    outgoingSourceStartMs: outgoing.sourceStartMs,
    outgoingSourceEndMs: outgoing.sourceEndMs,
    incomingSourceStartMs: incoming.sourceStartMs,
    incomingSourceEndMs: incoming.sourceEndMs,
    outgoingRate: outgoing.playbackRate,
    incomingRate: incoming.playbackRate,
    outgoingGainDb: outgoing.gainDb,
    incomingGainDb: incoming.gainDb,
  };
};

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

const config = loadConfig();
const snapshot = JSON.parse(await readFile(snapshotPlanPath, "utf8")) as {
  plan: SetPlanV1;
  quality?: { readyForAudition?: boolean; durationMs?: number };
};
const briefJson = JSON.parse(await readFile(briefPath, "utf8")) as { name: string };
const brief = createSetPlanInputSchema.parse({
  ...briefJson,
  seed,
  name: `${briefJson.name} / live recreate seed ${seed}`,
});

const runtime = createCatalogRuntime(config);
const root = path.join(
  config.outputRoot,
  "reviews",
  `recreate-${new Date().toISOString().replaceAll(":", "-")}`,
);
await mkdir(root, { recursive: true });
try {
  const created = runtime.service.createSetPlan(brief);
  const tracks = new Map(runtime.repository.listAll().map((track) => [track.id, track]));
  const title = (id: string) => {
    const track = tracks.get(id);
    return track ? `${track.artist ?? "Unknown"} – ${track.title}` : id;
  };
  const snapshotJoins = snapshot.plan.entries
    .slice(0, -1)
    .map((_, index) => joinPayload(snapshot.plan.entries, index));
  const liveJoins = created.plan.entries
    .slice(0, -1)
    .map((_, index) => joinPayload(created.plan.entries, index));
  const lineupMatch =
    snapshot.plan.entries.length === created.plan.entries.length &&
    snapshot.plan.entries.every((entry, index) => entry.trackId === created.plan.entries[index]?.trackId);
  const joinDiffs = snapshotJoins.flatMap((frozen, index) => {
    const live = liveJoins[index];
    if (!live) return [{ index, kind: "missing-live", frozen, live: null }];
    if (same(frozen, live)) return [];
    const fields = Object.keys(frozen) as Array<keyof typeof frozen>;
    return [
      {
        index,
        pair: `${title(frozen.outgoingTrackId)} → ${title(frozen.incomingTrackId)}`,
        changes: fields
          .filter((field) => !same(frozen[field], live[field]))
          .map((field) => ({ field, snapshot: frozen[field], live: live[field] })),
      },
    ];
  });
  if (liveJoins.length > snapshotJoins.length) {
    joinDiffs.push({
      index: snapshotJoins.length,
      pair: "extra live joins",
      changes: [{ field: "count", snapshot: snapshotJoins.length, live: liveJoins.length }],
    });
  }
  const report = {
    mode: "plan-only",
    brief: briefPath,
    snapshotPlan: snapshotPlanPath,
    seed,
    livePlanId: created.plan.id,
    snapshotReady: snapshot.quality?.readyForAudition ?? null,
    liveReady: created.quality.readyForAudition,
    snapshotDurationMs: snapshot.quality?.durationMs ?? null,
    liveDurationMs: created.quality.durationMs,
    snapshotTracks: snapshot.plan.entries.length,
    liveTracks: created.plan.entries.length,
    lineupMatch,
    joinPayloadMatch: joinDiffs.length === 0,
    liveQuality: {
      qualityChecksPassed: created.quality.qualityChecksPassed,
      partial: created.quality.partial,
      partialReasons: created.quality.partialReasons,
      unsatisfiedRequiredTransitions: created.quality.unsatisfiedRequiredTransitions,
      harmonic: created.quality.harmonicCounts,
      types: created.quality.typeCounts,
      spacingViolations: created.quality.artistSpacingViolations.length,
    },
    liveLineup: created.plan.entries.map((entry) => title(entry.trackId)),
    snapshotLineup: snapshot.plan.entries.map((entry) => title(entry.trackId)),
    joinDiffs,
    rendered: false,
  };
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(root, "live-plan.json"), JSON.stringify(created, null, 2));
  console.log(JSON.stringify({ root, ...report, liveLineup: report.liveLineup, snapshotLineup: report.snapshotLineup }));
} finally {
  runtime.close();
}
