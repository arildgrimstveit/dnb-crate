import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import { loadConfig, resolveJoinInputs } from "../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";
import { lowpass, onsetTimesMs } from "../../packages/catalog/src/render/audio-diagnostics.ts";
import { resolveRubberbandCli } from "../../packages/audio-renderer/src/rubberband-cli.ts";

const run = promisify(execFile);

/**
 * Unequal-rate placement attribution (T7, 12 October 2026).
 *
 * The processed-deck corpus's aligned-unequal case (174/178 into 175, both
 * decks stretched, R3 CLI engine) measures +24.8 ms median / +74.8 ms defect
 * cluster although every stretch path is latency-clean (see
 * measure-stretch-latency.mts). This script answers WHERE the offset enters:
 *
 *   plan pins -> manifest per-track placement -> rendered audio onsets
 *
 * It renders the equal control and the unequal case, reads each manifest's
 * per-track sourceStartMs/timelineStartMs/playbackRate, computes where each
 * deck's kicks MUST land if the renderer executed the manifest faithfully,
 * then assigns the master's measured onsets to the nearest expected kick and
 * reports per-deck residuals. Outcomes:
 *   - manifest != plan        -> the planner/resolved-placement math moved it
 *   - manifest == plan but audio != manifest -> the render pipeline moved it
 *   - audio == manifest (off-grid) -> the placement REQUEST is off-grid and
 *     the corpus case measured its own fixture, not a renderer defect
 *
 * Requires ffmpeg on PATH. Not part of CI (diagnostic).
 * Usage: pnpm tsx tools/scripts/unequal-rate-attribution.mts
 */

const SAMPLE_RATE = 44_100;
const BPM = 174;
const BEAT_MS = 60_000 / BPM;
const BAR_MS = BEAT_MS * 4;
const OVERLAP_BARS = 16;
const OVERLAP_MS = Math.round(BAR_MS * OVERLAP_BARS);
const OUT_MIX_OUT_MS = Math.round(8 * BAR_MS);
// Kick-aligned for the incoming's own tempo (matches the corpus post-fix).
const IN_START_MS = Math.round(4 * ((60_000 / 178) * 4));

