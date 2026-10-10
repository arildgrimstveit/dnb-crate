/** Records the high-gear-variety verdict and tags the three unmixable
 *  tracks so the planner stops selecting them. */
import { loadConfig } from "../../../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../../../packages/catalog/src/index.ts";

const RENDER_ID = "e1669364-1a1b-42cd-a6ad-3428480bf2ba";
const UNMIXABLE = [
  { title: "It's Time (feat. Gene Farris)", reason: "owner 2026-10-10: song not good in mixes" },
  { title: "Don't Be Gone Too Long", reason: "owner 2026-10-10: song not good in mixes" },
  {
    title: "Look At Me Go (feat. Darren Styles)",
    reason: "owner 2026-10-10: song not good in mixes",
  },
];

const config = loadConfig();
const runtime = createCatalogRuntime(config, undefined, { passive: true });
try {
  // 1. Hour verdict.
  const manifest = runtime.renderJobs.findById(RENDER_ID)?.manifest;
  if (manifest) {
    const rated = runtime.service.recordHourFeedback({
      renderJobId: RENDER_ID,
      outputChecksum: manifest.outputChecksumSha256,
      accepted: true,
      quote:
        "Very good. All joins good, but It's Time, Don't Be Gone Too Long, and Look At Me Go are unmixable — the songs don't work in mixes.",
    });
    console.log(`hour feedback recorded: ${rated.id} (accepted)`);
  } else {
    console.log("!! render manifest not found");
  }

  // 2. Tag the unmixable tracks (rating 1 + a tag the owner can filter on).
  const tracks = runtime.repository.listAll();
  for (const spec of UNMIXABLE) {
    const track = tracks.find(
      (row) => row.title.toLowerCase().trim() === spec.title.toLowerCase().trim(),
    );
    if (!track) {
      console.log(`?? not found: ${spec.title}`);
      continue;
    }
    const updated = runtime.service.updateTrackMetadata(track.id, {
      rating: 1,
      tags: [...new Set([...(track.tags ?? []), "unmixable"])],
      notes: [track.notes, spec.reason].filter(Boolean).join(" | ") || spec.reason,
    });
    console.log(
      `tagged unmixable: "${updated.title}" (rating ${updated.rating}, tags: ${updated.tags?.join(", ")})`,
    );
  }
} finally {
  await runtime.close();
}
