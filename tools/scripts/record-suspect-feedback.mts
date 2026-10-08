/** Records the 9 October verifier-suspect verdicts on their preview renders. */
import { loadConfig } from "../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";

const RATINGS: Array<{
  outgoing: string;
  incoming: string;
  template: string;
  overall: number;
  note: string;
}> = [
  {
    outgoing: "Picton Blues",
    incoming: "Hayling (Feat. Emer Dineen)",
    template: "phrase_mix",
    overall: 1,
    note: "2026-10-09 verifier audition: join is perfect - deck verifier's 100ms fail was a FALSE POSITIVE (full-band onset contamination)",
  },
  {
    outgoing: "Tour",
    incoming: "Under",
    template: "phrase_mix",
    overall: 1,
    note: "2026-10-09 verifier audition: join is perfect - designed 8-beat onset-lock slip plus measured sub-beat drift was a FALSE POSITIVE",
  },
];

const config = loadConfig();
const runtime = createCatalogRuntime(config, undefined, { passive: true });
try {
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
      console.log(`?? no preview job for ${key}`);
      continue;
    }
    const transitionId = stored.manifest?.tracks.find((track) => track.transitionId)?.transitionId;
    if (!transitionId) {
      console.log(`?? no transition on manifest for ${key}`);
      continue;
    }
    const rated = runtime.service.rateTransition({
      renderJobId: stored.id,
      transitionId,
      overall: rating.overall,
      note: rating.note,
    });
    console.log(`recorded LIKE ${rating.outgoing} -> ${rating.incoming} (${rated.id.slice(0, 8)})`);
  }
} finally {
  await runtime.close();
}
