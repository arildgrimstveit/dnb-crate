import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSyntheticDnbPcm } from "../../packages/audio-analysis/src/index.ts";
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
  type MixResult,
  type MixTransitionKind,
  type ProcessRunner,
} from "../../packages/audio-renderer/src/index.ts";

const SAMPLE_RATE_HZ = 48_000;
const WINDOW_MS = 8_000;
const OVERLAP_MS = 4_000;
const TARGET_LUFS = -18;
const TRUE_PEAK_CEILING_DB = -1;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outRoot = path.join(repoRoot, "output", "reviews", "listen-ab");
const sourcesDir = path.join(outRoot, "sources");
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
  skipped?: string;
  aPath?: string;
  bPath?: string;
  interleavedPath?: string;
  aLufs?: number | null;
  bLufs?: number | null;
  aTruePeakDb?: number | null;
  bTruePeakDb?: number | null;
  aGainDb?: number;
  bGainDb?: number;
  stretchEngine?: string;
};

function encodeStereoWav(left: Float32Array, right: Float32Array, sampleRateHz: number): Buffer {
  const frames = Math.min(left.length, right.length);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    const l = Math.max(-1, Math.min(1, left[i] ?? 0));
    const r = Math.max(-1, Math.min(1, right[i] ?? 0));
    data.writeInt16LE(Math.round(l * 16_000), i * 4);
    data.writeInt16LE(Math.round(r * 16_000), i * 4 + 2);
  }
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, 4, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(2, 10);
  fmt.writeUInt32LE(sampleRateHz, 12);
  fmt.writeUInt32LE(sampleRateHz * 4, 16);
  fmt.writeUInt16LE(4, 20);
  fmt.writeUInt16LE(16, 22);
  const dataChunk = Buffer.alloc(8 + data.length);
  dataChunk.write("data", 0, 4, "ascii");
  dataChunk.writeUInt32LE(data.length, 4);
  data.copy(dataChunk, 8);
  const inner = Buffer.concat([Buffer.from("WAVE", "ascii"), fmt, dataChunk]);
  const riff = Buffer.alloc(8 + inner.length);
  riff.write("RIFF", 0, 4, "ascii");
  riff.writeUInt32LE(inner.length, 4);
  inner.copy(riff, 8);
  return riff;
}

function mixInto(target: Float32Array, source: Float32Array, gain: number): void {
  const n = Math.min(target.length, source.length);
  for (let i = 0; i < n; i += 1) {
    target[i] = (target[i] ?? 0) + (source[i] ?? 0) * gain;
  }
}

function tone(frames: number, hz: number, gain: number, phase = 0): Float32Array {
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE_HZ + phase) * gain;
  }
  return samples;
}

function stereoize(
  mono: Float32Array,
  delayFrames = 8,
): { left: Float32Array; right: Float32Array } {
  const left = mono.slice();
  const right = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i += 1) {
    right[i] = mono[Math.max(0, i - delayFrames)] ?? 0;
  }
  return { left, right };
}

function reese(frames: number): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const f0 = 55;
  for (let i = 0; i < frames; i += 1) {
    const t = i / SAMPLE_RATE_HZ;
    let l = 0;
    let r = 0;
    for (const harmonic of [1, 2, 3, 5, 7]) {
      l += Math.sin(2 * Math.PI * f0 * harmonic * t) / harmonic;
      r += Math.sin(2 * Math.PI * f0 * 1.017 * harmonic * t + 0.35) / harmonic;
    }
    const wobble = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.375 * t);
    left[i] = l * 0.16 * wobble;
    right[i] = r * 0.16 * wobble;
  }
  return { left, right };
}

function cymbals(frames: number): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const period = Math.round(SAMPLE_RATE_HZ * (60 / 174 / 2));
  let noise = 0;
  for (let i = 0; i < frames; i += 1) {
    noise = noise * 0.92 + (Math.random() * 2 - 1) * 0.08;
    const pos = i % period;
    const env = pos < period * 0.12 ? 1 - pos / (period * 0.12) : 0;
    const bright = noise - (left[Math.max(0, i - 1)] ?? 0) * 0.4;
    left[i] = bright * env * 0.22;
    right[i] = bright * env * 0.18 * (i % 2 === 0 ? 1 : -0.7);
  }
  return { left, right };
}

function widePad(frames: number): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const t = i / SAMPLE_RATE_HZ;
    left[i] =
      (Math.sin(2 * Math.PI * 261.63 * t) + Math.sin(2 * Math.PI * 329.63 * t) * 0.7) * 0.12;
    right[i] =
      (Math.sin(2 * Math.PI * 392.0 * t + 0.4) + Math.sin(2 * Math.PI * 523.25 * t) * 0.55) * 0.12;
  }
  return { left, right };
}

