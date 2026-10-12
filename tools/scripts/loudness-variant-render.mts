import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  createNodeProcessRunner,
  detectFfmpeg,
  measureLoudnessSeries,
} from "../../packages/audio-renderer/src/index.ts";
import {
  loadConfig,
  solveSetGains,
  windowShortTermLoudness,
  type ResolvedJoinContext,
  type SetPlanV1,
} from "../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";

/**
 * Q04 variant render (13 October 2026): render one stored set plan under
 * the joint attenuate-first body-gain solver's proposal, as an A/B against
 * the existing render. The original plan is untouched: a clearly-named
 * CLONE carries the proposed gains and renders through the normal full
 * pipeline; the master and listen copies are then published under
 * friendly names in output/renders for owner auditioning.
 *
 * Usage: pnpm tsx tools/scripts/loudness-variant-render.mts <setPlanId>
 */

const planId = process.argv[2];
if (!planId) {
  console.error("usage: loudness-variant-render.mts <setPlanId>");
  process.exit(1);
}

const config = loadConfig();
const runtime = createCatalogRuntime(config);

try {
  const stored = runtime.setPlans.findById(planId);
  if (!stored) {
    console.error(`no plan ${planId}`);
    process.exit(1);
  }
  const plan = stored.plan;
  const sorted = [...plan.entries].sort((a, b) => a.order - b.order);
  console.log(`plan: ${plan.name} (${sorted.length} entries)`);

  // Measure each entry's playable body window on the original stereo
  // signal (the advisory-report measurement, reused here).
  const runner = createNodeProcessRunner();
  const binaries = await detectFfmpeg(runner, {
    ffmpegPath: process.env.FFMPEG_PATH ?? config.ffmpegPath ?? "ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH ?? config.ffprobePath ?? "ffprobe",
  });
  if (!binaries) {
    console.error("ffmpeg unavailable");
    process.exit(1);
  }
  const solverEntries = [];
  const byId = new Map<string, { title: string; bodyLufs: number | null }>();
  for (const entry of sorted) {
    const track = runtime.repository.findById(entry.trackId);
    if (!track) {
      continue;
    }
    const analysis = runtime.analyses.findByTrackId(entry.trackId);
    const series = await measureLoudnessSeries(runner, binaries, track.filePath);
    const shortTermLufs = series.frames.map((frame) => frame.shortTermLufs);
    const body = windowShortTermLoudness(
      { hopMs: series.hopMs, shortTermLufs },
      { startMs: entry.sourceStartMs, endMs: entry.sourceEndMs },
    );
    solverEntries.push({
      id: entry.id,
      bodyShortTermLufs: body?.medianLufs ?? null,
      truePeakDb: analysis?.truePeakDb ?? null,
      currentGainDb: entry.gainDb,
    });
    byId.set(entry.id, { title: track.title, bodyLufs: body?.medianLufs ?? null });
  }
  const solution = solveSetGains(solverEntries);
  console.log(
    `solver reference: ${solution.referenceLufs} LUFS, total boost ${solution.totalBoostDb} dB`,
  );
  const gainById = new Map(solution.gains.map((g) => [g.id, g.gainDb]));

  // Clone the plan under a clear A/B name with the proposed gains. Entry
  // IDs are re-minted (they are primary keys across plans) and the
  // stamped resolved-join contracts follow the re-minted pair identity.
  const variantName = `${plan.name} (body-gain A/B)`;
  // Idempotent: replace any previous clone with the same name (the tool
  // mints a fresh plan each run, so stale clones would otherwise pile up).
  const existing = runtime.setPlans.list(100, undefined);
  for (const summary of existing.plans) {
    if (summary.name === variantName) {
      runtime.service.deleteSetPlan(summary.id, true);
      console.log(`replaced previous variant plan ${summary.id}`);
    }
  }
  const idMap = new Map(sorted.map((entry) => [entry.id, crypto.randomUUID()]));
  const variant: SetPlanV1 = {
    ...plan,
    id: crypto.randomUUID(),
    name: variantName,
    entries: sorted.map((entry, index) => {
      const next = sorted[index + 1];
      const transition = entry.transitionToNext;
      const stamped = transition?.parameters.resolvedJoin;
      const stampedContract =
        stamped != null && typeof stamped === "object"
          ? (stamped as { outgoingEntryId: string; incomingEntryId: string })
          : null;
      return {
        ...entry,
        id: idMap.get(entry.id)!,
        gainDb: gainById.get(entry.id) ?? entry.gainDb,
        transitionToNext:
          transition && stampedContract
            ? {
                ...transition,
                parameters: {
                  ...transition.parameters,
                  resolvedJoin: {
                    ...(stampedContract as ResolvedJoinContext),
                    outgoingEntryId: idMap.get(entry.id)!,
                    incomingEntryId: next ? idMap.get(next.id)! : stampedContract.incomingEntryId,
                  } as ResolvedJoinContext,
                },
              }
            : transition
              ? { ...transition }
              : null,
      };
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  runtime.setPlans.save(variant, 1, {
    seed: 1,
    selected: [],
    rejected: [],
    harmonicCoverage: { knownJoins: 0, totalJoins: 0 },
  });
  console.log(`variant plan saved: ${variant.name}`);

  let changed = 0;
  for (let i = 0; i < variant.entries.length; i += 1) {
    if (Math.abs(variant.entries[i]!.gainDb - sorted[i]!.gainDb) > 0.05) {
      changed += 1;
    }
  }
  console.log(`gains changed on ${changed}/${variant.entries.length} entries`);

  const render = await runtime.service.startSetRender({
    setPlanId: variant.id,
    allowLowConfidence: true,
  });
  console.log(`render job ${render.job.id} started...`);
  const done = await runtime.service.waitForRenderJob(render.job.id, 60 * 60 * 1000);
  if (done.status !== "succeeded" || !done.outputRootRelativePath) {
    console.error(`render ${done.status}: ${done.errorMessage}`);
    process.exit(1);
  }

  // Publish friendly-named copies of the master and listen artifacts.
  const slug = plan.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const rendersRoot = config.outputRoot;
  await mkdir(rendersRoot, { recursive: true });
  const masterSrc = path.join(rendersRoot, done.outputRootRelativePath);
  const masterDst = path.join(rendersRoot, "renders", `${slug}-body-gain.flac`);
  await copyFile(masterSrc, masterDst);
  console.log(`master: ${masterDst}`);
  if (done.listenRootRelativePath) {
    const listenSrc = path.join(rendersRoot, done.listenRootRelativePath);
    const listenInfo = await stat(listenSrc).catch(() => null);
    if (listenInfo) {
      const listenDst = path.join(rendersRoot, "renders", `${slug}-body-gain-listen.flac`);
      await copyFile(listenSrc, listenDst);
      console.log(`listen: ${listenDst}`);
    }
  }
  console.log("\nA/B guidance: audition against the original at MATCHED playback volume;");
  console.log("the variant only changes per-deck entry gains (all attenuation, zero boost).");
} finally {
  await runtime.close();
}
