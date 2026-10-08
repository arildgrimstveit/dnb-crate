/**
 * Audition previews for the F3 groove-decision flips (batch 3 follow-up).
 *
 * For each requested track pair, finds the most recent stored plan containing
 * that adjacency and renders TWO previews of the same saved join: the stored
 * treatment (OLD) and the fresh planner's template choice (NEW), with the
 * stored windows frozen so only the treatment varies. Copies both into
 * output/audition-<date>/ with a listening sheet.
 *
 * Usage: pnpm tsx tools/scripts/audition-previews.mts
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";

type PairSpec = {
  outgoing: string;
  incoming: string;
  newTemplate: "phrase_mix" | "bass_swap" | "crossfade";
  note: string;
};

const PAIRS: PairSpec[] = [
  {
    outgoing: "Hayling",
    incoming: "Pieces",
    newTemplate: "bass_swap",
    note: "groove-kick-conflict: fresh planner swaps the low end",
  },
  {
    outgoing: "Red Velvet",
    incoming: "Miami",
    newTemplate: "bass_swap",
    note: "groove-kick-conflict: fresh planner swaps the low end",
  },
  {
    outgoing: "Moment to Moment",
    incoming: "Better Perspective",
    newTemplate: "bass_swap",
    note: "groove-kick-conflict: fresh planner swaps the low end",
  },
  {
    outgoing: "Still in Love",
    incoming: "Pathways",
    newTemplate: "bass_swap",
    note: "groove-kick-conflict: fresh planner swaps the low end",
  },
  {
    outgoing: "Coming Down",
    incoming: "In the Woods",
    newTemplate: "bass_swap",
    note: "groove-kick-conflict: fresh planner swaps the low end",
  },
  {
    outgoing: "Signs",
    incoming: "Picton Blues",
    newTemplate: "phrase_mix",
    note: "fresh planner keeps the blend (no kick conflict)",
  },
  {
    outgoing: "Pathways",
    incoming: "All Our Yesterdays",
    newTemplate: "phrase_mix",
    note: "fresh planner keeps the blend (no kick conflict)",
  },
];

const config = loadConfig();
const runtime = createCatalogRuntime(config, undefined, {});
const date = new Date().toISOString().slice(0, 10);
const outDir = path.join(config.outputRoot, `audition-${date}`);
await mkdir(outDir, { recursive: true });

type JoinHit = {
  planId: string;
  planName: string;
  transitionId: string;
  storedType: string;
  outgoingTitle: string;
  incomingTitle: string;
  updatedAt: string;
};

try {
  const tracks = runtime.repository.listAll();
  const byTitle = (needle: string) =>
    tracks.find((track) => track.title.toLowerCase().includes(needle.toLowerCase()));

  const summaries = runtime.setPlans.list(50).plans;
  const sheet: string[] = [];
  let index = 0;
  for (const spec of PAIRS) {
    const outTrack = byTitle(spec.outgoing);
    const inTrack = byTitle(spec.incoming);
    if (!outTrack || !inTrack) {
      console.log(`!! missing track for ${spec.outgoing} -> ${spec.incoming}`);
      continue;
    }
    // Most recent stored plan containing this adjacency.
    let hit: JoinHit | null = null;
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
        if (entries[i]!.trackId !== outTrack.id || entries[i + 1]!.trackId !== inTrack.id) {
          continue;
        }
        const transition = entries[i]!.transitionToNext;
        if (!transition) continue;
        const candidate: JoinHit = {
          planId: stored.plan.id,
          planName: stored.plan.name,
          transitionId: transition.id,
          storedType: transition.type,
          outgoingTitle: outTrack.title,
          incomingTitle: inTrack.title,
          updatedAt: stored.plan.updatedAt,
        };
        if (!hit || candidate.updatedAt > hit.updatedAt) {
          hit = candidate;
        }
      }
    }
    if (!hit) {
      console.log(`!! no stored adjacency for ${spec.outgoing} -> ${spec.incoming}`);
      continue;
    }
    index += 1;
    const base = `${String(index).padStart(2, "0")} ${hit.outgoingTitle} -> ${hit.incomingTitle}`;
    console.log(`rendering: ${base} (plan: ${hit.planName}, stored ${hit.storedType})`);

    for (const [side, template] of [
      ["OLD", undefined as undefined | "phrase_mix" | "bass_swap" | "crossfade"],
      ["NEW", spec.newTemplate],
    ] as const) {
      const started = await runtime.service.createTransitionPreview({
        setPlanId: hit.planId,
        transitionId: hit.transitionId,
        ...(template ? { template } : {}),
      });
      const done = await runtime.service.waitForRenderJob(started.job.id, 600_000);
      if (done.status !== "succeeded" || !done.outputRootRelativePath) {
        console.log(`   ${side}: FAILED (${done.status} ${done.errorMessage ?? ""})`);
        continue;
      }
      const dest = path.join(
        outDir,
        `${base} [${side}-${template ?? hit.storedType}].flac`.replace(/[<>:"|?*]/g, ""),
      );
      await copyFile(path.join(config.outputRoot, done.outputRootRelativePath), dest);
      sheet.push(
        `# ${base}\n  ${side}: ${template ?? hit.storedType}  (${spec.note})\n  file: ${path.basename(dest)}\n  plan: ${hit.planName}\n`,
      );
      console.log(`   ${side}: ${path.basename(dest)}`);
    }
  }
  await writeFile(path.join(outDir, "LISTENING-SHEET.txt"), `${sheet.join("\n")}\n`);
  console.log(`\nDone. Files + listening sheet in: ${outDir}`);
} finally {
  await runtime.close();
}
