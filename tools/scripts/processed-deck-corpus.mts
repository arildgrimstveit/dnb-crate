/**
 * Processed-deck regression corpus (T7, 12 October review).
 *
 * Complements the source-probe suite: instead of re-opening the SOURCE
 * files, this suite decodes the RENDERED MASTER's overlap region and
 * measures its kick onset train against the projected OUTPUT grid —
 * validating the renderer's actual processing (tempo conversion, band
 * filters, blend) preserves beat timing at the join.
 *
 * Both decks of a tempo-matched join land on the SAME output grid, so the
 * mixed overlap's onsets measure processed-deck timing without per-dek
 * attribution (documented limitation: a residual implicates
 * placement/processing of the pair, and the source-probe suite localizes
 * which side).
 *
 * Negative controls are injected AFTER preparation (source and frozen grid
 * stay correct): plan-placement shifts of +40/+80 ms, and a hidden rate
 * error (audio at 174.5 BPM under a 174 grid) that produces growing
 * drift across the overlap.
 *
 * Taxonomy (explicit, separating detection from measurement quality):
 *   TRUE-POSITIVE / TRUE-NEGATIVE / FALSE-ALARM / DEFECT-ESCAPE /
 *   ABSTAINED / INFRASTRUCTURE-ERROR. Measured offsets are compared
 * against the injected error with a stated tolerance, independent of the
 * detection verdict.
 *
 * Usage: pnpm tsx tools/scripts/processed-deck-corpus.mts
 * Requires ffmpeg. Unique timestamped report to tools/reports/.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";
import { lowpass, onsetTimesMs } from "../../packages/catalog/src/render/audio-diagnostics.ts";

const SAMPLE_RATE = 44_100;
const BPM = 174;
const BEAT_MS = 60_000 / BPM;
const BAR_MS = BEAT_MS * 4;
const OVERLAP_BARS = 16;
const OVERLAP_MS = Math.round(BAR_MS * OVERLAP_BARS);
const PASS_MS = 20;
const MEASURE_TOLERANCE_MS = 15;

type CaseSpec = {
  id: string;
  description: string;
  incomingBpm: number;
  /** Actual audio tempo of the incoming (rate-error control: differs from grid). */
  incomingActualBpm: number;
  targetBpm: number;
  /** Post-preparation placement error injected into the plan (ms). */
  incomingShiftMs: number;
  sparseIncoming: boolean;
  expected: "pass" | "flag" | "abstain";
  injectedErrorMs: number | null;
};

const CASES: CaseSpec[] = [
  {
    id: "aligned-equal",
    description: "174/174 aligned, rate 1 - harness calibration control",
    incomingBpm: BPM,
    incomingActualBpm: BPM,
    targetBpm: BPM,
    incomingShiftMs: 0,
    sparseIncoming: false,
    expected: "pass",
    injectedErrorMs: null,
  },
  {
    id: "aligned-unequal",
    description: "174/178 into a 175 target — both decks rate-stretched",
    incomingBpm: 178,
    incomingActualBpm: 178,
    targetBpm: 175,
    incomingShiftMs: 0,
    sparseIncoming: false,
    expected: "pass",
    injectedErrorMs: null,
  },
  {
    id: "shift-40",
    description: "incoming placed +40 ms after preparation",
    incomingBpm: BPM,
    incomingActualBpm: BPM,
    targetBpm: BPM,
    incomingShiftMs: 40,
    sparseIncoming: false,
    expected: "flag",
    injectedErrorMs: 40,
  },
  {
    id: "shift-80",
    description: "incoming placed +80 ms after preparation",
    incomingBpm: BPM,
    incomingActualBpm: BPM,
    targetBpm: BPM,
    incomingShiftMs: 80,
    sparseIncoming: false,
    expected: "flag",
    injectedErrorMs: 80,
  },
  {
    id: "rate-error",
    description: "incoming audio at 173 under a 174 grid (hidden rate error)",
    incomingBpm: BPM,
    incomingActualBpm: 173,
    targetBpm: BPM,
    incomingShiftMs: 0,
    sparseIncoming: false,
    expected: "flag",
    injectedErrorMs: null,
  },
  {
    id: "sparse-incoming",
    description:
      "incoming kicks only in the first bar - the outgoing dense train still anchors the output grid (coverage note; per-deck abstention is the source-probe domain)",
    incomingBpm: BPM,
    incomingActualBpm: BPM,
    targetBpm: BPM,
    incomingShiftMs: 0,
    sparseIncoming: true,
    expected: "pass",
    injectedErrorMs: 80,
  },
];

