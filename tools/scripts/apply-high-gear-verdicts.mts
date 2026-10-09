/** Records the high-gear A/B verdicts, flips the three joins to phrase_mix,
 *  and backs up the current listen file before the re-render. */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";

const PLAN_ID = "6b21e8fa-a597-4ea6-ad89-8a85490d3736";

const RATINGS: Array<{
  outgoing: string;
  incoming: string;
  template: string;
  overall: number;
  note: string;
}> = [
  {
    outgoing: "Together In The Night",
    incoming: "Renaissance - Edit",
    template: "phrase_mix",
    overall: 1,
    note: "2026-10-09 A/B: phrase_mix preferred — keeps volume and energy through the overlap",
  },
  {
    outgoing: "Together In The Night",
    incoming: "Renaissance - Edit",
    template: "bass_swap",
    overall: 0.3,
    note: "2026-10-09 A/B: swap lost — fade-out/in dips energy here",
  },
  {
    outgoing: "Renaissance - Edit",
    incoming: "Don't You Fade Away",
    template: "phrase_mix",
    overall: 1,
    note: "2026-10-09 A/B: phrase_mix preferred — keeps volume and energy",
  },
  {
    outgoing: "Renaissance - Edit",
    incoming: "Don't You Fade Away",
    template: "bass_swap",
    overall: 0.3,
    note: "2026-10-09 A/B: swap lost — fade-out/in dips energy here",
  },
  {
    outgoing: "Escape",
    incoming: "Through The Silence",
    template: "phrase_mix",
    overall: 1,
    note: "2026-10-09 A/B: phrase_mix preferred — keeps volume and energy",
  },
  {
    outgoing: "Escape",
    incoming: "Through The Silence",
    template: "bass_swap",
    overall: 0.3,
    note: "2026-10-09 A/B: swap lost — fade-out/in dips energy here",
  },
];

const config = loadConfig();
const runtime = createCatalogRuntime(config, undefined, { passive: true });
try {
  // 1. Record the six A/B verdicts on the exact preview renders.
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
  const titleOf = new Map(runtime.repository.listAll().map((track) => [track.id, track.title]));
  const byPairTemplate = new Map<string, ReturnType<typeof runtime.renderJobs.findById>>();
  let cursor: string | undefined;
  do {
    const page = runtime.renderJobs.list({
      limit: 50,
      status: "succeeded",
      ...(cursor ? { cursor } : {}),
    });
    for (const job of page.jobs) {
      if (job.kind !== "preview") continue;
      const stored = runtime.renderJobs.findById(job.id);
      const first = stored?.manifest?.tracks[0];
      const second = stored?.manifest?.tracks[1];
      if (!stored?.manifest || !first || !second) continue;
      const key = `${normalize(titleOf.get(first.trackId) ?? "")}|${normalize(titleOf.get(second.trackId) ?? "")}|${first.transitionTemplate}`;
      if (
        !byPairTemplate.has(key) ||
        (byPairTemplate.get(key)!.completedAt ?? "") < (job.completedAt ?? "")
      ) {
        byPairTemplate.set(key, stored);
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  for (const rating of RATINGS) {
    const key = `${normalize(rating.outgoing)}|${normalize(rating.incoming)}|${rating.template}`;
    const stored = byPairTemplate.get(key);
    if (!stored) {
      console.log(`?? no preview for ${key}`);
      continue;
    }
    const transitionId = stored.manifest?.tracks.find((track) => track.transitionId)?.transitionId;
    if (!transitionId) continue;
    const rated = runtime.service.rateTransition({
      renderJobId: stored.id,
      transitionId,
      overall: rating.overall,
      note: rating.note,
    });
    console.log(
      `recorded ${rating.overall === 1 ? "LIKE " : "DISLIKE"} ${rating.outgoing} -> ${rating.incoming} [${rating.template}] (${rated.id.slice(0, 8)})`,
    );
  }

  // 2. Back up the perfect v1 listen before the re-render replaces it.
  const backupDir = path.join(config.outputRoot, "renders");
  await mkdir(backupDir, { recursive: true });
  await copyFile(
    path.join(config.outputRoot, "renders", "high-gear.flac"),
    path.join(config.outputRoot, "renders", "high-gear-v1-perfect.flac"),
  );
  console.log("backed up renders/high-gear.flac -> renders/high-gear-v1-perfect.flac");

  // 3. Flip the three joins to phrase_mix on their frozen windows.
  const stored = runtime.setPlans.findById(PLAN_ID)!;
  const entries = [...stored.plan.entries].sort((a, b) => a.order - b.order);
  const pairs = new Set([
    "Together In The Night|Renaissance - Edit",
    "Renaissance - Edit|Don't You Fade Away",
    "Escape|Through The Silence",
  ]);
  for (let i = 0; i < entries.length - 1; i += 1) {
    const out = titleOf.get(entries[i]!.trackId) ?? "";
    const inc = titleOf.get(entries[i + 1]!.trackId) ?? "";
    if (!pairs.has(`${out}|${inc}`)) continue;
    const transition = entries[i]!.transitionToNext;
    if (!transition || transition.type !== "bass_swap") continue;
    runtime.service.updateSetPlan({
      setPlanId: PLAN_ID,
      setTransition: {
        entryId: entries[i]!.id,
        type: "phrase_mix",
        durationMs: transition.durationMs,
      },
    });
    console.log(`join ${i} ${out} -> ${inc}: bass_swap -> phrase_mix`);
  }
} finally {
  await runtime.close();
}