async function writeKickWav(
  filePath: string,
  options: { bars: number; leadInBars: number; bpm: number },
): Promise<number[]> {
  const beatMs = 60_000 / options.bpm;
  const barMs = beatMs * 4;
  const totalBars = options.leadInBars + options.bars + 4;
  const samples = Math.ceil((totalBars * barMs * SAMPLE_RATE) / 1000);
  const data = Buffer.alloc(samples * 4);
  const beatTimes: number[] = [];
  for (let beat = 0; beat < totalBars * 4; beat += 1) {
    const beatMs2 = beat * beatMs;
    beatTimes.push(Number(beatMs2.toFixed(3)));
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

type Rendered = {
  masterPath: string;
  invocation: string | null;
  manifestTracks: Array<{
    trackId: string;
    sourceStartMs: number;
    sourceEndMs: number;
    timelineStartMs: number;
    playbackRate: number;
    overlapToNextMs: number | null;
  }>;
  planRequested: {
    outSourceEndMs: number;
    inSourceStartMs: number;
    inTimelineStartMs: number;
    outRate: number;
    inRate: number;
  };
  kicks: { outgoing: number[]; incoming: number[] };
};

async function renderCase(incomingBpm: number, targetBpm: number): Promise<Rendered> {
  const inStartMs = Math.round(4 * ((60_000 / incomingBpm) * 4));
  const root = path.join(os.tmpdir(), `dnb-attr-${randomUUID()}`);
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
  try {
    await mkdir(library, { recursive: true });
    const outKicks = await writeKickWav(path.join(library, "outgoing.wav"), {
      bars: OVERLAP_BARS + 8,
      leadInBars: 8,
      bpm: BPM,
    });
    const inKicks = await writeKickWav(path.join(library, "incoming.wav"), {
      bars: OVERLAP_BARS + 8,
      leadInBars: 4,
      bpm: incomingBpm,
    });
    await runtime.service.scanLibrary();
    const rows = runtime.repository.listAll();
    const outRow = rows.find((t) => t.title === "outgoing")!;
    const inRow = rows.find((t) => t.title === "incoming")!;
    const gridFor = (id: string, beats: number[], bpm: number) => {
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
    gridFor(outRow.id, outKicks, BPM);
    gridFor(inRow.id, inKicks, incomingBpm);
    const outRate = targetBpm / BPM;
    const inRate = targetBpm / incomingBpm;
    const inSourceEnd = Math.round(inRow.durationMs - 1500);
    // Q03: the resolved pin is the stamped contract (recipeVersion retired).
    const attrResolution = resolveJoinInputs({
      outgoingEntryId: "attr-out",
      incomingEntryId: "attr-in",
      transitionId: "attr-join",
      geometry: {
        outgoingSourceStartMs: 0,
        outgoingSourceEndMs: OUT_MIX_OUT_MS + OVERLAP_MS,
        incomingSourceStartMs: inStartMs,
        incomingSourceEndMs: inSourceEnd,
        joinOutputAnchorMs: OUT_MIX_OUT_MS,
        overlapMs: OVERLAP_MS,
        outgoingRate: outRate,
        incomingRate: inRate,
        phraseBarCount:
          OVERLAP_BARS === 8 || OVERLAP_BARS === 16 || OVERLAP_BARS === 32 ? OVERLAP_BARS : 16,
      },
      outgoingDurationMs: outRow.durationMs,
      incomingDurationMs: inRow.durationMs,
      alignment: {
        mode: "bar",
        periodMs: Number(((60_000 / targetBpm) * 4).toFixed(3)),
        downbeatOffsetMs: 0,
        onsetLockBeats: null,
        confidence: null,
        coverage: null,
      },
      evidence: {
        outgoingFingerprint: outRow.fileFingerprint ?? "",
        incomingFingerprint: inRow.fileFingerprint ?? "",
        analyzerVersion: null,
        gridSource: null,
      },
      treatment: { type: "phrase_mix", params: { targetBpm } },
      gain: { gainDb: 0, source: "derived" },
    });
    if (attrResolution.status !== "resolved") {
      throw new Error(`attribution join did not resolve: ${attrResolution.detail}`);
    }
    const plan = {
      schemaVersion: 1 as const,
      id: randomUUID(),
      name: `attr-${incomingBpm}-${targetBpm}`,
      targetDurationMs: 60_000,
      targetBpm,
      requestedArc: [
        { atFraction: 0, targetEnergy: 5 },
        { atFraction: 1, targetEnergy: 5 },
      ],
      entries: [
        {
          id: randomUUID(),
          trackId: outRow.id,
          order: 0,
          sourceStartMs: 0,
          sourceEndMs: OUT_MIX_OUT_MS + OVERLAP_MS,
          timelineStartMs: 0,
          playbackRate: outRate,
          gainDb: 0,
          transitionToNext: {
            id: randomUUID(),
            type: "phrase_mix" as const,
            durationMs: OVERLAP_MS,
            outgoingCuePointId: null,
            incomingCuePointId: null,
            parameters: {
              barCount: OVERLAP_BARS,
              targetBpm,
              mixOutMs: OUT_MIX_OUT_MS,
              mixInMs: IN_START_MS,
              incomingTrackId: inRow.id,
              downbeatOffsetMs: 0,
              alignmentMode: "bar",
              alignmentPeriodMs: Number(((60_000 / targetBpm) * 4).toFixed(3)),
              resolvedJoin: attrResolution.context,
            },
          },
        },
        {
          id: randomUUID(),
          trackId: inRow.id,
          order: 1,
          sourceStartMs: inStartMs,
          sourceEndMs: inSourceEnd,
          timelineStartMs: OUT_MIX_OUT_MS,
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
    if (done.status !== "succeeded" || !done.outputRootRelativePath) {
      throw new Error(`render ${done.status}: ${done.errorMessage ?? ""}`);
    }
    const manifest = runtime.service.getRenderManifest(done.id);
    // Copy the master out before the runtime dir is removed.
    const masterPath = path.join(root, "master.wav");
    await readFile(path.join(config.outputRoot, done.outputRootRelativePath)).then((buf) =>
      writeFile(masterPath, buf),
    );
    return {
      masterPath,
      invocation: manifest.invocation ?? null,
      manifestTracks: manifest.tracks.map((t) => ({
        trackId: t.trackId,
        sourceStartMs: t.sourceStartMs,
        sourceEndMs: t.sourceEndMs,
        timelineStartMs: t.timelineStartMs,
        playbackRate: t.playbackRate,
        overlapToNextMs: t.overlapToNextMs,
      })),
      planRequested: {
        outSourceEndMs: OUT_MIX_OUT_MS + OVERLAP_MS,
        inSourceStartMs: inStartMs,
        inTimelineStartMs: OUT_MIX_OUT_MS,
        outRate,
        inRate,
      },
      kicks: { outgoing: outKicks, incoming: inKicks },
      root, // keep for the caller to clean up
    } as Rendered & { root: string };
  } finally {
    await runtime.close();
  }
}

type Case = Rendered & { root: string };

async function measureWindow(masterPath: string): Promise<number[]> {
  const raw = `${masterPath}.pcm`;
  await run("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-ss",
    (OUT_MIX_OUT_MS / 1000).toFixed(3),
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
  const buf = await readFile(raw);
  const samples = new Float32Array(buf.length / 4);
  for (let i = 0; i < samples.length; i += 1) samples[i] = buf.readFloatLE(i * 4);
  return onsetTimesMs(lowpass(samples, 22_050, 180), 22_050);
}

console.log("rendering equal control (bias)... ");
const equal = (await renderCase(BPM, BPM)) as Case;
const equalOnsets = await measureWindow(equal.masterPath);
const equalBeat = 60_000 / BPM;
const wrap = (d: number, beat: number) => {
  let x = d % beat;
  if (x > beat / 2) x -= beat;
  if (x < -beat / 2) x += beat;
  return x;
};
const bias = equalOnsets.map((t) => wrap(t % equalBeat, equalBeat)).sort((a, b) => a - b)[
  Math.floor(equalOnsets.length / 2)
]!;
console.log(`picker bias vs 174 grid: ${bias.toFixed(2)} ms (${equalOnsets.length} onsets)`);

console.log("rendering unequal case (174/178 -> 175)... ");
const unequal = (await renderCase(178, 175)) as Case;
const onsets = await measureWindow(unequal.masterPath);

const target = 175;
const beatTarget = 60_000 / target;
const [outTrack, inTrack] = unequal.manifestTracks;
console.log("\nmanifest placements vs plan request:");
console.log(
  `  outgoing: srcEnd manifest=${outTrack?.sourceEndMs} plan=${unequal.planRequested.outSourceEndMs} | rate manifest=${outTrack?.playbackRate.toFixed(6)} plan=${unequal.planRequested.outRate.toFixed(6)} | timeline=${outTrack?.timelineStartMs}`,
);
console.log(
  `  incoming: srcStart manifest=${inTrack?.sourceStartMs} plan=${unequal.planRequested.inSourceStartMs} | rate manifest=${inTrack?.playbackRate.toFixed(6)} plan=${unequal.planRequested.inRate.toFixed(6)} | timeline manifest=${inTrack?.timelineStartMs} plan=${unequal.planRequested.inTimelineStartMs}`,
);
console.log(
  `\nmanifest invocation (final graph):\n  ${(unequal.invocation ?? "<none>").slice(0, 2000)}`,
);

// Expected output-time positions of each deck's kicks per the MANIFEST.
const expectedFor = (track: (typeof unequal.manifestTracks)[number], kicks: number[]) =>
  kicks
    .filter((k) => k >= track.sourceStartMs && k <= track.sourceEndMs)
    .map(
      (k) =>
        track.timelineStartMs + (k - track.sourceStartMs) / track.playbackRate - OUT_MIX_OUT_MS,
    );

const outExpected = outTrack ? expectedFor(outTrack, unequal.kicks.outgoing) : [];
const inExpected = inTrack ? expectedFor(inTrack, unequal.kicks.incoming) : [];

// Assign each measured onset to the nearest expected kick of either deck.
const residuals: Array<{ deck: "out" | "in"; r: number }> = [];
for (const t of onsets) {
  const best = (list: number[]) =>
    list.length === 0
      ? Number.POSITIVE_INFINITY
      : Math.min(...list.map((e) => Math.abs(t - e - bias)));
  const dOut = best(outExpected);
  const dIn = best(inExpected);
  const deck = dOut <= dIn ? "out" : "in";
  const list = deck === "out" ? outExpected : inExpected;
  const e = list.reduce(
    (acc, x) => (Math.abs(t - x - bias) < Math.abs(t - acc - bias) ? x : acc),
    list[0]!,
  );
  residuals.push({ deck, r: t - e - bias });
}
const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
};
const outRs = residuals.filter((x) => x.deck === "out").map((x) => x.r);
const inRs = residuals.filter((x) => x.deck === "in").map((x) => x.r);
console.log(
  `\nmeasured onsets in window: ${onsets.length}; assigned outgoing=${outRs.length}, incoming=${inRs.length}`,
);
console.log(
  `  outgoing residuals vs manifest-implied positions: median ${med(outRs).toFixed(2)} ms; grid phase ${wrap(med(outRs), beatTarget).toFixed(2)} ms`,
);
console.log(
  `  incoming residuals vs manifest-implied positions: median ${med(inRs).toFixed(2)} ms; grid phase ${wrap(med(inRs), beatTarget).toFixed(2)} ms`,
);
console.log(
  `\nreading: audio==manifest (both ~0) => renderer faithful; incoming off-grid but manifest-faithful => the PIN placement itself is off-grid (corpus fixture semantics), not a renderer defect.`,
);

// ---------------------------------------------------------------------------
// Manual replication of the outgoing deck's TAIL splice (rubberband-cli.ts
// prepareCliStretchedSegments, role "outgoing"), using the same ffmpeg
// commands, to test the splice math in complete isolation from the renderer.
// ---------------------------------------------------------------------------
console.log("\nmanual outgoing tail-splice replication:");
const cli = resolveRubberbandCli();
if (!cli) {
  console.log("  R3 CLI not found - splice replication skipped");
} else {
  const work = path.join(unequal.root, "splice");
  await mkdir(work, { recursive: true });
  const src = path.join(unequal.root, "library", "outgoing.wav");
  const rate = 175 / 174;
  const sourceSec = (OUT_MIX_OUT_MS + OVERLAP_MS) / 1000; // 33.103
  const overlapOutSec = OVERLAP_MS / 1000; // 22.069
  const overlapSrcSec = overlapOutSec * rate;
  const xfade = 0.05;
  const bodySrcSec = sourceSec - overlapSrcSec;
  const slice = path.join(work, "slice.wav");
  const native = path.join(work, "native.wav");
  const region = path.join(work, "region.wav");
  const regionOut = path.join(work, "region-rb.wav");
  const spliced = path.join(work, "spliced.wav");
  await run("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-ss",
    "0.000000",
    "-i",
    src,
    "-t",
    sourceSec.toFixed(6),
    "-af",
    `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo`,
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    slice,
  ]);
  await run("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    slice,
    "-af",
    `atrim=start=0:end=${(bodySrcSec + xfade).toFixed(6)},asetpts=PTS-STARTPTS`,
    "-c:a",
    "pcm_s16le",
    native,
  ]);
  await run("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    slice,
    "-af",
    `atrim=start=${bodySrcSec.toFixed(6)},asetpts=PTS-STARTPTS`,
    "-c:a",
    "pcm_s16le",
    region,
  ]);
  await run(cli, ["-3", "-T", rate.toFixed(8), "--centre-focus", "-q", region, regionOut], {
    timeout: 120_000,
  });
  await run("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    native,
    "-i",
    regionOut,
    "-filter_complex",
    `[0:a][1:a]acrossfade=d=${xfade}:o=1:c1=hsin:c2=hsin[out]`,
    "-map",
    "[out]",
    "-c:a",
    "pcm_s16le",
    spliced,
  ]);
  // Measure the spliced file's kicks against BOTH placement models.
  const pcm = path.join(work, "spliced.pcm");
  await run("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    spliced,
    "-f",
    "f32le",
    "-ac",
    "1",
    "-ar",
    "22050",
    pcm,
  ]);
  const buf = await readFile(pcm);
  const samples = new Float32Array(buf.length / 4);
  for (let i = 0; i < samples.length; i += 1) samples[i] = buf.readFloatLE(i * 4);
  const splicedOnsets = onsetTimesMs(lowpass(samples, 22_050, 180), 22_050);
  const beat174 = 60_000 / 174;
  const bodySrcMs = bodySrcSec * 1000;
  const regionOnsets = splicedOnsets.filter((t) => t > bodySrcMs + 200);
  const residA: number[] = [];
  const residB: number[] = [];
  for (const t of regionOnsets) {
    // Source position implied by rate-regions model A: src = bodySrc + (t - bodySrc)*rate
    const srcPosA = bodySrcMs + (t - bodySrcMs) * rate;
    const kRound = Math.round(srcPosA / beat174);
    if (kRound < 1) continue;
    const expectedA = bodySrcMs + (kRound * beat174 - bodySrcMs) / rate;
    residA.push(t - expectedA - bias);
    const expectedB = (kRound * beat174) / rate; // full-stretch model
    residB.push(t - expectedB - bias);
  }
  console.log(
    `  region onsets measured: ${regionOnsets.length}; residual vs rate-regions model: median ${med(residA).toFixed(2)} ms; vs full-stretch model: median ${med(residB).toFixed(2)} ms`,
  );
  // Deeper attribution: the stretched region ALONE and the native body ALONE.
  const onsetsOf = async (file: string) => {
    const p = `${file}.pcm`;
    await run("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-y",
      "-i",
      file,
      "-f",
      "f32le",
      "-ac",
      "1",
      "-ar",
      "22050",
      p,
    ]);
    const b = await readFile(p);
    const s2 = new Float32Array(b.length / 4);
    for (let i = 0; i < s2.length; i += 1) s2[i] = b.readFloatLE(i * 4);
    return onsetTimesMs(lowpass(s2, 22_050, 180), 22_050);
  };
  const regionAlone = await onsetsOf(regionOut);
  const residRegion: number[] = [];
  for (const t of regionAlone) {
    const kRound = Math.round((bodySrcMs + t * rate) / beat174);
    const expected = (kRound * beat174 - bodySrcMs) / rate;
    residRegion.push(t - expected - bias);
  }
  console.log(
    `  stretched region alone: ${regionAlone.length} onsets; residual vs its own model: median ${med(residRegion).toFixed(2)} ms`,
  );
  const nativeAlone = await onsetsOf(native);
  const residNative: number[] = [];
  for (const t of nativeAlone) {
    const kRound = Math.round(t / beat174);
    residNative.push(t - kRound * beat174 - bias);
  }
  console.log(
    `  native body alone: ${nativeAlone.length} onsets; residual vs source grid: median ${med(residNative).toFixed(2)} ms`,
  );
  // Direct splice-placement measurement: where does the region's content
  // actually land in the spliced file? Compare the region's first few
  // onsets (unfiltered) against the spliced file's onsets around
  // bodySrc + that offset.
  const regionEarly = regionAlone.filter((t) => t > 40 && t < 900).slice(0, 4);
  console.log(`  regionOut early onsets: ${regionEarly.map((t) => t.toFixed(1)).join(", ")}`);
  const splicedEarly = splicedOnsets.filter((t) => t > bodySrcMs - 800 && t < bodySrcMs + 1200);
  console.log(
    `  spliced onsets around bodySrc: ${splicedEarly.map((t) => t.toFixed(1)).join(", ")}`,
  );
  if (regionEarly.length > 0 && splicedEarly.length > 0) {
    const deltas: number[] = [];
    for (const r of regionEarly) {
      const expected = bodySrcMs + r;
      const nearest = splicedOnsets.reduce(
        (acc, x) => (Math.abs(x - expected) < Math.abs(acc - expected) ? x : acc),
        splicedOnsets[0]!,
      );
      if (Math.abs(nearest - expected) < 200) deltas.push(nearest - expected);
    }
    console.log(
      `  splice placement deltas (region content): median ${med(deltas).toFixed(2)} ms over ${deltas.length} onsets (0 = model A)`,
    );
  }
  for (const [name, file] of [
    ["native", native],
    ["regionOut", regionOut],
    ["spliced", spliced],
  ] as const) {
    const d = await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      file,
    ]);
    console.log(`  duration ${name}: ${Number(d.stdout.trim()) * 1000} ms`);
  }
  const probe = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    spliced,
  ]);
  console.log(
    `  spliced duration ${Number(probe.stdout.trim()) * 1000} ms vs predicted ${((bodySrcSec + overlapOutSec) * 1000).toFixed(1)} ms (bodySrc+overlapOut)`,
  );
}

await rm(equal.root, { recursive: true, force: true });
await rm(unequal.root, { recursive: true, force: true });
