import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";
import { loadConfig } from "../../packages/domain/src/index.ts";
import {
  createNodeProcessRunner,
  detectFfmpeg,
  encodeListenFlac,
  parseEbur128,
  renderMix,
  requireFfmpeg,
  resolveRubberbandCli,
  type FfmpegBinaries,
  type MixRequest,
  type MixTransitionKind,
  type ProcessRunner,
} from "../../packages/audio-renderer/src/index.ts";

const SAMPLE_RATE_HZ = 48_000;
const WINDOW_BARS = 8;
const OVERLAP_BARS = 4;
const TARGET_LUFS = -18;
const TRUE_PEAK_CEILING_DB = -1;

const TRACKS = {
  bass: "cc333e83-d251-4cc3-b799-0584baca70a8", // Sub Focus — Twilight
  breaks: "31b8f9ef-3e3f-448d-8879-9a29e363f06b", // Chase And Status — End Credits
  liquid: "f99625a8-a69f-4fe8-a0ee-2fd5a6bccc8c", // Calibre — Predictable
  bright: "2e09272b-3779-4367-a542-a342eb00874f", // Chase And Status — Let You Go
} as const;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outRoot = path.join(repoRoot, "output", "reviews", "listen-ab-real");
const extractsDir = path.join(outRoot, "extracts");
const rawDir = path.join(outRoot, "raw");
const pairsDir = path.join(outRoot, "pairs");

type Loudness = { integratedLufs: number | null; truePeakDb: number | null };

type PairCase = {
  id: string;
  title: string;
  listenFor: string;
  cue: string;
  aLabel: string;
  bLabel: string;
  tracks: string[];
  skipped?: string;
  aPath?: string;
  bPath?: string;
  interleavedPath?: string;
  aLufs?: number | null;
  bLufs?: number | null;
  aTruePeakDb?: number | null;
  bTruePeakDb?: number | null;
  stretchEngine?: string;
};

type Clip = {
  id: string;
  label: string;
  bpm: number;
  dropMs: number;
  windowMs: number;
  extractPath: string;
};

function barsToMs(bpm: number, bars: number): number {
  return Math.round((60_000 / bpm) * 4 * bars);
}

function rel(filePath: string | undefined): string {
  return filePath ? path.relative(repoRoot, filePath).replaceAll("\\", "/") : "";
}

async function requireBinaries(runner: ProcessRunner): Promise<FfmpegBinaries> {
  const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
  if (!binaries) {
    throw new Error("FFmpeg/ffprobe were not found on PATH");
  }
  requireFfmpeg(binaries);
  return binaries;
}

async function ffmpeg(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  args: string[],
): Promise<void> {
  const result = await runner.run({
    executable: binaries.ffmpegPath,
    args: ["-nostdin", "-hide_banner", "-y", ...args],
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.slice(-1_200) || `ffmpeg exited ${result.exitCode}`);
  }
}

async function measureLoudness(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  filePath: string,
): Promise<Loudness> {
  const result = await runner.run({
    executable: binaries.ffmpegPath,
    args: [
      "-nostdin",
      "-hide_banner",
      "-i",
      filePath,
      "-filter_complex",
      "ebur128=peak=true",
      "-f",
      "null",
      "-",
    ],
  });
  if (result.exitCode !== 0) {
    return { integratedLufs: null, truePeakDb: null };
  }
  return parseEbur128(result.stderr);
}

function gainToTarget(measured: Loudness): number {
  if (measured.integratedLufs == null || !Number.isFinite(measured.integratedLufs)) {
    return 0;
  }
  return TARGET_LUFS - measured.integratedLufs;
}

async function matchAndListen(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  inputPath: string,
  listenPath: string,
  gainDb: number,
): Promise<Loudness> {
  const matched = `${inputPath}.matched.wav`;
  await ffmpeg(runner, binaries, [
    "-i",
    inputPath,
    "-af",
    `volume=${gainDb.toFixed(3)}dB`,
    "-c:a",
    "pcm_f32le",
    matched,
  ]);
  await encodeListenFlac(runner, binaries, matched, listenPath);
  return measureLoudness(runner, binaries, listenPath);
}

