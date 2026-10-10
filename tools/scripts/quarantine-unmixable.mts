/** Moves the three owner-verdict unmixable tracks to Music/unmixable and
 *  rescans so the catalog reflects the quarantine. */
import { rename, mkdir } from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";

const UNMIXABLE = [
  "It's Time (feat. Gene Farris)",
  "Don't Be Gone Too Long",
  "Look At Me Go (feat. Darren Styles)",
];

const config = loadConfig();
const runtime = createCatalogRuntime(config, undefined, {});
try {
  const tracks = runtime.repository.listAll();
  const unmixableRoot = "C:\\Users\\arild\\Music\\unmixable";
  await mkdir(unmixableRoot, { recursive: true });
  for (const title of UNMIXABLE) {
    const track = tracks.find(
      (row) => row.title.toLowerCase().trim() === title.toLowerCase().trim(),
    );
    if (!track) {
      console.log(`?? not found: ${title}`);
      continue;
    }
    if (track.filePath.toLowerCase().includes("unmixable")) {
      console.log(`already quarantined: ${title}`);
      continue;
    }
    const dest = path.join(unmixableRoot, path.basename(track.filePath));
    await rename(track.filePath, dest);
    console.log(`moved: "${title}" -> ${dest}`);
  }
  console.log("rescanning...");
  const scan = await runtime.service.scanLibrary();
  console.log(
    `scan complete: ${scan.result.upserted} upserted, ${scan.result.moved} moved, ${scan.result.markedMissing} missing`,
  );
  // Verify the three are now fileMissing or gone from search.
  const remaining = runtime.repository
    .listAll()
    .filter(
      (row) =>
        !row.fileMissing &&
        UNMIXABLE.some((title) => title.toLowerCase().trim() === row.title.toLowerCase().trim()),
    );
  console.log(
    remaining.length === 0
      ? "all three quarantined (no longer active in the catalog)"
      : `still active: ${remaining.map((row) => row.title).join(", ")}`,
  );
} finally {
  await runtime.close();
}
