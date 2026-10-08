/**
 * Verifier-suspect follow-up (deck verifier's first candidate catches):
 * inspect the flagged joins and render previews for listening.
 *
 * Usage: pnpm tsx tools/scripts/verifier-suspects.mts
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";

const SUSPECTS = [
  { renderId: "d1b0990b", order: 17, why: "decks ~100 ms apart despite stored offset 9 ms" },
  { renderId: "9a95ba25", order: 20, why: "stored offset 2745 ms (~8 beats), phase-wrapped" },
];

const config = loadConfig();
const runtime = createCatalogRuntime(config, undefined, {});
const outDir = path.join(config.outputRoot, "verifier-suspects-2026-10-09");
await mkdir(outDir, { recursive: true });
const sheet: string[] = [];
try {
  const titleOf = new Map(runtime.repository.listAll().map((track) => [track.id, track.title]));
  for (const suspect of SUSPECTS) {
    const job = runtime.renderJobs
      .list({ limit: 50, status: "succeeded" })
      .jobs.find((row) => row.id.startsWith(suspect.renderId));
    const manifest = job ? runtime.renderJobs.findById(job.id)?.manifest : undefined;
    const track = manifest?.tracks[suspect.order];
    if (!manifest || !track?.transitionId) {
      console.log(`!! render ${suspect.renderId} join ${suspect.order}: not found`);
      continue;
    }
    const next = manifest.tracks[suspect.order + 1]!;
    const name = `${titleOf.get(track.trackId)} -> ${titleOf.get(next.trackId)}`;
    console.log(`\n=== ${name} (join ${suspect.order}, ${suspect.why}) ===`);

    const inspected = runtime.service.inspectTransition({
      setPlanId: manifest.setPlanId,
      transitionId: track.transitionId,
    });
    console.log(
      JSON.stringify(
        {
          stored: inspected.stored,
          outgoing: {
            window: [inspected.outgoing.sourceStartMs, inspected.outgoing.sourceEndMs],
            rate: inspected.outgoing.playbackRate,
            overlapStartSourceMs: inspected.outgoing.overlapStartSourceMs,
          },
          incoming: {
            window: [inspected.incoming.sourceStartMs, inspected.incoming.sourceEndMs],
            rate: inspected.incoming.playbackRate,
          },
          alignment: inspected.alignment,
          freshView: inspected.freshView,
        },
        null,
        2,
      ),
    );
    sheet.push(
      `# ${name} (join ${suspect.order})\n  flagged: ${suspect.why}\n  stored: ${inspected.stored.type}, offset ${inspected.alignment.offsetMs} ms, mode ${inspected.alignment.mode}\n  fresh planner today: ${inspected.freshView?.type} (${inspected.freshView?.reason ?? "?"})\n`,
    );

    const started = await runtime.service.createTransitionPreview({
      setPlanId: manifest.setPlanId,
      transitionId: track.transitionId,
    });
    const done = await runtime.service.waitForRenderJob(started.job.id, 600_000);
    if (done.status === "succeeded" && done.outputRootRelativePath) {
      const dest = path.join(
        outDir,
        `${name} [${inspected.stored.type}].flac`.replace(/[<>:"|?*]/g, ""),
      );
      await copyFile(path.join(config.outputRoot, done.outputRootRelativePath), dest);
      sheet.push(`  preview: ${path.basename(dest)}\n`);
      console.log(`preview: ${path.basename(dest)}`);
    } else {
      console.log(`preview FAILED (${done.status} ${done.errorMessage ?? ""})`);
    }
  }
  await writeFile(path.join(outDir, "LISTENING-SHEET.txt"), `${sheet.join("\n")}\n`);
  console.log(`\nDone: ${outDir}`);
} finally {
  await runtime.close();
}