async function concatSilenceTail(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  inputPath: string,
  outputPath: string,
  silenceMs: number,
): Promise<void> {
  await ffmpeg(runner, binaries, [
    "-i",
    inputPath,
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=${SAMPLE_RATE_HZ}:cl=stereo:d=${(silenceMs / 1000).toFixed(3)}`,
    "-filter_complex",
    "[0:a][1:a]concat=n=2:v=0:a=1",
    "-c:a",
    "pcm_f32le",
    outputPath,
  ]);
}

async function interleave(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  aPath: string,
  bPath: string,
  outputPath: string,
): Promise<void> {
  await ffmpeg(runner, binaries, [
    "-i",
    aPath,
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=${SAMPLE_RATE_HZ}:cl=stereo:d=0.4`,
    "-i",
    bPath,
    "-filter_complex",
    "[0:a][1:a][2:a]concat=n=3:v=0:a=1",
    "-c:a",
    "flac",
    "-compression_level",
    "8",
    outputPath,
  ]);
}

function mixRequest(
  outputPath: string,
  segments: MixRequest["segments"],
  overlapMs: number[],
  transitions: MixTransitionKind[] | undefined,
  extra: Partial<MixRequest> = {},
): MixRequest {
  return {
    segments,
    overlapMs,
    outputPath,
    sampleRateHz: SAMPLE_RATE_HZ,
    truePeakCeilingDb: TRUE_PEAK_CEILING_DB,
    loudnessTargetLufs: TARGET_LUFS,
    edgeFadeMs: 0,
    postProcess: true,
    applyLimiter: false,
    isolatePrefix: false,
    fidelityMode: true,
    stretchScope: "overlap",
    transitions: transitions?.map((type) => ({ type })),
    ...extra,
  };
}

async function finishPair(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  pair: PairCase,
  rawA: string,
  rawB: string,
): Promise<void> {
  const measuredA = await measureLoudness(runner, binaries, rawA);
  const measuredB = await measureLoudness(runner, binaries, rawB);
  pair.aPath = path.join(pairsDir, `${pair.id}-A.flac`);
  pair.bPath = path.join(pairsDir, `${pair.id}-B.flac`);
  pair.interleavedPath = path.join(pairsDir, `${pair.id}-AB.flac`);
  const listenA = await matchAndListen(runner, binaries, rawA, pair.aPath, gainToTarget(measuredA));
  const listenB = await matchAndListen(runner, binaries, rawB, pair.bPath, gainToTarget(measuredB));
  await interleave(runner, binaries, pair.aPath, pair.bPath, pair.interleavedPath);
  pair.aLufs = listenA.integratedLufs;
  pair.bLufs = listenB.integratedLufs;
  pair.aTruePeakDb = listenA.truePeakDb;
  pair.bTruePeakDb = listenB.truePeakDb;
}

async function extractClip(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  sourcePath: string,
  startMs: number,
  durationMs: number,
  outputPath: string,
): Promise<void> {
  await ffmpeg(runner, binaries, [
    "-i",
    sourcePath,
    "-ss",
    (startMs / 1000).toFixed(3),
    "-t",
    (durationMs / 1000).toFixed(3),
    "-c:a",
    "pcm_f32le",
    outputPath,
  ]);
}

function resolveClip(
  runtime: ReturnType<typeof createCatalogRuntime>,
  trackId: string,
): { sourcePath: string; clip: Omit<Clip, "extractPath"> } {
  const track = runtime.repository.listAll().find((item) => item.id === trackId);
  if (!track) {
    throw new Error(`Track ${trackId} is not in the catalog`);
  }
  if (!existsSync(track.filePath)) {
    throw new Error(`Audio missing for ${track.artist ?? "unknown"} — ${track.title}`);
  }
  const analysis = runtime.analyses.findByTrackId(track.id);
  const bpm = track.bpm ?? analysis?.bpm;
  if (bpm == null || !Number.isFinite(bpm) || bpm <= 0) {
    throw new Error(`No BPM for ${track.title}`);
  }
  const dropSection = analysis?.sections?.find((section) => section.type === "drop");
  const dropCue = analysis?.suggestedCues?.find((cue) => cue.type === "drop");
  const dropMs = dropSection?.startMs ?? dropCue?.positionMs ?? 0;
  const windowMs = barsToMs(bpm, WINDOW_BARS);
  if (dropMs + windowMs > track.durationMs) {
    throw new Error(`Drop window overruns ${track.title}`);
  }
  return {
    sourcePath: track.filePath,
    clip: {
      id: track.id,
      label: `${track.artist ?? "Unknown"} — ${track.title}`,
      bpm,
      dropMs,
      windowMs,
    },
  };
}

