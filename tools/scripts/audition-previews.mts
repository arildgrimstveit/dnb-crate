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
  /** Pin to a specific plan's transition (defaults to the most recent). */
  planId?: string;
};

const PAIRS: PairSpec[] = [
  {
    outgoing: "Together In The Night",
    incoming: "Renaissance - Edit",
    newTemplate: "phrase_mix",
    note: "high-gear join 15: bass_swap in the perfect mix - test the blend",
    planId: "6b21e8fa-a597-4ea6-ad89-8a85490d3736",
  },
  {
    outgoing: "Renaissance - Edit",
    incoming: "Don't You Fade Away",
    newTemplate: "phrase_mix",
    note: "high-gear join 16: bass_swap in the perfect mix - test the blend",
    planId: "6b21e8fa-a597-4ea6-ad89-8a85490d3736",
  },
  {
    outgoing: "Escape",
    incoming: "Through The Silence",
    newTemplate: "phrase_mix",
    note: "high-gear join 25: bass_swap in the perfect mix - test the blend",
    planId: "6b21e8fa-a597-4ea6-ad89-8a85490d3736",
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
  // Exact title match first; several recordings can share a title, so
  // adjacency checks match against ALL candidates.
  const byTitleCandidates = (needle: string) => {
    const lower = needle.toLowerCase().trim();
    const exact = tracks.filter((track) => track.title.toLowerCase().trim() === lower);
    return exact.length > 0
      ? exact
      : tracks.filter((track) => track.title.toLowerCase().includes(lower));
  };

  const summaries = runtime.setPlans.list(50).plans;
  const sheet: string[] = [];
  let index = 0;
  for (const spec of PAIRS) {
    const outCandidates = byTitleCandidates(spec.outgoing);
    const inCandidates = byTitleCandidates(spec.incoming);
    const outIds = new Set(outCandidates.map((track) => track.id));
    const inIds = new Set(inCandidates.map((track) => track.id));
    if (outIds.size === 0 || inIds.size === 0) {
      console.log(`!! missing track for ${spec.outgoing} -> ${spec.incoming}`);
      continue;
    }
    // Prefer the pinned plan when given; otherwise the most recent stored
    // adjacency wins.
    let hit: JoinHit | null = null;
    const planIds: string[] = spec.planId ? [spec.planId] : summaries.map((summary) => summary.id);
    for (const planId of planIds) {
      let stored: ReturnType<typeof runtime.setPlans.findById>;
      try {
        stored = runtime.setPlans.findById(planId);
      } catch {
        continue;
      }
      if (!stored) continue;
      const entries = [...stored.plan.entries].sort((a, b) => a.order - b.order);
      for (let i = 0; i < entries.length - 1; i += 1) {
        if (!outIds.has(entries[i]!.trackId) || !inIds.has(entries[i + 1]!.trackId)) {
          continue;
        }
        const transition = entries[i]!.transitionToNext;
        if (!transition) continue;
        const candidate: JoinHit = {
          planId: stored.plan.id,
          planName: stored.plan.name,
          transitionId: transition.id,
          storedType: transition.type,
          outgoingTitle: outCandidates.find((t) => t.id === entries[i]!.trackId)!.title,
          incomingTitle: inCandidates.find((t) => t.id === entries[i + 1]!.trackId)!.title,
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
      const dest = path.join(
        outDir,
        `${base} [${side}-${template ?? hit.storedType}].flac`.replace(/[<>:"|?*]/g, ""),
      );
      let done;
      try {
        const started = await runtime.service.createTransitionPreview({
          setPlanId: hit.planId,
          transitionId: hit.transitionId,
          ...(template ? { template } : {}),
        });
        done = await runtime.service.waitForRenderJob(started.job.id, 600_000);
        if (done.status === "cancelled") {
          // A raced claim or an aborted worker can cancel a fresh job; one
          // retry settles it.
          const retry = await runtime.service.createTransitionPreview({
            setPlanId: hit.planId,
            transitionId: hit.transitionId,
            ...(template ? { template } : {}),
          });
          done = await runtime.service.waitForRenderJob(retry.job.id, 600_000);
        }
      } catch (error) {
        console.log(
          `   ${side}: SKIPPED (${error instanceof Error ? error.message : String(error)})`,
        );
        continue;
      }
      if (done.status !== "succeeded" || !done.outputRootRelativePath) {
        console.log(`   ${side}: FAILED (${done.status} ${done.errorMessage ?? ""})`);
        continue;
      }
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