async function writeKickWav(
  filePath: string,
  options: { bars: number; leadInBars: number; bpm: number; kicksOnlyFirstBars?: number },
): Promise<number[]> {
  const beatMs = 60_000 / options.bpm;
  const barMs = beatMs * 4;
  const totalBars = options.leadInBars + options.bars + 4;
  const samples = Math.ceil((totalBars * barMs * SAMPLE_RATE) / 1000);
  const data = Buffer.alloc(samples * 4);
  const beatTimes: number[] = [];
  const kicksUpTo =
    options.kicksOnlyFirstBars == null
      ? Number.POSITIVE_INFINITY
      : options.leadInBars + options.kicksOnlyFirstBars;
  for (let beat = 0; beat < totalBars * 4; beat += 1) {
    const beatMs2 = beat * beatMs;
    beatTimes.push(Number(beatMs2.toFixed(3)));
    if (beat / 4 >= kicksUpTo) continue;
    const start = Math.floor((beatMs2 * SAMPLE_RATE) / 1000);
    for (let i = 0; i < Math.floor((120 * SAMPLE_RATE) / 1000); i += 1) {
      const t = i / SAMPLE_RATE;
      const envelope = Math.exp(-t * 30);
      const value = Math.sin(2 * Math.PI * 60 * t) * envelope * 0.7;
      const idx = start + i;
      for (const ch of [0, 1]) {
        const offset = idx * 4 + ch * 2;
        if (offset + 2 <= data.length) {
          data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(value * 32767))), offset);
        }
      }
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.concat([header, data]));
  return beatTimes;
}

type Outcome =
  | "TRUE-POSITIVE"
  | "TRUE-NEGATIVE"
  | "FALSE-ALARM"
  | "DEFECT-ESCAPE"
  | "ABSTAINED"
  | "INFRASTRUCTURE-ERROR";

type CaseResult = {
  id: string;
  expected: CaseSpec["expected"];
  verdict: Outcome;
  medianOffsetMs: number | null;
  driftMs: number | null;
  onsetCount: number;
  offsetErrorVsInjectedMs: number | null;
  /** Stretch engines the render manifest records for this case. atempo
   * carries a measured +12.8 ms group delay vs its projected grid (see
   * tools/scripts/measure-stretch-latency.mts), so off-grid measurements
   * stratify by engine before they are read as renderer defects. */
  stretchEngines: string[] | null;
  runtimeMs: number;
  detail: string | null;
};

