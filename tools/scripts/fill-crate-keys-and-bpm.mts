/** Crate-wide KeyFinder + canonical BPM fill. Does not run analysis:gate. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createNodeProcessRunner } from "../../packages/audio-renderer/src/index.ts";
import { probeKeyEngine, runKeyEngine } from "../../packages/catalog/src/analysis/key-engine.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";
import { DSP_ANALYZER_NAME, loadConfig, resolveBpmHint, type Track } from "../../packages/domain/src/index.ts";

const KEY_REASON = "KeyFinder crate-wide 2026-09-09; DSP chroma unused";
const CONCURRENCY = 2;

const config = loadConfig();
const runtime = createCatalogRuntime(config);
const runner = createNodeProcessRunner();
const probe = await probeKeyEngine(config);
if (!probe.available) {
  runtime.close();
  throw new Error("KeyFinder is not installed");
}

function storeKeyfinder(track: Track, key: Awaited<ReturnType<typeof runKeyEngine>>): void {
  runtime.analyses.upsert({
    trackId: track.id,
    analyzerName: key.analyzerName,
    analyzerVersion: key.analyzerVersion,
    bpm: null,
    bpmConfidence: null,
    bpmRaw: null,
    beatTimesMs: [],
    downbeatTimesMs: [],
    gridRejected: true,
    gridRejectionReason: "key-only evidence",
    gridSource: "analyzed",
    musicalKey: key.musicalKey,
    keyConfidence: key.keyConfidence,
    keyMode: key.keyMode,
    camelotKey: key.camelotKey,
    keyCandidates: key.descriptors?.keyCandidates ?? null,
    tempoStability: null,
    downbeatConfidence: null,
    integratedLufs: null,
    truePeakDb: null,
    lowBandEnergy: null,
    midBandEnergy: null,
    highBandEnergy: null,
    waveformSummary: null,
    beatAnchorMs: null,
    descriptors: key.descriptors,
    engineRuntimeMs: key.engineRuntimeMs,
    analyzedAt: new Date().toISOString(),
    suggestedCues: [],
    sections: [],
  });
  if (track.keySource !== "manual" && track.keySource !== "published" && key.musicalKey) {
    runtime.repository.applyAnalyzedMetadata(track.id, {
      bpm: null,
      musicalKey: key.musicalKey,
      keyConfidence: key.keyConfidence,
      gridRejected: true,
    });
    runtime.service.selectTrackEvidence({
      trackId: track.id,
      keyEngine: "keyfinder",
      reason: KEY_REASON,
    });
  }
}

function writeAnalyzedBpm(track: Track, bpm: number): void {
  runtime.repository.applyAnalyzedMetadata(track.id, {
    bpm,
    musicalKey: track.musicalKey,
    keyConfidence: track.musicalKey ? 0.7 : 0,
    gridRejected: false,
  });
}

const promotedExisting: Array<{ title: string; key: string }> = [];
const skippedCanonical: Array<{ title: string; reason: string }> = [];
for (const track of runtime.repository.listAll()) {
  const row = runtime.analyses.findByTrackId(track.id, "keyfinder");
  if (!row?.musicalKey) {
    continue;
  }
  if (track.keySource === "manual" || track.keySource === "published") {
    skippedCanonical.push({ title: track.title, reason: `${track.keySource} ${track.musicalKey}` });
    continue;
  }
  if (track.keySource === "analyzed" && track.musicalKey === row.musicalKey) {
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
    reason: KEY_REASON,
  });
  promotedExisting.push({ title: track.title, key: row.musicalKey });
}

const missingKeyfinder = runtime.repository.listAll().filter((track) => {
  if (track.fileMissing || !track.filePath) {
    return false;
  }
  return !runtime.analyses.findByTrackId(track.id, "keyfinder");
});
console.error(
  `Promoted existing KeyFinder ${promotedExisting.length}; skipped ${skippedCanonical.length} manual/published; measuring ${missingKeyfinder.length}`,
);

const measured: Array<{ title: string; key: string | null; error: string | null }> = [];
let nextIndex = 0;
let writeChain = Promise.resolve();
function enqueueWrite(fn: () => void): Promise<void> {
  const run = writeChain.then(fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function worker(): Promise<void> {
  while (true) {
    const index = nextIndex;
    nextIndex += 1;
    const track = missingKeyfinder[index];
    if (!track) {
      return;
    }
    console.error(`[keys ${index + 1}/${missingKeyfinder.length}] ${track.artist ?? "?"} — ${track.title}`);
    try {
      const key = await runKeyEngine(runner, config, track.filePath!);
      await enqueueWrite(() => {
        storeKeyfinder(track, key);
        measured.push({ title: track.title, key: key.musicalKey, error: null });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  failed: ${message}`);
      await enqueueWrite(() => {
        measured.push({ title: track.title, key: null, error: message });
      });
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(missingKeyfinder.length, 1)) }, () => worker()));
await writeChain;

const bpmFilled: Array<{ title: string; bpm: number; from: "grid" | "hint" }> = [];
const bpmLeftover: Array<{ title: string; reason: string }> = [];
for (const track of runtime.repository.listAll()) {
  if (track.bpm != null) {
    continue;
  }
  if (track.bpmSource === "manual" || track.bpmSource === "published") {
    continue;
  }
  const fresh = runtime.repository.findById(track.id) ?? track;
  const dsp = runtime.analyses.findByTrackId(fresh.id, DSP_ANALYZER_NAME);
  if (dsp && !dsp.gridRejected && dsp.bpm != null) {
    writeAnalyzedBpm(fresh, dsp.bpm);
    bpmFilled.push({ title: fresh.title, bpm: dsp.bpm, from: "grid" });
    continue;
  }
  const hint = dsp ? resolveBpmHint(dsp) : { bpm: null };
  if (hint.bpm != null) {
    writeAnalyzedBpm(fresh, hint.bpm);
    bpmFilled.push({ title: fresh.title, bpm: hint.bpm, from: "hint" });
    continue;
  }
  bpmLeftover.push({
    title: fresh.title,
    reason: dsp == null ? "no DSP row" : dsp.gridRejected ? "rejected grid, hint did not fold 160-190" : "no BPM on accepted grid",
  });
}

const after = runtime.repository.listAll();
const summary = {
  tracks: after.length,
  keyfinderRows: after.filter((track) => runtime.analyses.findByTrackId(track.id, "keyfinder")).length,
  canonicalKey: after.filter((track) => track.musicalKey).length,
  keyBySource: {
    analyzed: after.filter((track) => track.keySource === "analyzed").length,
    manual: after.filter((track) => track.keySource === "manual").length,
    published: after.filter((track) => track.keySource === "published").length,
  },
  canonicalBpm: after.filter((track) => track.bpm != null).length,
  bpmBySource: {
    analyzed: after.filter((track) => track.bpmSource === "analyzed").length,
    manual: after.filter((track) => track.bpmSource === "manual").length,
    published: after.filter((track) => track.bpmSource === "published").length,
  },
  promotedExisting: promotedExisting.length,
  measured: measured.filter((row) => row.key).length,
  measureFailed: measured.filter((row) => row.error).length,
  bpmFilledGrid: bpmFilled.filter((row) => row.from === "grid").length,
  bpmFilledHint: bpmFilled.filter((row) => row.from === "hint").length,
  bpmLeftover: bpmLeftover.length,
  leftoverTitles: bpmLeftover.slice(0, 24).map((row) => row.title),
  failedTitles: measured.filter((row) => row.error).map((row) => ({ title: row.title, error: row.error })),
};

const outDir = path.join(
  config.outputRoot,
  "reviews",
  `crate-keys-bpm-${new Date().toISOString().replaceAll(":", "-")}`,
);
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "report.json"), `${JSON.stringify({ summary, promotedExisting, skippedCanonical, measured, bpmFilled, bpmLeftover }, null, 2)}\n`);
runtime.close();
console.log(JSON.stringify({ outDir, ...summary }, null, 2));
