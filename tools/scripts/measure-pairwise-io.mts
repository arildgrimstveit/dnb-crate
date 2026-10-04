/**
 * Lean plan R4, step 1: baseline measurement of the pairwise render path.
 * Renders a synthetic N-join plan (phrase_mix joins, real FFmpeg) and reports
 * wall time plus output-tree bytes. Usage:
 *   tsx tools/scripts/measure-pairwise-io.mts <joins>
 */
import { mkdtemp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildSyntheticDnbPcm, encodeMonoWav } from "../../packages/audio-analysis/src/index.ts";
import { createCatalogRuntime, type CatalogRuntime } from "../../packages/catalog/src/index.ts";
import type { AppConfig, CuePointType, TrackSectionType } from "../../packages/domain/src/index.ts";

const joins = Number(process.argv[2] ?? 20);
const tracks = joins + 1;
const root = await mkdtemp(path.join(os.tmpdir(), `dnb-measure-${joins}-`));
const library = path.join(root, "library");
const output = path.join(root, "output");
await mkdir(library);
await mkdir(output);

const config: AppConfig = {
  databasePath: path.join(root, "catalog.sqlite"),
  libraryRoots: [library],
  outputRoot: output,
  logLevel: "warn",
  supportedExtensions: [".wav"],
};