async function main(): Promise<void> {
  await mkdir(extractsDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });
  await mkdir(pairsDir, { recursive: true });

  const config = loadConfig();
  const runtime = createCatalogRuntime(config, undefined, { passive: true, useFakeFfmpeg: true });
  const runner = createNodeProcessRunner();
  const binaries = await requireBinaries(runner);
  const rubberbandCliPath = resolveRubberbandCli();
  const cases: PairCase[] = [];

  try {
    const resolved = Object.fromEntries(
      Object.entries(TRACKS).map(([role, id]) => [role, resolveClip(runtime, id)]),
    ) as Record<keyof typeof TRACKS, ReturnType<typeof resolveClip>>;

    const clips: Record<keyof typeof TRACKS, Clip> = {
      bass: { ...resolved.bass.clip, extractPath: path.join(extractsDir, "bass.wav") },
      breaks: { ...resolved.breaks.clip, extractPath: path.join(extractsDir, "breaks.wav") },
      liquid: { ...resolved.liquid.clip, extractPath: path.join(extractsDir, "liquid.wav") },
      bright: { ...resolved.bright.clip, extractPath: path.join(extractsDir, "bright.wav") },
    };

    for (const role of Object.keys(clips) as Array<keyof typeof TRACKS>) {
      await extractClip(
        runner,
        binaries,
        resolved[role].sourcePath,
        clips[role].dropMs,
        clips[role].windowMs,
        clips[role].extractPath,
      );
    }

    const silencePath = path.join(extractsDir, "silence.wav");
    await ffmpeg(runner, binaries, [
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=${SAMPLE_RATE_HZ}:cl=stereo:d=${(clips.bass.windowMs / 1000).toFixed(3)}`,
      "-c:a",
      "pcm_f32le",
      silencePath,
    ]);

    async function identityNative(
      id: string,
      title: string,
      clip: Clip,
      listenFor: string,
    ): Promise<void> {
      const ref = path.join(rawDir, `${id}-ref.wav`);
      const rendered = path.join(rawDir, `${id}-render.wav`);
      await ffmpeg(runner, binaries, [
        "-i",
        clip.extractPath,
        "-af",
        "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
        "-c:a",
        "pcm_f32le",
        ref,
      ]);
      const result = await renderMix(
        runner,
        binaries,
        mixRequest(
          rendered,
          [{ filePath: clip.extractPath, sourceStartMs: 0, sourceEndMs: clip.windowMs, gainDb: 0 }],
          [],
          undefined,
          { rubberbandCliPath },
        ),
      );
      const pair: PairCase = {
        id,
        title,
        aLabel: `Dry extract · ${clip.label}`,
        bLabel: "Identity renderMix of the same drop window",
        listenFor,
        cue: "Whole clip. Loop 2–3 times.",
        tracks: [clip.label],
        stretchEngine: result.stretchEngine,
      };
      await finishPair(runner, binaries, pair, ref, rendered);
      cases.push(pair);
    }

    await identityNative(
      "01-native-bass",
      "Native drop · bass/reese",
      clips.bass,
      "Sub weight, reese texture, kick punch, extra haze",
    );
    await identityNative(
      "02-native-breaks",
      "Native drop · dense breaks",
      clips.breaks,
      "Snare crack, hat spray, room around the drums",
    );
    await identityNative(
      "03-native-liquid",
      "Native drop · liquid/pad",
      clips.liquid,
      "Pad bloom, image width, soft transients going dull",
    );

    const overlapMs = barsToMs(clips.bass.bpm, OVERLAP_BARS);
    const prefixRef = path.join(rawDir, "04-prefix-ref.wav");
    const prefixRender = path.join(rawDir, "04-prefix-render.wav");
    const prefixIdentity = path.join(rawDir, "04-prefix-identity.wav");
    await renderMix(
      runner,
      binaries,
      mixRequest(
        prefixIdentity,
        [
          {
            filePath: clips.bass.extractPath,
            sourceStartMs: 0,
            sourceEndMs: clips.bass.windowMs,
            gainDb: 0,
          },
        ],
        [],
        undefined,
        { rubberbandCliPath },
      ),
    );
    await concatSilenceTail(runner, binaries, prefixIdentity, prefixRef, overlapMs);
    const prefixResult = await renderMix(
      runner,
      binaries,
      mixRequest(
        prefixRender,
        [
          {
            filePath: clips.bass.extractPath,
            sourceStartMs: 0,
            sourceEndMs: clips.bass.windowMs,
            gainDb: 0,
          },
          { filePath: silencePath, sourceStartMs: 0, sourceEndMs: clips.bass.windowMs, gainDb: 0 },
        ],
        [overlapMs],
        ["phrase_mix"],
        { rubberbandCliPath },
      ),
    );
    const prefixPair: PairCase = {
      id: "04-prefix-bass",
      title: "Prefix reconstruction · bass drop vs silence",
      aLabel: `${clips.bass.label}, then silence`,
      bLabel: "phrase_mix of the same drop against silence",
      listenFor: "A hole or tick in the sub/reese when the overlap starts",
      cue: `Overlap starts at ${(clips.bass.windowMs - overlapMs) / 1000}s. Last ${(overlapMs / 1000).toFixed(1)}s should stay silent.`,
      tracks: [clips.bass.label],
      stretchEngine: prefixResult.stretchEngine,
    };
    await finishPair(runner, binaries, prefixPair, prefixRef, prefixRender);
    cases.push(prefixPair);

    const joinOverlap = barsToMs(clips.bass.bpm, OVERLAP_BARS);
    const joinSegs = [
      {
        filePath: clips.bass.extractPath,
        sourceStartMs: 0,
        sourceEndMs: clips.bass.windowMs,
        gainDb: 0,
      },
      {
        filePath: clips.breaks.extractPath,
        sourceStartMs: 0,
        sourceEndMs: clips.breaks.windowMs,
        gainDb: 0,
      },
    ];
    const fadeA = path.join(rawDir, "05-phrase-vs-cut-crossfade.wav");
    const fadeB = path.join(rawDir, "05-phrase-vs-cut-phrase.wav");
    await renderMix(
      runner,
      binaries,
      mixRequest(fadeA, joinSegs, [joinOverlap], ["crossfade"], { rubberbandCliPath }),
    );
    await renderMix(
      runner,
      binaries,
      mixRequest(fadeB, joinSegs, [joinOverlap], ["phrase_mix"], { rubberbandCliPath }),
    );
    const joinPair: PairCase = {
      id: "05-phrase-vs-cut",
      title: "Equal-power fade vs phrase mix",
      aLabel: `acrossfade · ${clips.bass.label} into ${clips.breaks.label}`,
      bLabel: "phrase_mix of the same pair",
      listenFor: "Hollow mid, doubled hats, bass ducking, or a cleaner handover",
      cue: `Overlap is the middle ~${(joinOverlap / 1000).toFixed(1)}s. Ignore doubled drums that appear in both.`,
      tracks: [clips.bass.label, clips.breaks.label],
    };
    await finishPair(runner, binaries, joinPair, fadeA, fadeB);
    cases.push(joinPair);

    const swapSegs = [
      {
        filePath: clips.bass.extractPath,
        sourceStartMs: 0,
        sourceEndMs: clips.bass.windowMs,
        gainDb: 0,
      },
      {
        filePath: clips.bright.extractPath,
        sourceStartMs: 0,
        sourceEndMs: clips.bright.windowMs,
        gainDb: 0,
      },
    ];
    const swapOverlap = barsToMs(clips.bass.bpm, OVERLAP_BARS);
    const swapA = path.join(rawDir, "06-bass-swap-phrase.wav");
    const swapB = path.join(rawDir, "06-bass-swap-swap.wav");
    await renderMix(
      runner,
      binaries,
      mixRequest(swapA, swapSegs, [swapOverlap], ["phrase_mix"], { rubberbandCliPath }),
    );
    await renderMix(
      runner,
      binaries,
      mixRequest(swapB, swapSegs, [swapOverlap], ["bass_swap"], { rubberbandCliPath }),
    );
    const swapPair: PairCase = {
      id: "06-bass-swap",
      title: "Phrase mix vs bass swap",
      aLabel: "phrase_mix",
      bLabel: "bass_swap",
      listenFor: "When the outgoing sub leaves, and whether the incoming kick stays planted",
      cue: `Overlap ~${(swapOverlap / 1000).toFixed(1)}s. Fold to mono once.`,
      tracks: [clips.bass.label, clips.bright.label],
    };
    await finishPair(runner, binaries, swapPair, swapA, swapB);
    cases.push(swapPair);

    for (const [id, rate] of [
      ["07-stretch-1pct", 1.01],
      ["08-stretch-3pct", 1.03],
    ] as const) {
      if (!rubberbandCliPath) {
        cases.push({
          id,
          title: `R3 stretch ${rate === 1.01 ? "+1%" : "+3%"}`,
          aLabel: "Native-tempo phrase_mix",
          bLabel: `Outgoing rate ${rate}`,
          listenFor: "Reese smear, cymbal splash, a click at the stretch splice",
          cue: "First half is featured outgoing; stretch lives in the join.",
          tracks: [clips.bass.label, clips.breaks.label],
          skipped: "Rubber Band R3 CLI was not found",
        });
        continue;
      }
      const nativeJoin = path.join(rawDir, `${id}-native.wav`);
      const stretched = path.join(rawDir, `${id}-stretch.wav`);
      await renderMix(
        runner,
        binaries,
        mixRequest(nativeJoin, joinSegs, [joinOverlap], ["phrase_mix"], { rubberbandCliPath }),
      );
      const stretchResult = await renderMix(
        runner,
        binaries,
        mixRequest(
          stretched,
          [{ ...joinSegs[0]!, playbackRate: rate }, joinSegs[1]!],
          [joinOverlap],
          ["phrase_mix"],
          { rubberbandCliPath, tempoEngine: "rubberband-r3" },
        ),
      );
      const pair: PairCase = {
        id,
        title: `R3 stretch ${rate === 1.01 ? "+1%" : "+3%"}`,
        aLabel: `Native-tempo phrase_mix · ${clips.bass.label} into ${clips.breaks.label}`,
        bLabel: `Outgoing Rubber Band R3 at rate ${rate}`,
        listenFor: "Reese smear, hat splash, a click at the native/R3 boundary",
        cue: "Featured outgoing body first; the join is the test.",
        tracks: [clips.bass.label, clips.breaks.label],
        stretchEngine: stretchResult.stretchEngine,
      };
      await finishPair(runner, binaries, pair, nativeJoin, stretched);
      cases.push(pair);
    }

    const playlist = cases
      .flatMap((item) => [item.aPath, item.bPath, item.interleavedPath])
      .filter((item): item is string => Boolean(item))
      .map((item) => path.relative(outRoot, item).replaceAll("\\", "/"));
    await writeFile(
      path.join(outRoot, "playlist.m3u"),
      `#EXTM3U\n${playlist.join("\n")}\n`,
      "utf8",
    );

    const report = {
      generatedAt: new Date().toISOString(),
      sampleRateHz: SAMPLE_RATE_HZ,
      windowBars: WINDOW_BARS,
      overlapBars: OVERLAP_BARS,
      targetLufs: TARGET_LUFS,
      rubberbandCli: Boolean(rubberbandCliPath),
      ffmpegVersion: binaries.ffmpegVersion,
      clips: Object.fromEntries(
        Object.entries(clips).map(([role, clip]) => [
          role,
          { label: clip.label, bpm: clip.bpm, dropMs: clip.dropMs, windowMs: clip.windowMs },
        ]),
      ),
      notes: [
        "Private-library drop excerpts, read-only. Outputs stay under output/reviews/listen-ab-real/.",
        "A and B are gain-matched to the same integrated LUFS before the 16-bit listen encode.",
        "Interleaved files play A, 400 ms silence, then B.",
      ],
      cases: cases.map((item) => ({
        ...item,
        aPath: rel(item.aPath),
        bPath: rel(item.bPath),
        interleavedPath: rel(item.interleavedPath),
      })),
    };
    await writeFile(
      path.join(outRoot, "cases.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(outRoot, "README.md"),
      `# Real-track listen A/B\n\nGenerated ${report.generatedAt}\n\nSame protocol as the synthetic pairs: A, then B, then \`*-AB.flac\`. Turn player loudness off.\n`,
      "utf8",
    );

    process.stdout.write(
      `Wrote ${cases.filter((item) => item.aPath).length} pairs to ${rel(outRoot)}\n`,
    );
    for (const item of cases) {
      if (item.skipped) {
        process.stdout.write(`  ${item.id}: skipped (${item.skipped})\n`);
        continue;
      }
      process.stdout.write(
        `  ${item.id}: A ${item.aLufs?.toFixed(2) ?? "?"} LUFS / B ${item.bLufs?.toFixed(2) ?? "?"} LUFS\n`,
      );
    }
  } finally {
    await runtime.close();
  }
}

await main();
