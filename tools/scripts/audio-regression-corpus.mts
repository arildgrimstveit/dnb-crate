/**
 * Audio regression corpus (S9 stage 2, 11 October review).
 *
 * Repeatable local verification of the source-deck probe against SYNTHETIC
 * ground truth: each case renders a two-deck join whose true misalignment is
 * known by construction, then measures what the verifier reports. The report
 * separates:
 *   - TRUE POSITIVES  (defect injected, verifier flags: fail/review)
 *   - TRUE NEGATIVES  (aligned or whole-beat-equivalent, verifier passes)
 *   - ABSTENTIONS     (sparse evidence, verifier declines to judge)
 *   - FALSE PASS/FAIL (verdict disagrees with the known ground truth)
 * plus measured offsets vs the injected ones, coverage, and per-case runtime.
 *
 * The corpus uses NO saved joins, NO listening history, and NO approved
 * transitions - a cold catalog built entirely from generated fixtures, per
 * the automatic-quality direction. Musical quality is out of scope: these
 * are technical timing/processing labels only.
 *
 * Usage: pnpm tsx tools/scripts/audio-regression-corpus.mts [--json]
 * Requires ffmpeg on PATH. Writes a dated JSON report to tools/reports/.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";

const SAMPLE_RATE = 44_100;
const BPM = 174;
const BEAT_MS = 60_000 / BPM;
const BAR_MS = BEAT_MS * 4;
const BARS = 16;
const OVERLAP_MS = Math.round(BAR_MS * BARS);

type CaseSpec = {
  id: string;
  description: string;
  /** Injected placement error of the incoming deck, in output ms. */
  incomingOffsetMs: number;
  /** Tempo error of the incoming audio relative to its grid (fraction). */
  incomingTempoError?: number;
  /** Sparse evidence: kicks only in the first N bars. */
  incomingKicksOnlyFirstBars?: number;
  expected: "flag" | "pass" | "abstain";
};

const CASES: CaseSpec[] = [
  {
    id: "aligned",
    description: "aligned control (0 ms)",
    incomingOffsetMs: 0,
    expected: "pass",
  },
  {
    id: "shift-40",
    description: "incoming placed +40 ms late",
    incomingOffsetMs: 40,
    expected: "flag",
  },
  {
    id: "shift-80",
    description: "incoming placed +80 ms late",
    incomingOffsetMs: 80,
    expected: "flag",
  },
  {
    id: "shift-140",
    description: "incoming placed +140 ms late",
    incomingOffsetMs: 140,
    expected: "flag",
  },
  {
    id: "whole-beat",
    description: "incoming one whole beat apart (phase-equivalent by design)",
    incomingOffsetMs: Math.round(BEAT_MS),
    expected: "pass",
  },
  {
    id: "half-beat",
    description: "incoming half a beat apart (~172 ms)",
    incomingOffsetMs: Math.round(BEAT_MS / 2),
    expected: "flag",
  },
  {
    id: "drift",
    description: "incoming tempo +0.4% against its grid (slow drift)",
    incomingOffsetMs: 0,
    incomingTempoError: 0.004,
    expected: "flag",
  },
  {
    id: "sparse",
    description: "incoming kicks only in the first bar (sparse evidence)",
    incomingOffsetMs: 80,
    incomingKicksOnlyBars: 1,
    expected: "abstain",
  },
] as CaseSpec[];