const runtime: CatalogRuntime = createCatalogRuntime(config, undefined, {});
try {
  // Seed `tracks` synthetic DnB WAVs (real audio so the renderer does real work).
  // 32|32|32|32|32 bars (intro/drop/breakdown/drop2/outro) @174 ≈ 176s each.
  const trackDurations: number[] = [];
  for (let i = 0; i < tracks; i += 1) {
    const pcm = buildSyntheticDnbPcm({
      bpm: 174,
      introBars: 32,
      dropBars: 32,
      breakdownBars: 32,
      drop2Bars: 32,
      outroBars: 32,
    });
    trackDurations.push(Math.round(pcm.durationMs));
    await writeFile(path.join(library, `track-${i}.wav`), encodeMonoWav(pcm));
  }
  await runtime.service.scanLibrary();

  // Give every track an accepted grid + key so strict plans take phrase_mix joins.
  const beat = 60_000 / 174;
  const beatTimes = Array.from({ length: Math.floor(176_000 / beat) }, (_, i) =>
    Math.round(i * beat),
  );
  const downbeatTimes = beatTimes.filter((_, i) => i % 4 === 0);
  const durationByTitle = new Map<string, number>();
  for (let i = 0; i < tracks; i += 1) durationByTitle.set(`track-${i}`, trackDurations[i]!);
  for (const track of runtime.repository.listAll()) {
    const trackMs = durationByTitle.get(track.title) ?? 176_000;
    const barMs = (4 * 60_000) / 174;
    const totalBars = Math.floor(trackMs / barMs);
    // intro 32 | build 32 | drop 32 | breakdown 32 | build 32 | drop 32 | outro rest
    const layout: Array<{
      type: TrackSectionType;
      bars: number;
      energy: number;
    }> = [
      { type: "intro", bars: 32, energy: 0.3 },
      { type: "drop", bars: 32, energy: 0.9 },
      { type: "breakdown", bars: 32, energy: 0.25 },
      { type: "drop", bars: 32, energy: 0.9 },
      { type: "outro", bars: 32, energy: 0.4 },
    ];
    const sections: Array<{
      type: TrackSectionType;
      startMs: number;
      endMs: number;
      startBar: number;
      endBar: number;
      confidence: number;
      sectionEnergy: number;
    }> = [];
    let barCursor = 0;
    for (const part of layout) {
      sections.push({
        type: part.type,
        startMs: Math.round(barCursor * barMs),
        endMs: Math.round((barCursor + part.bars) * barMs),
        startBar: barCursor,
        endBar: barCursor + part.bars,
        confidence: 0.8,
        sectionEnergy: part.energy,
      });
      barCursor += part.bars;
    }
    if (barCursor < totalBars) {
      sections.push({
        type: "outro",
        startMs: Math.round(barCursor * barMs),
        endMs: trackMs,
        startBar: barCursor,
        endBar: totalBars,
        confidence: 0.7,
        sectionEnergy: 0.4,
      });
    }
    const cueAt = (type: string) => sections.find((section) => section.type === type)!;
    const suggestedCues: Array<{
      type: CuePointType;
      positionMs: number;
      confidence: number;
      beatIndex: null;
      barIndex: null;
    }> = [
      {
        type: "intro_start",
        positionMs: cueAt("intro").startMs,
        confidence: 0.8,
        beatIndex: null,
        barIndex: null,
      },
      {
        type: "drop",
        positionMs: cueAt("drop").startMs,
        confidence: 0.8,
        beatIndex: null,
        barIndex: null,
      },
      {
        type: "breakdown",
        positionMs: cueAt("breakdown").startMs,
        confidence: 0.7,
        beatIndex: null,
        barIndex: null,
      },
      {
        type: "outro_start",
        positionMs: cueAt("outro").startMs,
        confidence: 0.7,
        beatIndex: null,
        barIndex: null,
      },
    ];
    runtime.analyses.upsert({
      trackId: track.id,
      analyzerName: "dnb-crate-dsp",
      analyzerVersion: "3.5.0",
      bpm: 174,
      bpmConfidence: 0.9,
      bpmRaw: 174,
      referenceBpm: null,
      beatTimesMs: beatTimes,
      downbeatTimesMs: downbeatTimes,
      gridRejected: false,
      gridRejectionReason: null,
      gridSource: "analyzed",
      musicalKey: "Am",
      keyConfidence: 0.7,
      keyMode: "minor",
      camelotKey: "1A",
      tempoStability: 0.9,
      downbeatConfidence: 0.8,
      integratedLufs: -10,
      truePeakDb: -1.5,
      lowBandEnergy: null,
      midBandEnergy: null,
      highBandEnergy: null,
      waveformSummary: null,
      beatAnchorMs: null,
      descriptors: {
        integratedLufs: -10,
        shortTermRmsDbfsMean: null,
        shortTermRmsDbfsMax: null,
        truePeakDb: null,
        subBassRatio: 0.5,
        brightness: 0.2,
        onsetDensity: null,
        dynamicRange: null,
        dropIntensity: null,
        suggestedEnergy: 6,
        energy: 0.6,
        danceability: 0.6,
        acousticness: 0.1,
        melodicness: 0.5,
        valence: 0.5,
        waveformSummary: [],
        lowBandEnergy: null,
        midBandEnergy: null,
        highBandEnergy: null,
        chromaVector: null,
        tempoEvidence: null,
        audioStartMs: 0,
        audioEndMs: trackMs,
      },
      engineRuntimeMs: 1,
      analyzedAt: new Date().toISOString(),
      suggestedCues,
      sections,
    });
    runtime.service.updateTrackMetadata(track.id, { musicalKey: "Am", energy: 6 });
    // The renderer requires manual cue_points rows for aligned templates.
    runtime.service.setCuePoints(track.id, [
      { type: "intro_start", positionMs: cueAt("intro").startMs },
      { type: "drop", positionMs: cueAt("drop").startMs },
      { type: "breakdown", positionMs: cueAt("breakdown").startMs },
      { type: "outro_start", positionMs: cueAt("outro").startMs },
    ]);
  }

  const minutes = Math.ceil((tracks * 176_000) / 60_000) + 2;
  const created = runtime.service.createSetPlan({
    name: `measure-${joins}`,
    targetDurationMinutes: minutes,
    seed: 1,
  });
  const entryCount = created.plan.entries.length;
  const phraseJoins = created.plan.entries.filter(
    (entry: { transitionToNext?: { type?: string } | null }) =>
      entry.transitionToNext?.type === "phrase_mix",
  ).length;
  console.log(
    `[measure] plan: ${entryCount} entries, ${phraseJoins} phrase_mix joins (target ${joins})`,
  );
  const quality = runtime.service.reportSetPlanQuality(created.plan.id);
  console.log(
    `[measure] quality: partial=${quality.partial} ready=${quality.readyForAudition} reasons=${JSON.stringify(quality.partialReasons)} types=${JSON.stringify(quality.typeCounts)}`,
  );
  if (!quality.readyForAudition) {
    for (const join of quality.joins) {
      console.log(
        `[measure] join ${join.order} ${join.outgoingTitle}->${join.incomingTitle}: qualityIssue=${join.unexplainedQualityIssue} fallback=${join.fallbackReason} harmonic=${join.harmonicClass}`,
      );
    }
  }
  const saved = await runtime.service.validateSavedSetPlan(created.plan.id);
  console.log(
    `[measure] validation: valid=${saved.valid} readinessReady=${saved.renderReadiness?.ready ?? "n/a"}`,
  );
  const internal = (
    runtime.service as unknown as {
      qualityForPlan: (plan: unknown) => {
        readyForAudition: boolean;
        qualityChecksPassed: boolean;
        structurallyValid: boolean;
        partialReasons: string[];
      };
    }
  ).qualityForPlan(created.plan);
  console.log(
    `[measure] evidence-path quality: ready=${internal.readyForAudition} checks=${internal.qualityChecksPassed} valid=${internal.structurallyValid} reasons=${JSON.stringify(internal.partialReasons)}`,
  );

  const startedAt = Date.now();
  const started = await runtime.service.startSetRender({
    setPlanId: created.plan.id,
    allowOverlongDuration: true,
    allowLowConfidence: true,
  });
  const done = await runtime.service.waitForRenderJob(started.job.id, 60 * 60_000);
  const elapsedMs = Date.now() - startedAt;

  if (done.status !== "succeeded") {
    console.error(`[measure] render ${done.status}: ${done.errorMessage ?? ""}`);
    process.exitCode = 1;
  }

  let bytes = 0;
  let files = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir)) {
      const full = path.join(dir, entry);
      const info = await stat(full);
      if (info.isDirectory()) await walk(full);
      else {
        bytes += info.size;
        files += 1;
      }
    }
  };
  await walk(output);
  console.log(
    `[measure] joins=${joins} entries=${entryCount} status=${done.status} wallMs=${elapsedMs} outputFiles=${files} outputBytes=${bytes}`,
  );
} finally {
  await runtime.close();
  await import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true }));
}
