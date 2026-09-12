/** Promote stored KeyFinder rows to canonical analyzed keys. Does not re-analyze. */
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";
import { loadConfig } from "../../packages/domain/src/index.ts";

const config = loadConfig();
const runtime = createCatalogRuntime(config, undefined, { passive: true });
const promoted: Array<{ title: string; key: string; camelot: string | null }> = [];
const skipped: Array<{ title: string; reason: string }> = [];

for (const track of runtime.repository.listAll()) {
  const row = runtime.analyses.findByTrackId(track.id, "keyfinder");
  if (!row?.musicalKey) {
    continue;
  }
  if (track.keySource === "manual" || track.keySource === "published") {
    skipped.push({ title: track.title, reason: `${track.keySource} ${track.musicalKey}` });
    continue;
  }
  runtime.repository.applyAnalyzedMetadata(track.id, {
    bpm: null,
    musicalKey: row.musicalKey,
    keyConfidence: row.keyConfidence,
    gridRejected: true,
  });
  runtime.service.selectTrackEvidence({
    trackId: track.id,
    keyEngine: "keyfinder",
    reason: "KeyFinder 2026-09-08; 3/3 manual labels exact; DSP key unused",
  });
  promoted.push({ title: track.title, key: row.musicalKey, camelot: row.camelotKey });
}

await runtime.close();
console.log(
  JSON.stringify(
    { promotedCount: promoted.length, skippedCount: skipped.length, promoted, skipped },
    null,
    2,
  ),
);
