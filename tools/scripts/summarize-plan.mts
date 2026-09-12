import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";
import { camelotDistance, harmonicRelation, loadConfig } from "../../packages/domain/src/index.ts";

const planId = process.argv[2];
if (!planId) {
  throw new Error("usage: summarize-plan.mts <planId>");
}
const runtime = createCatalogRuntime(loadConfig(), undefined, { passive: true });
const plan = runtime.service.getSetPlan(planId);
const tracks = new Map(runtime.repository.listAll().map((track) => [track.id, track]));
const rows = plan.entries.map((entry, index) => {
  const track = tracks.get(entry.trackId);
  const next = plan.entries[index + 1];
  const nextTrack = next ? tracks.get(next.trackId) : null;
  const trans = entry.transitionToNext;
  const playable = entry.sourceEndMs - entry.sourceStartMs;
  return {
    i: index,
    artist: track?.artist,
    title: track?.title,
    key: track?.musicalKey,
    camelot: track?.camelotKey,
    keySource: track?.keySource,
    bpm: track?.bpm,
    playable,
    rate: Number(entry.playbackRate.toFixed(4)),
    type: trans?.type ?? null,
    bars: trans?.parameters.barCount ?? null,
    reason: trans?.parameters.reason ?? null,
    intent: trans?.parameters.intent ?? null,
    shape: trans?.parameters.phraseShape ?? null,
    keyClash: trans?.parameters.keyClash ?? false,
    relation: nextTrack ? harmonicRelation(track?.camelotKey ?? null, nextTrack.camelotKey) : null,
    camelotDist: nextTrack
      ? camelotDistance(track?.camelotKey ?? null, nextTrack.camelotKey)
      : null,
  };
});
const last = plan.entries.at(-1);
const durationMs = last
  ? last.timelineStartMs + (last.sourceEndMs - last.sourceStartMs) / last.playbackRate
  : 0;
await runtime.close();
console.log(
  JSON.stringify(
    {
      planId: plan.id,
      name: plan.name,
      tracks: rows.length,
      durationMs: Math.round(durationMs),
      keyed: rows.filter((row) => row.key).length,
      keyClashJoins: rows.filter((row) => row.keyClash).length,
      rows,
    },
    null,
    2,
  ),
);
