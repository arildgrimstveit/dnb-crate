/** Read-only mood-pool diagnosis. Copies the catalog, never renders. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";
import {
  createSetPlanInputSchema,
  genresMatchFilter,
  harmonicRelation,
  isConservativeHarmonic,
  loadConfig,
  matchesDescriptorFilters,
  resolveCanonicalKeyConfidence,
  resolveDescriptorFilters,
} from "../../packages/domain/src/index.ts";

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const briefPath = value("--brief") ?? "docs/examples/liquid-hour.example.brief.json";
const seed = Number(value("--seed") ?? 11);
const config = loadConfig();
const catalogSource = value("--catalog-snapshot") ?? config.databasePath;
const root = path.join(
  config.outputRoot,
  "reviews",
  `pool-diagnose-${new Date().toISOString().replaceAll(":", "-")}`,
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
try {
  const brief = createSetPlanInputSchema.parse(JSON.parse(await readFile(briefPath, "utf8")));
  const stats = runtime.service.getLibraryStats();
  const filters = resolveDescriptorFilters(brief.descriptors, stats.descriptorPercentiles);
  const excluded = new Set(brief.excludedTrackIds ?? []);
  const excludedArtists = new Set((brief.excludedArtists ?? []).map((item) => item.toLowerCase()));
  const tracks = runtime.repository.listAll();
  const eligible = tracks.filter((track) => {
    if (track.fileMissing || excluded.has(track.id)) return false;
    const artist = (track.artistCanonical ?? track.artist ?? "").toLowerCase();
    if (artist && excludedArtists.has(artist)) return false;
    const analysis = runtime.analyses.findByTrackId(track.id);
    const descriptors = analysis?.descriptors ?? null;
    if (!matchesDescriptorFilters(track, descriptors, filters).ok) return false;
    if (!genresMatchFilter(track.genres, brief.genres).ok) return false;
    return true;
  });

  const usable = eligible.map((track) => {
    const analysis = runtime.analyses.findByTrackId(track.id);
    const keyRow = runtime.analyses.findKeyAnalysis(track.id) ?? analysis;
    const keyConfidence = resolveCanonicalKeyConfidence(track, keyRow);
    return {
      id: track.id,
      title: track.title,
      artist: track.artist,
      camelot: track.camelotKey,
      keySource: track.keySource,
      keyConfidence,
      gridOk: analysis != null && analysis.gridRejected === false,
      keyOk: keyConfidence >= 0.5 && track.camelotKey != null,
    };
  });
  const planningReady = usable.filter((row) => row.gridOk && row.keyOk);
  const keys = [...new Set(planningReady.map((row) => row.camelot).filter(Boolean))] as string[];
  const neighbors = new Map<string, string[]>();
  for (const key of keys) {
    neighbors.set(
      key,
      keys.filter((other) => isConservativeHarmonic(harmonicRelation(key, other))),
    );
  }
  const seen = new Set<string>();
  const components: Array<{ keys: string[]; tracks: number }> = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    const stack = [key];
    const group: string[] = [];
    while (stack.length) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      group.push(current);
      for (const next of neighbors.get(current) ?? []) stack.push(next);
    }
    components.push({
      keys: group.sort(),
      tracks: planningReady.filter((row) => row.camelot && group.includes(row.camelot)).length,
    });
  }
  components.sort((a, b) => b.tracks - a.tracks);

  const created = runtime.service.createSetPlan({
    ...brief,
    seed,
    name: `${brief.name} / pool diagnose seed ${seed}`,
  });
  const report = {
    brief: briefPath,
    catalogSource,
    seed,
    thresholds: filters,
    pool: {
      catalog: tracks.length,
      eligible: eligible.length,
      usableGrid: usable.filter((row) => row.gridOk).length,
      usableKey: usable.filter((row) => row.keyOk).length,
      planningReady: planningReady.length,
      keySources: usable.reduce<Record<string, number>>((counts, row) => {
        const source = row.keySource ?? "none";
        counts[source] = (counts[source] ?? 0) + 1;
        return counts;
      }, {}),
      selectedKeyEngines: eligible.reduce<Record<string, number>>((counts, track) => {
        const engine = runtime.analyses.getSelection(track.id)?.keyEngine ?? "default";
        counts[engine] = (counts[engine] ?? 0) + 1;
        return counts;
      }, {}),
      keyedBelowGate: usable.filter((row) => row.camelot && !row.keyOk).length,
    },
    components,
    largestComponent: components[0] ?? null,
    plan: {
      ready: created.quality.readyForAudition,
      durationMs: created.quality.durationMs,
      tracks: created.plan.entries.length,
      partialReasons: created.quality.partialReasons,
      types: created.quality.typeCounts,
      harmonic: created.quality.harmonicCounts,
      repairSearch: created.explanation.repairSearch,
      prefix: created.plan.entries.map((entry) => {
        const track = tracks.find((item) => item.id === entry.trackId);
        return {
          title: track?.title ?? entry.trackId,
          camelot: track?.camelotKey,
        };
      }),
    },
    scope:
      "Descriptor percentiles and genre exclusions are unchanged. This is not a proof that no hour exists.",
  };
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ root, ...report, plan: { ...report.plan, prefix: report.plan.prefix } }),
  );
} finally {
  await runtime.close();
}