async function runCase(spec: CaseSpec, harnessBiasMs: number): Promise<CaseResult> {
  const root = path.join(os.tmpdir(), `dnb-procdsk-${spec.id}-${crypto.randomUUID()}`);
  const library = path.join(root, "library");
  const config = {
    ...loadConfig(),
    databasePath: path.join(root, "catalog.sqlite"),
    libraryRoots: [library],
    outputRoot: path.join(root, "output"),
    logLevel: "error" as const,
    supportedExtensions: [".wav"],
  };
  const runtime = createCatalogRuntime(config);
  const started = Date.now();
  try {
    await mkdir(library, { recursive: true });
    const outBeats = await writeKickWav(path.join(library, "outgoing.wav"), {
      bars: OVERLAP_BARS + 8,
      leadInBars: 8,
      bpm: BPM,
    });
    const inBeats = await writeKickWav(path.join(library, "incoming.wav"), {
      bars: OVERLAP_BARS + 8,
      leadInBars: 4,
      bpm: spec.incomingActualBpm,
      kicksOnlyFirstBars: spec.sparseIncoming ? 1 : undefined,
    });
    await runtime.service.scanLibrary();
    const rows = runtime.repository.listAll();
    const outRow = rows.find((t) => t.title === "outgoing")!;
    const inRow = rows.find((t) => t.title === "incoming")!;

    const gridFor = (id: string, beats: number[], bpm: number, reference: boolean) => {
      runtime.analyses.upsert({
        trackId: id,
        analyzerName: "dnb-crate-dsp",
        analyzerVersion: "3.0.0",
        bpm,
        bpmConfidence: 0.95,
        bpmRaw: bpm,
        referenceBpm: null,
        beatTimesMs: beats,
        downbeatTimesMs: beats.filter((_, i) => i % 4 === 0),
        gridRejected: false,
        gridRejectionReason: null,
        gridSource: reference ? "reference" : "analyzed",
        musicalKey: null,
        keyConfidence: null,
        keyMode: null,
        camelotKey: null,
        tempoStability: 0.95,
        downbeatConfidence: 0.9,
        integratedLufs: null,
        truePeakDb: null,
        lowBandEnergy: null,
        midBandEnergy: null,
        highBandEnergy: null,
        waveformSummary: null,
        beatAnchorMs: null,
        // The stored GRID claims spec.incomingBpm — the rate-error control
        // hides an actual-audio mismatch the processing must reveal.
        descriptors: null,
        engineRuntimeMs: 1,
        analyzedAt: new Date().toISOString(),
        suggestedCues: [],
        sections: [],
      });
    };
    gridFor(outRow.id, outBeats, BPM, false);
    gridFor(inRow.id, inBeats, spec.incomingBpm, false);

    const target = spec.targetBpm;
    const outRate = target / BPM;
    const inRate = target / spec.incomingBpm;
    const outMixOutMs = Math.round(8 * BAR_MS);
    const alignedInStart = Math.round(4 * BAR_MS);
    const inStartMs = alignedInStart + spec.incomingShiftMs;
    const inSourceEnd = Math.round(inRow.durationMs - 1500);
    const plan = {
      schemaVersion: 1 as const,
      id: crypto.randomUUID(),
      name: `procdsk-${spec.id}`,
      targetDurationMs: 60_000,
      targetBpm: target,
      requestedArc: [
        { atFraction: 0, targetEnergy: 5 },
        { atFraction: 1, targetEnergy: 5 },
      ],
      entries: [
        {
          id: crypto.randomUUID(),
          trackId: outRow.id,
          order: 0,
          sourceStartMs: 0,
          sourceEndMs: outMixOutMs + OVERLAP_MS,
          timelineStartMs: 0,
          playbackRate: outRate,
          gainDb: 0,
          transitionToNext: {
            id: crypto.randomUUID(),
            type: "phrase_mix" as const,
            durationMs: OVERLAP_MS,
            outgoingCuePointId: null,
            incomingCuePointId: null,
            parameters: {
              barCount: OVERLAP_BARS,
              targetBpm: target,
              mixOutMs: outMixOutMs,
              mixInMs: inStartMs,
              incomingTrackId: inRow.id,
              // Fully resolved pin (as buildEntries stamps): the renderer's
              // resolved-placement branch honors these verbatim and does not
              // re-derive, so the injected shift survives into the master.
              downbeatOffsetMs: 0,
              alignmentMode: "bar",
              alignmentPeriodMs: Number(((60_000 / target) * 4).toFixed(3)),
              recipeVersion: 1,
            },
          },
        },
        {
          id: crypto.randomUUID(),
          trackId: inRow.id,
          order: 1,
          sourceStartMs: inStartMs,
          sourceEndMs: inSourceEnd,
          timelineStartMs: outMixOutMs,
          playbackRate: inRate,
          gainDb: 0,
          transitionToNext: null,
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    runtime.setPlans.save(plan, 1, {
      seed: 1,
      selected: [],
      rejected: [],
      harmonicCoverage: { knownJoins: 0, totalJoins: 0 },
    });
    const render = await runtime.service.startSetRender({
      setPlanId: plan.id,
      allowLowConfidence: true,
    });
    const done = await runtime.service.waitForRenderJob(render.job.id, 120_000);
    // waitForRenderJob returns the public RenderJob view (no manifest); the
    // manifest - including the stretch engines we stratify by - comes from
    // the dedicated reader, available once the job succeeded.
    let engines: string[] | null = null;
    if (done.status === "succeeded") {
      try {
        engines = runtime.service.getRenderManifest(done.id).stretchEngines ?? null;
      } catch {
        engines = null;
      }
    }
    if (done.status !== "succeeded") {
      return {
        id: spec.id,
        expected: spec.expected,
        verdict: "INFRASTRUCTURE-ERROR",
        medianOffsetMs: null,
        driftMs: null,
        onsetCount: 0,
        offsetErrorVsInjectedMs: null,
        stretchEngines: engines,
        runtimeMs: Date.now() - started,
        detail: `render ${done.status}: ${done.errorMessage ?? ""}`,
      };
    }

    // Decode the master's overlap window (output time): the join lands at
    // timeline outMixOutMs and lasts OVERLAP_MS.
    const masterPath = path.join(config.outputRoot, done.outputRootRelativePath!);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const raw = path.join(root, "overlap.pcm");
    await run("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-ss",
      (outMixOutMs / 1000).toFixed(3),
      "-t",
      (OVERLAP_MS / 1000).toFixed(3),
      "-i",
      masterPath,
      "-f",
      "f32le",
      "-ac",
      "1",
      "-ar",
      "22050",
      raw,
    ]);
    const { readFile } = await import("node:fs/promises");
    const pcmBuffer = await readFile(raw);
    const samples = new Float32Array(pcmBuffer.length / 4);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = pcmBuffer.readFloatLE(i * 4);
    }
    const kick = lowpass(samples, 22_050, 180);
    const onsets = onsetTimesMs(kick, 22_050);
    if (onsets.length < 6) {
      const verdict: Outcome = spec.expected === "abstain" ? "ABSTAINED" : "DEFECT-ESCAPE";
      return {
        id: spec.id,
        expected: spec.expected,
        verdict,
        medianOffsetMs: null,
        driftMs: null,
        onsetCount: onsets.length,
        offsetErrorVsInjectedMs: null,
        stretchEngines: engines,
        runtimeMs: Date.now() - started,
        detail: `insufficient onsets (${onsets.length})`,
      };
    }

    // Expected OUTPUT grid: at target BPM from the join start (both decks
    // project onto it when processing is correct). Residuals wrapped at
    // the beat; halves report drift. The CALIBRATION control's median
    // (onset-picker attack lag, decode offsets) is subtracted so reported
    // offsets are error-vs-control, not absolute hardware bias.
    const beatOut = 60_000 / target;
    const wrap = (delta: number) => {
      let d = delta % beatOut;
      if (d > beatOut / 2) d -= beatOut;
      if (d < -beatOut / 2) d += beatOut;
      return d;
    };
    const residual = (time: number) => wrap(time % beatOut);
    const residuals = onsets
      .map(residual)
      .map((r) => wrap(r - harnessBiasMs))
      .sort((a, b) => a - b);
    const rawMedian = residuals[Math.floor(residuals.length / 2)]!;
    const median = rawMedian;
    const half = onsets.filter((_, i) => i % 2 === 0).map(residual);
    const secondHalf = onsets.filter((_, i) => i % 2 === 1).map(residual);
    const medianOf = (list: number[]) => {
      if (list.length === 0) return null;
      const sorted = [...list].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)]!;
    };
    const startMedian = medianOf(half);
    const endMedian = medianOf(secondHalf);
    const drift =
      startMedian != null && endMedian != null ? Math.abs(endMedian - startMedian) : null;
    // Bimodal-aware detection: a shifted deck puts only ITS onsets off
    // grid while the other deck anchors 0 — the global median collapses
    // to the clean cluster. Detect via the outlier cluster: onsets at
    // least PASS_MS off grid, when they make up a meaningful minority.
    const outliers = residuals.filter((r) => Math.abs(r) >= PASS_MS);
    const outlierFraction = outliers.length / residuals.length;
    const defectOffset = outliers.length > 0 ? medianOf(outliers) : null;
    const detected =
      Math.abs(median) >= PASS_MS ||
      (drift ?? 0) >= PASS_MS ||
      (outlierFraction >= 0.25 && Math.abs(defectOffset ?? 0) >= PASS_MS);

    let verdict: Outcome;
    if (spec.expected === "pass") {
      verdict = detected ? "FALSE-ALARM" : "TRUE-NEGATIVE";
    } else if (spec.expected === "flag") {
      verdict = detected ? "TRUE-POSITIVE" : "DEFECT-ESCAPE";
    } else {
      // expected abstain but measured: measurement supersedes the expectation
      verdict = detected ? "TRUE-POSITIVE" : "TRUE-NEGATIVE";
    }
    const offsetErrorVsInjectedMs =
      spec.injectedErrorMs != null && defectOffset != null
        ? Math.abs(Math.abs(defectOffset) - spec.injectedErrorMs)
        : null;
    return {
      id: spec.id,
      expected: spec.expected,
      verdict,
      medianOffsetMs: Number(median.toFixed(1)),
      driftMs: drift == null ? null : Number(drift.toFixed(1)),
      onsetCount: onsets.length,
      offsetErrorVsInjectedMs:
        offsetErrorVsInjectedMs == null ? null : Number(offsetErrorVsInjectedMs.toFixed(1)),
      stretchEngines: engines,
      runtimeMs: Date.now() - started,
      detail:
        [
          defectOffset != null
            ? `defect cluster ${defectOffset.toFixed(1)} ms (${Math.round(outlierFraction * 100)}% of onsets)`
            : null,
          engines?.includes("atempo")
            ? "atempo engine: +12.8 ms group delay expected vs projected grid (measured 2026-10-12)"
            : null,
        ]
          .filter((part) => part != null)
          .join("; ") || null,
    };
  } catch (error) {
    return {
      id: spec.id,
      expected: spec.expected,
      verdict: "INFRASTRUCTURE-ERROR",
      medianOffsetMs: null,
      driftMs: null,
      onsetCount: 0,
      offsetErrorVsInjectedMs: null,
      stretchEngines: null,
      runtimeMs: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}

const results: CaseResult[] = [];
// Calibration: the aligned control's raw median IS the harness bias
// (onset attack lag + decode offset); everything else is measured against
// it. A first run collects the bias, then all cases run calibrated.
process.stdout.write("calibrating on aligned-equal... ");
const calibration = await runCase(CASES[0]!, 0);
const harnessBiasMs = calibration.medianOffsetMs ?? 0;
process.stdout.write(`bias ${harnessBiasMs} ms\n`);
for (const spec of CASES) {
  process.stdout.write(`running ${spec.id}... `);
  const result = await runCase(spec, harnessBiasMs);
  results.push(result);
  process.stdout.write(
    `${result.verdict} (offset ${result.medianOffsetMs ?? "-"} ms, drift ${result.driftMs ?? "-"} ms, n=${result.onsetCount}, engine ${(result.stretchEngines ?? ["?"]).join("+")})\n`,
  );
}

const summary = {
  generatedAt: new Date().toISOString(),
  suite: "processed-deck",
  measureToleranceMs: MEASURE_TOLERANCE_MS,
  counts: {
    truePositives: results.filter((r) => r.verdict === "TRUE-POSITIVE").length,
    trueNegatives: results.filter((r) => r.verdict === "TRUE-NEGATIVE").length,
    falseAlarms: results.filter((r) => r.verdict === "FALSE-ALARM").length,
    defectEscapes: results.filter((r) => r.verdict === "DEFECT-ESCAPE").length,
    abstained: results.filter((r) => r.verdict === "ABSTAINED").length,
    infrastructureErrors: results.filter((r) => r.verdict === "INFRASTRUCTURE-ERROR").length,
  },
  // Engine stratification: atempo carries a measured +12.8 ms group delay
  // vs its projected grid, so a case's engine belongs next to any off-grid
  // reading before it is read as a renderer defect.
  byStretchEngine: Object.entries(
    results.reduce<Record<string, { cases: number; maxAbsOffsetMs: number | null }>>((acc, r) => {
      const key = (r.stretchEngines ?? ["unknown"]).join("+");
      const prev = acc[key] ?? { cases: 0, maxAbsOffsetMs: null };
      acc[key] = {
        cases: prev.cases + 1,
        maxAbsOffsetMs:
          r.medianOffsetMs == null
            ? prev.maxAbsOffsetMs
            : Math.max(prev.maxAbsOffsetMs ?? 0, Math.abs(r.medianOffsetMs)),
      };
      return acc;
    }, {}),
  ).map(([engine, stats]) => ({ engine, ...stats })),
  offsetErrorsWithinTolerance: results
    .filter((r) => r.offsetErrorVsInjectedMs != null)
    .map((r) => ({
      id: r.id,
      error: r.offsetErrorVsInjectedMs,
      within: (r.offsetErrorVsInjectedMs ?? 99) <= MEASURE_TOLERANCE_MS,
    })),
  totalRuntimeMs: results.reduce((s, r) => s + r.runtimeMs, 0),
};

console.log("\nProcessed-deck corpus (rendered output vs projected grid)");
console.log(JSON.stringify({ results, summary }, null, 2));

const { writeFile: writeOut, mkdir: mkdirOut } = await import("node:fs/promises");
const reportDir = path.join(import.meta.dirname, "..", "reports");
await mkdirOut(reportDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeOut(
  path.join(reportDir, `processed-deck-${stamp}.json`),
  JSON.stringify({ summary, results }, null, 2),
);
console.log(`report: tools/reports/processed-deck-${stamp}.json`);