async function writeStereo(
  filePath: string,
  left: Float32Array,
  right: Float32Array,
): Promise<string> {
  await writeFile(filePath, encodeStereoWav(left, right, SAMPLE_RATE_HZ));
  return filePath;
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

function gainToTarget(measured: Loudness, targetLufs: number): number {
  if (measured.integratedLufs == null || !Number.isFinite(measured.integratedLufs)) {
    return 0;
  }
  return targetLufs - measured.integratedLufs;
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
  const silenceSec = (silenceMs / 1000).toFixed(3);
  await ffmpeg(runner, binaries, [
    "-i",
    inputPath,
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=${SAMPLE_RATE_HZ}:cl=stereo:d=${silenceSec}`,
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

async function render(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  request: MixRequest,
): Promise<MixResult> {
  return renderMix(runner, binaries, request);
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
  const aGain = gainToTarget(measuredA, TARGET_LUFS);
  const bGain = gainToTarget(measuredB, TARGET_LUFS);
  pair.aPath = path.join(pairsDir, `${pair.id}-A.flac`);
  pair.bPath = path.join(pairsDir, `${pair.id}-B.flac`);
  pair.interleavedPath = path.join(pairsDir, `${pair.id}-AB.flac`);
  const listenA = await matchAndListen(runner, binaries, rawA, pair.aPath, aGain);
  const listenB = await matchAndListen(runner, binaries, rawB, pair.bPath, bGain);
  await interleave(runner, binaries, pair.aPath, pair.bPath, pair.interleavedPath);
  pair.aLufs = listenA.integratedLufs;
  pair.bLufs = listenB.integratedLufs;
  pair.aTruePeakDb = listenA.truePeakDb;
  pair.bTruePeakDb = listenB.truePeakDb;
  pair.aGainDb = aGain;
  pair.bGainDb = bGain;
}

async function writeSources(): Promise<{
  tone60: string;
  tone180: string;
  silence: string;
  outgoing: string;
  incoming: string;
  reese: string;
  cymbals: string;
  wide: string;
}> {
  const frames = Math.round((SAMPLE_RATE_HZ * WINDOW_MS) / 1000);
  const drums = buildSyntheticDnbPcm({
    bpm: 174,
    sampleRateHz: SAMPLE_RATE_HZ,
    introBars: 0,
    dropBars: 8,
    breakdownBars: 0,
    drop2Bars: 0,
    outroBars: 0,
    includeSub: true,
    subHz: 87.31,
  });
  const drumStereo = stereoize(drums.samples.subarray(0, frames));
  const sub = tone(frames, 60, 0.28);
  const reesePair = reese(frames);
  const hatPair = cymbals(frames);
  const padPair = widePad(frames);

  const outgoingL = drumStereo.left.slice();
  const outgoingR = drumStereo.right.slice();
  mixInto(outgoingL, sub, 1);
  mixInto(outgoingR, sub, 1);
  mixInto(outgoingL, reesePair.left, 1);
  mixInto(outgoingR, reesePair.right, 1);

  const incomingL = new Float32Array(frames);
  const incomingR = new Float32Array(frames);
  mixInto(incomingL, drumStereo.left, 0.35);
  mixInto(incomingR, drumStereo.right, 0.35);
  mixInto(incomingL, padPair.left, 1);
  mixInto(incomingR, padPair.right, 1);
  mixInto(incomingL, hatPair.left, 1);
  mixInto(incomingR, hatPair.right, 1);

  return {
    tone60: await writeStereo(
      path.join(sourcesDir, "tone-60.wav"),
      tone(frames, 60, 0.35),
      tone(frames, 60, 0.35),
    ),
    tone180: await writeStereo(
      path.join(sourcesDir, "tone-180.wav"),
      tone(frames, 180, 0.32),
      tone(frames, 180, 0.32),
    ),
    silence: await writeStereo(
      path.join(sourcesDir, "silence.wav"),
      new Float32Array(frames),
      new Float32Array(frames),
    ),
    outgoing: await writeStereo(
      path.join(sourcesDir, "outgoing-breaks-bass.wav"),
      outgoingL,
      outgoingR,
    ),
    incoming: await writeStereo(
      path.join(sourcesDir, "incoming-pad-hats.wav"),
      incomingL,
      incomingR,
    ),
    reese: await writeStereo(path.join(sourcesDir, "reese.wav"), reesePair.left, reesePair.right),
    cymbals: await writeStereo(path.join(sourcesDir, "cymbals.wav"), hatPair.left, hatPair.right),
    wide: await writeStereo(path.join(sourcesDir, "wide-pad.wav"), padPair.left, padPair.right),
  };
}

function rel(filePath: string | undefined): string {
  return filePath ? path.relative(repoRoot, filePath).replaceAll("\\", "/") : "";
}

async function main(): Promise<void> {
  await mkdir(sourcesDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });
  await mkdir(pairsDir, { recursive: true });

  const runner = createNodeProcessRunner();
  const binaries = await requireBinaries(runner);
  const rubberbandCliPath = resolveRubberbandCli();
  const sources = await writeSources();
  const cases: PairCase[] = [];

  const identityA = path.join(rawDir, "01-native-body-ref.wav");
  await ffmpeg(runner, binaries, [
    "-i",
    sources.outgoing,
    "-af",
    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
    "-c:a",
    "pcm_f32le",
    identityA,
  ]);
  const identityB = path.join(rawDir, "01-native-body-render.wav");
  const native = await render(
    runner,
    binaries,
    mixRequest(
      identityB,
      [{ filePath: sources.outgoing, sourceStartMs: 0, sourceEndMs: WINDOW_MS, gainDb: 0 }],
      [],
      undefined,
      { rubberbandCliPath },
    ),
  );
  const nativePair: PairCase = {
    id: "01-native-body",
    title: "Native body vs source",
    aLabel: "Dry source, resampled to the delivery format",
    bLabel: "Identity renderMix of the same window",
    listenFor: "Tone change, extra hiss, stereo wander, softened kick/snare",
    cue: "Whole clip. Loop 2–3 times.",
    stretchEngine: native.stretchEngine,
  };
  await finishPair(runner, binaries, nativePair, identityA, identityB);
  cases.push(nativePair);

  for (const [id, hz, source] of [
    ["02-prefix-60", 60, sources.tone60],
    ["03-prefix-180", 180, sources.tone180],
  ] as const) {
    const ref = path.join(rawDir, `${id}-ref.wav`);
    const rendered = path.join(rawDir, `${id}-render.wav`);
    const identity = await render(
      runner,
      binaries,
      mixRequest(
        path.join(rawDir, `${id}-identity.wav`),
        [{ filePath: source, sourceStartMs: 0, sourceEndMs: WINDOW_MS, gainDb: 0 }],
        [],
        undefined,
        { rubberbandCliPath },
      ),
    );
    await concatSilenceTail(
      runner,
      binaries,
      path.join(rawDir, `${id}-identity.wav`),
      ref,
      OVERLAP_MS,
    );
    const mixed = await render(
      runner,
      binaries,
      mixRequest(
        rendered,
        [
          { filePath: source, sourceStartMs: 0, sourceEndMs: WINDOW_MS, gainDb: 0 },
          { filePath: sources.silence, sourceStartMs: 0, sourceEndMs: WINDOW_MS, gainDb: 0 },
        ],
        [OVERLAP_MS],
        ["phrase_mix"],
        { rubberbandCliPath },
      ),
    );
    const pair: PairCase = {
      id,
      title: `Prefix reconstruction at ${hz} Hz`,
      aLabel: "Outgoing tone, then silence",
      bLabel: "phrase_mix of the same tone against silence",
      listenFor: "A hole, click, or pitch wobble at 4.00s (overlap start)",
      cue: "Solo around 3.6–4.8s, then the last 4s should stay silent.",
      stretchEngine: mixed.stretchEngine || identity.stretchEngine,
    };
    await finishPair(runner, binaries, pair, ref, rendered);
    cases.push(pair);
  }

  const phraseA = path.join(rawDir, "04-phrase-vs-cut-crossfade.wav");
  const phraseB = path.join(rawDir, "04-phrase-vs-cut-phrase.wav");
  await render(
    runner,
    binaries,
    mixRequest(
      phraseA,
      [
        { filePath: sources.outgoing, sourceStartMs: 0, sourceEndMs: WINDOW_MS, gainDb: 0 },
        { filePath: sources.incoming, sourceStartMs: 0, sourceEndMs: WINDOW_MS, gainDb: 0 },
      ],
      [OVERLAP_MS],
      ["crossfade"],
      { rubberbandCliPath },
    ),
  );
  await render(
    runner,
    binaries,
    mixRequest(
      phraseB,
      [
        { filePath: sources.outgoing, sourceStartMs: 0, sourceEndMs: WINDOW_MS, gainDb: 0 },
        { filePath: sources.incoming, sourceStartMs: 0, sourceEndMs: WINDOW_MS, gainDb: 0 },
      ],
      [OVERLAP_MS],
      ["phrase_mix"],
      { rubberbandCliPath },
    ),
  );
  const phrasePair: PairCase = {
    id: "04-phrase-vs-cut",
    title: "Equal-power fade vs phrase mix",
    aLabel: "acrossfade of breaks+bass into pad+hats",
    bLabel: "phrase_mix of the same pair",
    listenFor: "Hollow mid, double-hats, bass ducking, a cleaner DJ-style join",
    cue: "Overlap is 4.00–8.00s. Compare the handover, not the featured bodies.",
  };
  await finishPair(runner, binaries, phrasePair, phraseA, phraseB);
  cases.push(phrasePair);

  const swapA = path.join(rawDir, "05-bass-swap-phrase.wav");
  const swapB = path.join(rawDir, "05-bass-swap-swap.wav");
  await render(
    runner,
    binaries,
    mixRequest(
      swapA,
      [
        { filePath: sources.outgoing, sourceStartMs: 0, sourceEndMs: WINDOW_MS, gainDb: 0 },
        { filePath: sources.incoming, sourceStartMs: 0, sourceEndMs: WINDOW_MS, gainDb: 0 },
      ],
      [OVERLAP_MS],
      ["phrase_mix"],
      { rubberbandCliPath },
    ),
  );
  await render(
    runner,
    binaries,
    mixRequest(
      swapB,
      [
        { filePath: sources.outgoing, sourceStartMs: 0, sourceEndMs: WINDOW_MS, gainDb: 0 },
        { filePath: sources.incoming, sourceStartMs: 0, sourceEndMs: WINDOW_MS, gainDb: 0 },
      ],
      [OVERLAP_MS],
      ["bass_swap"],
      { rubberbandCliPath },
    ),
  );
  const swapPair: PairCase = {
    id: "05-bass-swap",
    title: "Phrase mix vs bass swap",
    aLabel: "phrase_mix",
    bLabel: "bass_swap",
    listenFor: "When the outgoing sub/reese leaves, and whether the kick stays planted",
    cue: "Overlap 4.00–8.00s. Switch to mono once to check the low end.",
  };
  await finishPair(runner, binaries, swapPair, swapA, swapB);
  cases.push(swapPair);

  for (const [id, rate, title] of [
    ["06-stretch-1pct", 1.01, "R3 stretch +1%"],
    ["07-stretch-3pct", 1.03, "R3 stretch +3%"],
  ] as const) {
    if (!rubberbandCliPath) {
      cases.push({
        id,
        title,
        aLabel: "Native-tempo phrase_mix",
        bLabel: `Outgoing rate ${rate}`,
        listenFor: "Bass wobble, cymbal smear, stereo image wander, join clicks",
        cue: "Compare the overlap, then the featured incoming body.",
        skipped: "Rubber Band R3 CLI was not found",
      });
      continue;
    }
    const nativeJoin = path.join(rawDir, `${id}-native.wav`);
    const stretched = path.join(rawDir, `${id}-stretch.wav`);
    await render(
      runner,
      binaries,
      mixRequest(
        nativeJoin,
        [
          { filePath: sources.outgoing, sourceStartMs: 0, sourceEndMs: WINDOW_MS, gainDb: 0 },
          { filePath: sources.cymbals, sourceStartMs: 0, sourceEndMs: WINDOW_MS, gainDb: 0 },
        ],
        [OVERLAP_MS],
        ["phrase_mix"],
        { rubberbandCliPath },
      ),
    );
    const stretchResult = await render(
      runner,
      binaries,
      mixRequest(
        stretched,
        [
          {
            filePath: sources.outgoing,
            sourceStartMs: 0,
            sourceEndMs: WINDOW_MS,
            gainDb: 0,
            playbackRate: rate,
          },
          { filePath: sources.cymbals, sourceStartMs: 0, sourceEndMs: WINDOW_MS, gainDb: 0 },
        ],
        [OVERLAP_MS],
        ["phrase_mix"],
        { rubberbandCliPath, tempoEngine: "rubberband-r3" },
      ),
    );
    const pair: PairCase = {
      id,
      title,
      aLabel: "Native-tempo phrase_mix (breaks+bass into cymbals)",
      bLabel: `Outgoing Rubber Band R3 at rate ${rate}`,
      listenFor: "Reese smear, transient spread, boundary click at the stretch splice",
      cue: "First 4s is the featured outgoing body; stretch lives in the join.",
      stretchEngine: stretchResult.stretchEngine,
    };
    await finishPair(runner, binaries, pair, nativeJoin, stretched);
    cases.push(pair);
  }

  const stereoA = path.join(rawDir, "08-stereo-native.wav");
  const stereoB = path.join(rawDir, "08-stereo-render.wav");
  await ffmpeg(runner, binaries, [
    "-i",
    sources.wide,
    "-af",
    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
    "-c:a",
    "pcm_f32le",
    stereoA,
  ]);
  await render(
    runner,
    binaries,
    mixRequest(
      stereoB,
      [{ filePath: sources.wide, sourceStartMs: 0, sourceEndMs: WINDOW_MS, gainDb: 0 }],
      [],
      undefined,
      { rubberbandCliPath },
    ),
  );
  const stereoPair: PairCase = {
    id: "08-stereo-pad",
    title: "Wide pad identity",
    aLabel: "Dry wide pad",
    bLabel: "Identity renderMix",
    listenFor: "Image collapse, extra width, or one side lagging",
    cue: "Headphones first, then fold to mono.",
  };
  await finishPair(runner, binaries, stereoPair, stereoA, stereoB);
  cases.push(stereoPair);

  const playlist = cases
    .filter((item) => item.aPath && item.bPath)
    .flatMap((item) => [item.aPath, item.bPath, item.interleavedPath])
    .filter((item): item is string => Boolean(item))
    .map((item) => path.relative(outRoot, item).replaceAll("\\", "/"));
  await writeFile(path.join(outRoot, "playlist.m3u"), `#EXTM3U\n${playlist.join("\n")}\n`, "utf8");

  const report = {
    generatedAt: new Date().toISOString(),
    sampleRateHz: SAMPLE_RATE_HZ,
    windowMs: WINDOW_MS,
    overlapMs: OVERLAP_MS,
    targetLufs: TARGET_LUFS,
    truePeakCeilingDb: TRUE_PEAK_CEILING_DB,
    rubberbandCli: Boolean(rubberbandCliPath),
    ffmpegVersion: binaries.ffmpegVersion,
    notes: [
      "Synthetic sources only. No private-library audio.",
      "A and B are gain-matched to the same integrated LUFS before the 16-bit listen encode.",
      "Interleaved files play A, 400 ms silence, then B.",
      "Critical inspection still belongs on the 24-bit/float raw WAVs in raw/.",
    ],
    cases: cases.map((item) => ({
      ...item,
      aPath: rel(item.aPath),
      bPath: rel(item.bPath),
      interleavedPath: rel(item.interleavedPath),
    })),
  };
  await writeFile(path.join(outRoot, "cases.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const readme = `# Listen A/B pairs

Generated ${report.generatedAt}

Play the 16-bit FLACs in \`pairs/\`. Keep loudness matched: each A/B pair is already
gain-matched to ${TARGET_LUFS} LUFS. Do not toggle a player normalizer between files.

## Protocol

1. Headphones first, then speakers if you have them.
2. For each case, play A, then B, then the interleaved \`*-AB.flac\` (A / gap / B).
3. Repeat 2–3 times before deciding. Level, not preference, is already matched.
4. Fold to mono once on bass and stereo cases.
5. If you hear a difference, note the time and whether it is a hole, click, smear, or image shift.

## Cases

${cases
  .map((item) => {
    if (item.skipped) {
      return `### ${item.id} — ${item.title}\nSkipped: ${item.skipped}\n`;
    }
    return `### ${item.id} — ${item.title}
- A: ${item.aLabel}
- B: ${item.bLabel}
- Listen for: ${item.listenFor}
- Cue: ${item.cue}
- Files: \`${rel(item.aPath)}\` · \`${rel(item.bPath)}\` · \`${rel(item.interleavedPath)}\`
`;
  })
  .join("\n")}
`;
  await writeFile(path.join(outRoot, "README.md"), readme, "utf8");

  console.log(`Wrote ${cases.filter((item) => item.aPath).length} pairs to ${rel(outRoot)}`);
  for (const item of cases) {
    if (item.skipped) {
      console.log(`  ${item.id}: skipped (${item.skipped})`);
      continue;
    }
    console.log(
      `  ${item.id}: A ${item.aLufs?.toFixed(2) ?? "?"} LUFS / B ${item.bLufs?.toFixed(2) ?? "?"} LUFS`,
    );
  }
}

await main();
