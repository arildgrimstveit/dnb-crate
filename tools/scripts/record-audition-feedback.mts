/**
 * Records the 9 October 2026 audition verdicts as transition feedback on the
 * exact preview renders (the designed preview + approve flow), so the two
 * hand-preferred bass swaps survive as recipes while the automatic trigger
 * is tightened to decisive conflicts only.
 *
 * Usage: pnpm tsx tools/scripts/record-audition-feedback.mts
 */
import { access } from "node:fs/promises";

import { loadConfig } from "../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";

const config = loadConfig();
const runtime = createCatalogRuntime(config, undefined, { passive: true });
try {
  // Index succeeded preview jobs by pair titles + rendered template: the
  // audition copies were renamed, so the manifest is the source of truth.
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
      const outTitle = titleOf.get(first.trackId);
      const inTitle = titleOf.get(second.trackId);
      if (!outTitle || !inTitle) continue;
      const key = `${normalize(outTitle)}|${normalize(inTitle)}|${first.transitionTemplate}`;
      // Keep the most recent per key.
      if (
        !byPairTemplate.has(key) ||
        (byPairTemplate.get(key)!.completedAt ?? "") < (job.completedAt ?? "")
      ) {
        byPairTemplate.set(key, stored);
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const RATINGS: Array<{
    outgoing: string;
    incoming: string;
    template: string;
    overall: number;
    note: string;
  }> = [
    {
      outgoing: "Hayling (Feat. Emer Dineen)",
      incoming: "Pieces",
      template: "bass_swap",
      overall: 1,
      note: "2026-10-09 audition: bass_swap + glide preferred over phrase_mix on this join",
    },
    {
      outgoing: "Hayling (Feat. Emer Dineen)",
      incoming: "Pieces",
      template: "phrase_mix",
      overall: 0.3,
      note: "2026-10-09 audition: phrase_mix lost the A/B here",
    },
    {
      outgoing: "Moment to Moment",
      incoming: "Better Perspective",
      template: "phrase_mix",
      overall: 1,
      note: "2026-10-09 audition: phrase_mix preferred; energy keeps flowing",
    },
    {
      outgoing: "Moment to Moment",
      incoming: "Better Perspective",
      template: "bass_swap",
      overall: 0.3,
      note: "2026-10-09 audition: swap dips volume/energy too early here",
    },
    {
      outgoing: "Still In Love",
      incoming: "Pathways (feat. BLAKE)",
      template: "bass_swap",
      overall: 1,
      note: "2026-10-09 audition: bass_swap + glide preferred over phrase_mix",
    },
    {
      outgoing: "Still In Love",
      incoming: "Pathways (feat. BLAKE)",
      template: "phrase_mix",
      overall: 0.3,
      note: "2026-10-09 audition: phrase_mix lost the A/B here",
    },
    {
      outgoing: "Coming Down",
      incoming: "In The Woods",
      template: "phrase_mix",
      overall: 1,
      note: "2026-10-09 audition: phrase_mix preferred; energy keeps flowing",
    },
    {
      outgoing: "Coming Down",
      incoming: "In The Woods",
      template: "bass_swap",
      overall: 0.3,
      note: "2026-10-09 audition: swap dips volume/energy too early here",
    },
    {
      outgoing: "Signs (Feat. Changing Faces)",
      incoming: "Picton Blues",
      template: "phrase_mix",
      overall: 1,
      note: "2026-10-09 audition: blend preferred; keeps volume and energy",
    },
    {
      outgoing: "Signs (Feat. Changing Faces)",
      incoming: "Picton Blues",
      template: "bass_swap",
      overall: 0.3,
      note: "2026-10-09 audition: swap lost the A/B here",
    },
    {
      outgoing: "Pathways (feat. BLAKE)",
      incoming: "All Our Yesterdays",
      template: "phrase_mix",
      overall: 1,
      note: "2026-10-09 audition: blend preferred; keeps volume and energy",
    },
    {
      outgoing: "Pathways (feat. BLAKE)",
      incoming: "All Our Yesterdays",
      template: "bass_swap",
      overall: 0.3,
      note: "2026-10-09 audition: swap lost the A/B here",
    },
  ];
  let recorded = 0;
  for (const rating of RATINGS) {
    const key = `${normalize(rating.outgoing)}|${normalize(rating.incoming)}|${rating.template}`;
    const stored = byPairTemplate.get(key);
    if (!stored) {
      console.log(`?? no preview job for ${key}`);
      continue;
    }
    const transitionId = stored.manifest?.tracks.find((track) => track.transitionId)?.transitionId;
    if (!transitionId) {
      console.log(`?? no transition on manifest for ${key}`);
      continue;
    }
    void access;
    try {
      const rated = runtime.service.rateTransition({
        renderJobId: stored.id,
        transitionId,
        overall: rating.overall,
        note: rating.note,
      });
      recorded += 1;
      console.log(
        `recorded ${rating.overall === 1 ? "LIKE " : "DISLIKE"} ${rating.outgoing} -> ${rating.incoming} [${rating.template}] (rating ${rated.id.slice(0, 8)})`,
      );
    } catch (error) {
      console.log(
        `!! failed ${rating.outgoing} -> ${rating.incoming} [${rating.template}]: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log(`\n${recorded}/${RATINGS.length} ratings recorded`);
} finally {
  await runtime.close();
}
