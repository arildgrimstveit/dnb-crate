/** Plan-only, serial seed evaluation against an isolated snapshot. Never renders. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";
import { createSetPlanInputSchema, loadConfig } from "../../packages/domain/src/index.ts";

const args = process.argv.slice(2);
const values = (flag: string) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]!] : []));
const briefs = values("--brief");
const raw = values("--seeds")[0] ?? "1:3";
const seeds = raw.includes(":")
  ? (() => {
      const [a, b] = raw.split(":").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || b! < a! || b! - a! > 19)
        throw new Error("Use an ascending range of at most 20 seeds");
      return Array.from({ length: b! - a! + 1 }, (_, i) => a! + i);
    })()
  : raw.split(",").map(Number);
if (
  !briefs.length ||
  seeds.length > 20 ||
  seeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0)
)
  throw new Error(
    "Usage: search-set-plans.mts --brief path [--brief path] --seeds 1:3 [--first-ready]",
  );
const config = loadConfig();
const catalogSource = values("--catalog-snapshot")[0] ?? config.databasePath;
const root = path.join(
  config.outputRoot,
  "reviews",
  `planner-search-${new Date().toISOString().replaceAll(":", "-")}`,
);
await mkdir(root, { recursive: true });
const snapshot = path.join(root, "catalog.sqlite");
const db = new DatabaseSync(catalogSource, { readOnly: true });
try {
  await backup(db, snapshot);
} finally {
  db.close();
}
const runtime = createCatalogRuntime(
  { ...config, databasePath: snapshot, outputRoot: root },
  undefined,
  { passive: true },
);
type Attempt = { brief: string; seed: number; ready: boolean; error?: string; trackIds?: string[] };
const attempts: Attempt[] = [];
console.log(JSON.stringify({ root, mode: "plan-only", catalogSource, seeds, briefs }));
try {
  const tracks = new Map(runtime.repository.listAll().map((t) => [t.id, t]));
  for (const [briefIndex, file] of briefs.entries()) {
    const brief = createSetPlanInputSchema.parse(JSON.parse(await readFile(file, "utf8")));
    const references = [...(brief.variety?.referencePlanIds ?? []), ...values("--reference-plan")];
    await writeFile(path.join(root, `brief-${briefIndex}.json`), JSON.stringify(brief, null, 2));
    for (const seed of seeds) {
      const started = performance.now();
      try {
        const result = runtime.service.createSetPlan({
          ...brief,
          seed,
          name: `${brief.name} / evaluation seed ${seed}`,
          ...(references.length
            ? { variety: { ...brief.variety, referencePlanIds: references.slice(-20) } }
            : {}),
        });
        const q = result.quality;
        const artifact = `plan-${briefIndex}-${seed}.json`;
        await writeFile(path.join(root, artifact), JSON.stringify(result, null, 2));
        const row = {
          brief: file,
          seed,
          planId: result.plan.id,
          artifact,
          ready: q.readyForAudition,
          quality: q.qualityChecksPassed,
          partial: q.partial,
          reasons: q.partialReasons,
          unsatisfiedRequiredTransitions: q.unsatisfiedRequiredTransitions,
          durationMs: q.durationMs,
          tracks: result.plan.entries.length,
          harmonic: q.harmonicCounts,
          types: q.typeCounts,
          spacingViolations: q.artistSpacingViolations.length,
          repairSearch: result.explanation.repairSearch,
          chainRetry: result.explanation.chainRetry,
          elapsedMs: Math.round(performance.now() - started),
          trackIds: result.plan.entries.map((e) => e.trackId),
          lineup: result.plan.entries.map((e) => tracks.get(e.trackId)?.title ?? e.trackId),
          variety: result.explanation.variety,
          continuity: q.joins.map((join) => join.continuity ?? null),
        };
        attempts.push(row);
        if (args.includes("--diversify") && row.ready) references.push(result.plan.id);
        console.log(
          JSON.stringify({
            ...row,
            trackIds: undefined,
            lineup: undefined,
            continuity: undefined,
            variety: row.variety
              ? {
                  repeatedTracks: row.variety.repeatedTracks,
                  repeatedPairs: row.variety.repeatedPairs,
                }
              : undefined,
          }),
        );
        if (args.includes("--first-ready") && row.ready) break;
      } catch (error) {
        const row = {
          brief: file,
          seed,
          error: String(error),
          ready: false,
          elapsedMs: Math.round(performance.now() - started),
        };
        attempts.push(row);
        console.log(JSON.stringify(row));
      }
      await writeFile(path.join(root, "attempts.json"), JSON.stringify(attempts, null, 2));
    }
  }
  const summaries = briefs.map((brief) => {
    const rows = attempts.filter((a) => a.brief === brief);
    const readyRows = rows.filter((a) => a.ready);
    const recording = (id: string) => tracks.get(id)?.recordingKey ?? id;
    const trackSets = readyRows.map((row) => new Set<string>((row.trackIds ?? []).map(recording)));
    const pairSets = readyRows.map(
      (row) =>
        new Set<string>(
          (row.trackIds ?? [])
            .slice(1)
            .map((id: string, i: number) => `${recording(row.trackIds![i]!)}->${recording(id)}`),
        ),
    );
    const comparisons = readyRows.flatMap((row, i) =>
      readyRows.slice(i + 1).map((other, offset) => {
        const j = i + offset + 1;
        const shared = [...trackSets[i]!].filter((id) => trackSets[j]!.has(id)).length;
        return {
          seeds: [row.seed, other.seed],
          sharedRecordings: shared,
          recordingJaccard:
            shared / Math.max(1, new Set([...trackSets[i]!, ...trackSets[j]!]).size),
          sharedPairs: [...pairSets[i]!].filter((id) => pairSets[j]!.has(id)).length,
        };
      }),
    );
    return {
      brief,
      attempts: rows.length,
      ready: rows.filter((a) => a.ready).length,
      errors: rows.filter((a) => a.error).length,
      distinctLineups: new Set(rows.filter((a) => a.trackIds).map((a) => a.trackIds!.join("|")))
        .size,
      uniqueTracks: new Set(rows.flatMap((a) => a.trackIds ?? [])).size,
      readyUniqueRecordings: new Set(trackSets.flatMap((set) => [...set])).size,
      readyUniquePairs: new Set(pairSets.flatMap((set) => [...set])).size,
      comparisons,
    };
  });
  await writeFile(path.join(root, "attempts.json"), JSON.stringify(attempts, null, 2));
  await writeFile(
    path.join(root, "summary.json"),
    JSON.stringify(
      {
        mode: "plan-only",
        catalogSource,
        liveCatalogUnchanged: true,
        summaries,
        scope: "Small deterministic sample; no audio listening and no proof of infeasibility.",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ root, summaries }));
} finally {
  await runtime.close();
}