/** Write a 16-bit stereo WAV whose kick sits exactly on each grid beat. */
async function writeKickTrainWav(
  filePath: string,
  options: {
    bars: number;
    leadInBars: number;
    tempoError?: number;
    kicksOnlyFirstBars?: number;
    /** Shifts the AUDIO relative to the grid this script will store — the
     * stale-grid/audio-misalignment defect class (a plan-placement error is
     * healed by the renderer's own alignment application, so the injection
     * must live in the audio). */
    audioOffsetMs?: number;
  },
): Promise<{ beatTimesMs: number[]; durationMs: number }> {
  const totalBars = options.leadInBars + options.bars + 4;
  const samples = Math.ceil((totalBars * BAR_MS * SAMPLE_RATE) / 1000);
  const data = Buffer.alloc(samples * 4); // 2ch int16
  const beatTimesMs: number[] = [];
  const kicksUpToBar =
    options.kicksOnlyFirstBars == null
      ? Number.POSITIVE_INFINITY
      : options.leadInBars + options.kicksOnlyFirstBars;
  const offset = options.audioOffsetMs ?? 0;
  for (let beat = 0; beat < totalBars * 4; beat += 1) {
    const beatMs = beat * BEAT_MS * (1 + (options.tempoError ?? 0));
    beatTimesMs.push(Number(beatMs.toFixed(3)));
    if (beat / 4 >= kicksUpToBar) {
      continue;
    }
    const start = Math.floor(((beatMs + offset) * SAMPLE_RATE) / 1000);
    // 60 Hz exponential-decay kick, 120 ms.
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
  return { beatTimesMs, durationMs: (samples / SAMPLE_RATE) * 1000 };
}

type CaseResult = {
  id: string;
  description: string;
  expected: CaseSpec["expected"];
  status: string;
  measuredOffsetMs: number | null;
  driftMs: number | null;
  outgoingLocked: number | null;
  incomingLocked: number | null;
  sourceIdentity: string | null;
  runtimeMs: number;
  classification: "true-positive" | "true-negative" | "abstention" | "FALSE-PASS" | "FALSE-FAIL";
};

async function runCase(spec: CaseSpec): Promise<CaseResult> {
  const root = path.join(os.tmpdir(), `dnb-corpus-${spec.id}-${crypto.randomUUID()}`);
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
  const startedAt = Date.now();
  try {
    await mkdir(library, { recursive: true });
    const outWav = await writeKickTrainWav(path.join(library, "outgoing.wav"), {
      bars: BARS + 8,
      leadInBars: 8,
    });
    const inWav = await writeKickTrainWav(path.join(library, "incoming.wav"), {
      bars: BARS + 8,
      leadInBars: 4,
      tempoError: spec.incomingTempoError,
      kicksOnlyFirstBars: (spec as { incomingKicksOnlyBars?: number }).incomingKicksOnlyBars,
      audioOffsetMs: spec.incomingOffsetMs,
    });
    // A real scan establishes fingerprints/durations the renderer verifies.
    await runtime.service.scanLibrary();
    const scanned = runtime.repository.listAll();
    const outRow = scanned.find((t) => t.title === "outgoing")!;
    const inRow = scanned.find((t) => t.title === "incoming")!;
    const outId = outRow.id;
    const inId = inRow.id;
    const upsertGrid = (id: string, beats: number[]) => {
      runtime.analyses.upsert({
        trackId: id,
        analyzerName: "dnb-crate-dsp",
        analyzerVersion: "3.0.0",
        bpm: BPM,
        bpmConfidence: 0.95,
        bpmRaw: BPM,
        referenceBpm: null,
        beatTimesMs: beats,
        downbeatTimesMs: beats.filter((_, i) => i % 4 === 0),
        gridRejected: false,
        gridRejectionReason: null,
        gridSource: "analyzed",
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
        descriptors: null,
        engineRuntimeMs: 1,
        analyzedAt: new Date().toISOString(),
        suggestedCues: [],
        sections: [],
      });
    };
    upsertGrid(outId, outWav.beatTimesMs);
    upsertGrid(inId, inWav.beatTimesMs);

    // The join is placed aligned; the INCOMING's mixInMs in the plan stays
    // aligned (the defect lives in its audio vs its stored grid).
    const outMixOutMs = Math.round(8 * BAR_MS);
    const alignedInStart = Math.round(4 * BAR_MS);
    const inStartMs = alignedInStart;
    const plan = {
      schemaVersion: 1 as const,
      id: crypto.randomUUID(),
      name: `corpus-${spec.id}`,
      targetDurationMs: 60_000,
      targetBpm: BPM,
      requestedArc: [
        { atFraction: 0, targetEnergy: 5 },
        { atFraction: 1, targetEnergy: 5 },
      ],
      entries: [
        {
          id: crypto.randomUUID(),
          trackId: outId,
          order: 0,
          sourceStartMs: 0,
          sourceEndMs: outMixOutMs + OVERLAP_MS,
          timelineStartMs: 0,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: {
            id: crypto.randomUUID(),
            type: "phrase_mix" as const,
            durationMs: OVERLAP_MS,
            outgoingCuePointId: null,
            incomingCuePointId: null,
            parameters: {
              barCount: BARS,
              targetBpm: BPM,
              mixOutMs: outMixOutMs,
              mixInMs: inStartMs,
              incomingTrackId: inId,
            },
          },
        },
        {
          id: crypto.randomUUID(),
          trackId: inId,
          order: 1,
          sourceStartMs: inStartMs,
          sourceEndMs: Math.round(inRow.durationMs - 1500),
          timelineStartMs: outMixOutMs,
          playbackRate: 1,
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
    if (done.status !== "succeeded") {
      return {
        id: spec.id,
        description: spec.description,
        expected: spec.expected,
        status: `render-${done.status}`,
        measuredOffsetMs: null,
        driftMs: null,
        outgoingLocked: null,
        incomingLocked: null,
        sourceIdentity: null,
        runtimeMs: Date.now() - startedAt,
        classification: "FALSE-FAIL",
      };
    }
    const checked = await runtime.service.checkRender(done.id, undefined, {
      audioVerification: "full",
    });
    const join = checked.joins[0];
    const probe = join?.sourceDeckProbe ?? null;
    const status = join?.audioStatus ?? "none";
    const measured = probe?.verification.deckOffsetMs ?? null;
    const drift =
      probe?.verification.startHalfOffsetMs != null && probe?.verification.endHalfOffsetMs != null
        ? Math.abs(probe.verification.endHalfOffsetMs - probe.verification.startHalfOffsetMs)
        : null;
    let classification: CaseResult["classification"];
    if (status === "unmeasured") {
      classification = spec.expected === "abstain" ? "abstention" : "FALSE-PASS";
    } else if (status === "pass") {
      classification = spec.expected === "pass" ? "true-negative" : ("FALSE-PASS" as const);
    } else {
      classification = spec.expected === "flag" ? "true-positive" : ("FALSE-FAIL" as const);
    }
    return {
      id: spec.id,
      description: spec.description,
      expected: spec.expected,
      status,
      measuredOffsetMs: measured,
      driftMs: drift,
      outgoingLocked: probe?.outgoingLockedCount ?? null,
      incomingLocked: probe?.incomingLockedCount ?? null,
      sourceIdentity: probe?.sourceIdentity ?? null,
      runtimeMs: Date.now() - startedAt,
      classification,
    };
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}

const results: CaseResult[] = [];
for (const spec of CASES) {
  process.stdout.write(`running ${spec.id}... `);
  try {
    const result = await runCase(spec);
    results.push(result);
    process.stdout.write(`${result.status} (${result.classification})\n`);
  } catch (error) {
    const result: CaseResult = {
      id: spec.id,
      description: spec.description,
      expected: spec.expected,
      status: `error: ${error instanceof Error ? error.message : String(error)}`,
      measuredOffsetMs: null,
      driftMs: null,
      outgoingLocked: null,
      incomingLocked: null,
      sourceIdentity: null,
      runtimeMs: 0,
      classification: "FALSE-FAIL",
    };
    results.push(result);
    process.stdout.write(`ERROR ${result.status}\n`);
  }
}

const summary = {
  cases: results.length,
  truePositives: results.filter((r) => r.classification === "true-positive").length,
  trueNegatives: results.filter((r) => r.classification === "true-negative").length,
  abstentions: results.filter((r) => r.classification === "abstention").length,
  falsePasses: results.filter((r) => r.classification === "FALSE-PASS").length,
  falseFails: results.filter((r) => r.classification === "FALSE-FAIL").length,
  totalRuntimeMs: results.reduce((sum, r) => sum + r.runtimeMs, 0),
};

console.log("\nAudio regression corpus (synthetic ground truth)");
const width = 14;
console.log(
  [
    "case".padEnd(width),
    "expected".padEnd(8),
    "status".padEnd(11),
    "meas".padEnd(7),
    "drift".padEnd(7),
    "locked".padEnd(9),
    "class".padEnd(15),
    "ms",
  ].join(" "),
);
for (const r of results) {
  console.log(
    [
      r.id.padEnd(width),
      r.expected.padEnd(8),
      r.status.padEnd(11),
      r.measuredOffsetMs == null ? "-" : r.measuredOffsetMs.toFixed(1).padEnd(7),
      r.driftMs == null ? "-" : r.driftMs.toFixed(1).padEnd(7),
      `${r.outgoingLocked ?? "-"}/${r.incomingLocked ?? "-"}`.padEnd(9),
      r.classification.padEnd(15),
      String(r.runtimeMs),
    ].join(" "),
  );
}
console.log("\nsummary:", JSON.stringify(summary, null, 2));

const report = {
  generatedAt: new Date().toISOString(),
  bpm: BPM,
  bars: BARS,
  renderer: "real ffmpeg",
  results,
  summary,
};
const reportDir = path.join(import.meta.dirname, "..", "reports");
await mkdir(reportDir, { recursive: true });
await writeFile(
  path.join(reportDir, `audio-regression-${new Date().toISOString().slice(0, 10)}.json`),
  JSON.stringify(report, null, 2),
);
console.log(`report written to tools/reports/`);
