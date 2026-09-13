import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createNodeProcessRunner,
  detectFfmpeg,
  encodeListenFlac,
  mixTagsFromTracklist,
  renderMix,
  requireFfmpeg,
} from "../src/index.ts";

function buildImpulseWav(durationMs: number, sampleRate = 44_100): Buffer {
  const frameCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const data = Buffer.alloc(frameCount * 2);
  data.writeInt16LE(12_000, 0);
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, 4, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 2, 16);
  fmt.writeUInt16LE(2, 20);
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

function readFloatStereoPeak(
  wav: Buffer,
  sampleRate: number,
  seconds: number,
): {
  residual: (other: ReturnType<typeof readFloatStereoPeak>) => number;
  samples: Float32Array;
} {
  const dataOffset = wav.indexOf(Buffer.from("data"));
  const pcm = wav.subarray(dataOffset + 8);
  const frames = Math.min(Math.floor(pcm.length / 8), Math.round(sampleRate * seconds));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    samples[i] = pcm.readFloatLE(i * 8);
  }
  return {
    samples,
    residual(other) {
      const n = Math.min(samples.length, other.samples.length);
      let err = 0;
      let ref = 0;
      for (let i = 0; i < n; i += 1) {
        const a = samples[i] ?? 0;
        const b = other.samples[i] ?? 0;
        err += (a - b) ** 2;
        ref += a * a;
      }
      return Math.sqrt(err / Math.max(ref, 1e-20));
    },
  };
}

function maxAdjacentStep(
  wav: Buffer,
  sampleRate: number,
  startSec: number,
  endSec: number,
): number {
  const dataOffset = wav.indexOf(Buffer.from("data"));
  const pcm = wav.subarray(dataOffset + 8);
  const start = Math.max(0, Math.round(startSec * sampleRate));
  const end = Math.min(Math.floor(pcm.length / 8) - 1, Math.round(endSec * sampleRate));
  let max = 0;
  let previous = pcm.readFloatLE(start * 8);
  for (let i = start + 1; i <= end; i += 1) {
    const sample = pcm.readFloatLE(i * 8);
    max = Math.max(max, Math.abs(sample - previous));
    previous = sample;
  }
  return max;
}

function buildSineWav(
  durationMs: number,
  frequencyHz: number,
  sampleRate = 44_100,
  amplitude = 12_000,
): Buffer {
  const frameCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const data = Buffer.alloc(frameCount * 2);
  for (let i = 0; i < frameCount; i += 1) {
    const sample = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate);
    data.writeInt16LE(Math.round(sample * amplitude), i * 2);
  }
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, 4, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 2, 16);
  fmt.writeUInt16LE(2, 20);
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

const runner = createNodeProcessRunner();

describe("FFmpeg integration", () => {
  it("crossfades two generated tones into stereo 48 kHz WAV under the peak ceiling", async (ctx) => {
    const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    if (!binaries) {
      ctx.skip();
      return;
    }
    requireFfmpeg(binaries);
    const root = path.join(
      os.tmpdir(),
      `dnb-ff-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    const a = path.join(root, "a.wav");
    const b = path.join(root, "b.wav");
    const out = path.join(root, "mix.wav");
    await writeFile(a, buildSineWav(4000, 220));
    await writeFile(b, buildSineWav(4000, 440));
    const result = await renderMix(runner, binaries, {
      segments: [
        { filePath: a, sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0 },
        { filePath: b, sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0 },
      ],
      overlapMs: [1000],
      outputPath: out,
      truePeakCeilingDb: -1,
      loudnessTargetLufs: -14,
    });
    expect(result.channels).toBe(2);
    expect(result.sampleRateHz).toBe(48_000);
    expect(Math.abs(result.durationMs - 7000)).toBeLessThan(250);
    if (result.truePeakDb !== null) {
      expect(result.truePeakDb).toBeLessThanOrEqual(-0.7);
    }
    expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.invocation).not.toMatch(/a\.wav/);
  }, 60_000);

  it("keeps a 440 Hz tone near 440 Hz after atempo 1.03 (pitch-preserving)", async (ctx) => {
    const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    if (!binaries) {
      ctx.skip();
      return;
    }
    requireFfmpeg(binaries);
    const root = path.join(
      os.tmpdir(),
      `dnb-atempo-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    const a = path.join(root, "tone.wav");
    const out = path.join(root, "stretched.wav");
    await writeFile(a, buildSineWav(4000, 440));
    await renderMix(runner, binaries, {
      segments: [
        { filePath: a, sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0, playbackRate: 1.03 },
      ],
      overlapMs: [],
      outputPath: out,
      truePeakCeilingDb: -1,
      loudnessTargetLufs: -14,
      postProcess: false,
      pcmCodec: "pcm_s24le",
    });
    const { readFile } = await import("node:fs/promises");
    const wav = await readFile(out);
    const dataOffset = wav.indexOf(Buffer.from("data"));
    const pcm = wav.subarray(dataOffset + 8);
    const sampleRate = 48_000;
    const bytesPerFrame = 6; // stereo pcm_s24le
    const samples = Math.min(Math.floor(pcm.length / bytesPerFrame), sampleRate * 2);
    let crossings = 0;
    let prev = 0;
    for (let i = 0; i < samples; i += 1) {
      const offset = i * bytesPerFrame;
      const raw = pcm[offset]! | (pcm[offset + 1]! << 8) | (pcm[offset + 2]! << 16);
      const sample = raw & 0x800000 ? raw | ~0xffffff : raw;
      if ((prev < 0 && sample >= 0) || (prev >= 0 && sample < 0)) {
        crossings += 1;
      }
      prev = sample;
    }
    const freq = crossings / 2 / (samples / sampleRate);
    expect(Math.abs(freq - 440)).toBeLessThan(20);
  }, 60_000);

  it("drops outgoing low band after a bass_swap and sums bands within 0.5 LU", async (ctx) => {
    const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    if (!binaries) {
      ctx.skip();
      return;
    }
    requireFfmpeg(binaries);
    const root = path.join(
      os.tmpdir(),
      `dnb-band-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    const outgoing = path.join(root, "low.wav");
    const incoming = path.join(root, "high.wav");
    const mixed = path.join(root, "swap.wav");
    const original = path.join(root, "orig.wav");
    const summed = path.join(root, "sum.wav");
    await writeFile(outgoing, buildSineWav(40_000, 80));
    await writeFile(incoming, buildSineWav(40_000, 2000));
    await writeFile(original, buildSineWav(8_000, 440));
    const overlapMs = Math.round((16 * 4 * 60_000) / 174);
    const result = await renderMix(runner, binaries, {
      segments: [
        { filePath: outgoing, sourceStartMs: 0, sourceEndMs: 40_000, gainDb: 0 },
        { filePath: incoming, sourceStartMs: 0, sourceEndMs: 40_000, gainDb: 0 },
      ],
      overlapMs: [overlapMs],
      outputPath: mixed,
      truePeakCeilingDb: -1,
      loudnessTargetLufs: -14,
      postProcess: false,
      transitions: [{ type: "bass_swap", barCount: 16, params: { targetBpm: 174, swapAtBar: 8 } }],
    });
    expect(result.invocation).toBeTruthy();
    expect(Math.abs(result.durationMs - (80_000 - overlapMs))).toBeLessThan(1000);

    const overlapStartMs = 40_000 - overlapMs;
    const swapMs = overlapStartMs + Math.round((8 * 4 * 60_000) / 174);
    const before = await measureMeanVolume(runner, binaries, mixed, swapMs - 4000, swapMs - 1500);
    const after = await measureMeanVolume(runner, binaries, mixed, swapMs + 2000, swapMs + 4500);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect((before ?? 0) - (after ?? 0)).toBeGreaterThanOrEqual(12);

    const splitArgs = [
      "-nostdin",
      "-hide_banner",
      "-y",
      "-i",
      original,
      "-filter_complex",
      "[0:a]asplit=3[a][b][c];[a]lowpass=f=180[l];[b]highpass=f=180,lowpass=f=2500[m];[c]highpass=f=2500[h];[l][m][h]amix=inputs=3:normalize=0[out]",
      "-map",
      "[out]",
      summed,
    ];
    const splitRun = await runner.run({ executable: binaries.ffmpegPath, args: splitArgs });
    expect(splitRun.exitCode).toBe(0);
    const origLoud = await measureIntegrated(runner, binaries, original);
    const sumLoud = await measureIntegrated(runner, binaries, summed);
    expect(origLoud).not.toBeNull();
    expect(sumLoud).not.toBeNull();
    expect(Math.abs((origLoud ?? 0) - (sumLoud ?? 0))).toBeLessThan(0.5);
  }, 90_000);

  it("keeps expected duration across three phrase_mix joins", async (ctx) => {
    const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    if (!binaries) {
      ctx.skip();
      return;
    }
    requireFfmpeg(binaries);
    const root = path.join(
      os.tmpdir(),
      `dnb-pair-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    const a = path.join(root, "a.wav");
    const b = path.join(root, "b.wav");
    const c = path.join(root, "c.wav");
    const out = path.join(root, "mix.wav");
    await writeFile(a, buildSineWav(8000, 220));
    await writeFile(b, buildSineWav(8000, 330));
    await writeFile(c, buildSineWav(8000, 440));
    const result = await renderMix(runner, binaries, {
      segments: [
        { filePath: a, sourceStartMs: 0, sourceEndMs: 8000, gainDb: 0 },
        { filePath: b, sourceStartMs: 0, sourceEndMs: 8000, gainDb: 0 },
        { filePath: c, sourceStartMs: 0, sourceEndMs: 8000, gainDb: 0 },
      ],
      overlapMs: [2000, 2000],
      outputPath: out,
      truePeakCeilingDb: -1,
      loudnessTargetLufs: -14,
      postProcess: false,
      transitions: [
        { type: "phrase_mix", barCount: 16, params: { targetBpm: 174 } },
        { type: "phrase_mix", barCount: 16, params: { targetBpm: 174 } },
      ],
    });
    expect(Math.abs(result.durationMs - 20_000)).toBeLessThan(400);
    expect(result.invocation).toContain("pairwise");
    expect(result.invocation).toContain("preserve-prefix");
    expect(result.stretchEngines).toEqual(["none", "none"]);
  }, 90_000);

  it("keeps an earlier impulse body when later silent joins are appended", async (ctx) => {
    const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    if (!binaries) {
      ctx.skip();
      return;
    }
    requireFfmpeg(binaries);
    const root = path.join(
      os.tmpdir(),
      `dnb-prefix-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    const impulse = path.join(root, "impulse.wav");
    const silent = path.join(root, "silent.wav");
    const two = path.join(root, "two.wav");
    const many = path.join(root, "many.wav");
    await writeFile(impulse, buildImpulseWav(4000));
    await writeFile(silent, buildSineWav(4000, 0));
    const join = {
      overlapMs: [1000] as number[],
      truePeakCeilingDb: -1,
      loudnessTargetLufs: -14,
      postProcess: false,
      transitions: [
        { type: "phrase_mix" as const, barCount: 16 as const, params: { targetBpm: 174 } },
      ],
    };
    await renderMix(runner, binaries, {
      ...join,
      segments: [
        { filePath: impulse, sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0 },
        { filePath: silent, sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0 },
      ],
      outputPath: two,
    });
    await renderMix(runner, binaries, {
      ...join,
      overlapMs: [1000, 1000, 1000, 1000, 1000],
      transitions: Array.from({ length: 5 }, () => join.transitions[0]!),
      segments: [
        { filePath: impulse, sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0 },
        ...Array.from({ length: 5 }, () => ({
          filePath: silent,
          sourceStartMs: 0,
          sourceEndMs: 4000,
          gainDb: 0,
        })),
      ],
      outputPath: many,
    });
    const a = readFloatStereoPeak(
      await (await import("node:fs/promises")).readFile(two),
      48_000,
      0.05,
    );
    const b = readFloatStereoPeak(
      await (await import("node:fs/promises")).readFile(many),
      48_000,
      0.05,
    );
    const residualDb = 20 * Math.log10(Math.max(1e-12, a.residual(b)));
    expect(residualDb).toBeLessThan(-60);
  }, 120_000);

  it("does not click when adjacent phrase joins use 120 Hz then 250 Hz", async (ctx) => {
    const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    if (!binaries) {
      ctx.skip();
      return;
    }
    requireFfmpeg(binaries);
    const root = path.join(
      os.tmpdir(),
      `dnb-concat-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    const silent = path.join(root, "silent.wav");
    const tone = path.join(root, "tone.wav");
    const out = path.join(root, "mix.wav");
    await writeFile(silent, buildSineWav(8000, 180, 44_100, 0));
    await writeFile(tone, buildSineWav(8000, 180, 44_100, 0.2 * 32_767));
    const result = await renderMix(runner, binaries, {
      segments: [
        { filePath: silent, sourceStartMs: 0, sourceEndMs: 8000, gainDb: 0 },
        { filePath: tone, sourceStartMs: 0, sourceEndMs: 8000, gainDb: 0 },
        { filePath: silent, sourceStartMs: 0, sourceEndMs: 8000, gainDb: 0 },
      ],
      overlapMs: [2000, 2000],
      outputPath: out,
      truePeakCeilingDb: -1,
      loudnessTargetLufs: -14,
      postProcess: false,
      applyLimiter: false,
      transitions: [
        { type: "phrase_mix", barCount: 16, params: { targetBpm: 174, crossoverHz: 120 } },
        { type: "phrase_mix", barCount: 16, params: { targetBpm: 174, crossoverHz: 250 } },
      ],
    });
    expect(Math.abs(result.durationMs - 20_000)).toBeLessThan(400);
    const wav = await (await import("node:fs/promises")).readFile(out);
    const toneStep = maxAdjacentStep(wav, 48_000, 8.5, 11.5);
    const boundaryStep = maxAdjacentStep(wav, 48_000, 11.985, 12.015);
    expect(toneStep).toBeGreaterThan(0);
    expect(boundaryStep).toBeLessThan(0.04);
    expect(boundaryStep).toBeLessThan(toneStep * 12);
  }, 120_000);

  it.each([false, true])(
    "preserves the shared deck through mixed joins (band first: %s)",
    async (bandFirst) => {
      const binaries = requireFfmpeg(
        await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" }),
      );
      const root = path.join(os.tmpdir(), `dnb-mixed-phase-${crypto.randomUUID()}`);
      await mkdir(root, { recursive: true });
      const silent = path.join(root, "silent.wav");
      const tone = path.join(root, "tone.wav");
      await writeFile(silent, buildSineWav(8000, 180, 48000, 0));
      await writeFile(tone, buildSineWav(8000, 180, 48000, 6500));
      for (const crossoverHz of [120, 250]) {
        const band = { type: "bass_swap" as const, barCount: 16 as const, params: { crossoverHz } };
        const cross = { type: "crossfade" as const };
        const samples: Float32Array[] = [];
        for (const transitions of [[band, band], bandFirst ? [band, cross] : [cross, band]]) {
          const outputPath = path.join(root, `${crossoverHz}-${samples.length}.wav`);
          await renderMix(runner, binaries, {
            segments: [silent, tone, silent].map((filePath) => ({
              filePath,
              sourceStartMs: 0,
              sourceEndMs: 8000,
              gainDb: 0,
            })),
            overlapMs: [2000, 2000],
            transitions,
            outputPath,
            truePeakCeilingDb: -1,
            loudnessTargetLufs: -14,
            postProcess: false,
          });
          samples.push(
            readFloatStereoPeak(
              await (await import("node:fs/promises")).readFile(outputPath),
              48000,
              12,
            ).samples,
          );
        }
        let error = 0,
          reference = 0;
        // The 12 ms stitch precedes the next intended transition. Its shared
        // deck must equal the phase-consistent band/band control throughout.
        for (let i = Math.floor(11.98 * 48000); i < 12 * 48000; i++) {
          error += (samples[0]![i]! - samples[1]![i]!) ** 2;
          reference += samples[0]![i]! ** 2;
        }
        expect(reference).toBeGreaterThan(0);
        expect(Math.sqrt(error / reference)).toBeLessThan(0.01);
      }
    },
    120_000,
  );

  it("writes 24-bit 48 kHz FLAC when the output path is .flac", async (ctx) => {
    const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    if (!binaries) {
      ctx.skip();
      return;
    }
    requireFfmpeg(binaries);
    const root = path.join(
      os.tmpdir(),
      `dnb-flac-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    const a = path.join(root, "a.wav");
    const b = path.join(root, "b.wav");
    const out = path.join(root, "mix.flac");
    await writeFile(a, buildSineWav(4000, 220));
    await writeFile(b, buildSineWav(4000, 440));
    const result = await renderMix(runner, binaries, {
      segments: [
        { filePath: a, sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0 },
        { filePath: b, sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0 },
      ],
      overlapMs: [1000],
      outputPath: out,
      truePeakCeilingDb: -1,
      loudnessTargetLufs: -14,
    });
    expect(result.channels).toBe(2);
    expect(result.sampleRateHz).toBe(48_000);
    expect(Math.abs(result.durationMs - 7000)).toBeLessThan(250);
    const probe = await runner.run({
      executable: binaries.ffprobePath,
      args: ["-hide_banner", "-loglevel", "error", "-print_format", "json", "-show_streams", out],
    });
    const parsed = JSON.parse(probe.stdout) as {
      streams?: Array<{
        codec_name?: string;
        bits_per_raw_sample?: string;
        sample_fmt?: string;
      }>;
    };
    const stream = parsed.streams?.[0];
    expect(stream?.codec_name).toBe("flac");
    expect(stream?.bits_per_raw_sample === "24" || stream?.sample_fmt === "s32").toBe(true);
    expect(result.invocation).toMatch(/-c:a flac/);
  }, 60_000);

  it("encodes a dithered 16-bit listen FLAC from the 24-bit master", async (ctx) => {
    const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    if (!binaries) {
      ctx.skip();
      return;
    }
    requireFfmpeg(binaries);
    const root = path.join(
      os.tmpdir(),
      `dnb-listen-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    const a = path.join(root, "a.wav");
    const b = path.join(root, "b.wav");
    const master = path.join(root, "mix.flac");
    const listen = path.join(root, "mix-listen.flac");
    await writeFile(a, buildSineWav(4000, 220));
    await writeFile(b, buildSineWav(4000, 440));
    await renderMix(runner, binaries, {
      segments: [
        { filePath: a, sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0 },
        { filePath: b, sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0 },
      ],
      overlapMs: [1000],
      outputPath: master,
      truePeakCeilingDb: -1,
      loudnessTargetLufs: -14,
    });
    await encodeListenFlac(runner, binaries, master, listen);
    const probe = await runner.run({
      executable: binaries.ffprobePath,
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        listen,
      ],
    });
    const parsed = JSON.parse(probe.stdout) as {
      streams?: Array<{
        codec_name?: string;
        bits_per_raw_sample?: string;
        sample_fmt?: string;
        sample_rate?: string;
      }>;
    };
    const stream = parsed.streams?.[0];
    expect(stream?.codec_name).toBe("flac");
    expect(stream?.sample_rate).toBe("48000");
    expect(stream?.bits_per_raw_sample === "16" || stream?.sample_fmt === "s16").toBe(true);
  }, 60_000);

  it("strips first-track tags and writes the mix tracklist as FLAC chapters", async (ctx) => {
    const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    if (!binaries) {
      ctx.skip();
      return;
    }
    requireFfmpeg(binaries);
    const root = path.join(
      os.tmpdir(),
      `dnb-flac-tags-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    const aWav = path.join(root, "a.wav");
    const taggedA = path.join(root, "a.flac");
    const b = path.join(root, "b.wav");
    const out = path.join(root, "mix.flac");
    await writeFile(aWav, buildSineWav(4000, 220));
    await writeFile(b, buildSineWav(4000, 440));
    const tagRun = await runner.run({
      executable: binaries.ffmpegPath,
      args: [
        "-nostdin",
        "-hide_banner",
        "-y",
        "-i",
        aWav,
        "-metadata",
        "title=FirstTrackOnly",
        "-metadata",
        "artist=LeakMe",
        "-c:a",
        "flac",
        taggedA,
      ],
    });
    expect(tagRun.exitCode).toBe(0);
    const result = await renderMix(runner, binaries, {
      segments: [
        { filePath: taggedA, sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0 },
        { filePath: b, sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0 },
      ],
      overlapMs: [1000],
      outputPath: out,
      truePeakCeilingDb: -1,
      loudnessTargetLufs: -14,
      outputMetadata: mixTagsFromTracklist({
        title: "Hour mix",
        date: "2026",
        encodedBy: "dnb-crate 6.5.0",
        tracks: [
          { artist: "Artist A", title: "Alpha", startMs: 0 },
          { artist: "Artist B", title: "Bravo", startMs: 3000 },
        ],
      }),
    });
    expect(Math.abs(result.durationMs - 7000)).toBeLessThan(250);
    expect(result.invocation).toMatch(/-map_metadata 1/);
    expect(result.invocation).not.toMatch(/FirstTrackOnly|LeakMe/);
    const probe = await runner.run({
      executable: binaries.ffprobePath,
      args: ["-hide_banner", "-loglevel", "error", "-print_format", "json", "-show_format", out],
    });
    const parsed = JSON.parse(probe.stdout) as {
      format?: { tags?: Record<string, string> };
    };
    const tags = parsed.format?.tags ?? {};
    const tagBlob = JSON.stringify(tags);
    expect(tagBlob).not.toMatch(/FirstTrackOnly|LeakMe/);
    expect(tags.title ?? tags.TITLE).toBe("Hour mix");
    expect(tags.artist ?? tags.ARTIST).toBe("dnb-crate");
    const comment = tags.comment ?? tags.COMMENT ?? tags.description ?? tags.DESCRIPTION ?? "";
    expect(comment).toContain("1. [0:00] Artist A — Alpha");
    expect(comment).toContain("2. [0:03] Artist B — Bravo");
    const cue = tags.CUESHEET ?? tags.cuesheet ?? "";
    expect(cue).toContain("TRACK 01 AUDIO");
    expect(cue).toContain('TITLE "Alpha"');
    expect(cue).toContain("TRACK 02 AUDIO");
    expect(cue).toContain("INDEX 01 00:03:00");
  }, 60_000);

  it("does not cancel a 180 Hz outgoing prefix at the phrase-mix overlap", async (ctx) => {
    const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    if (!binaries) {
      ctx.skip();
      return;
    }
    requireFfmpeg(binaries);
    const root = path.join(
      os.tmpdir(),
      `dnb-fid-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    const outgoing = path.join(root, "out.wav");
    const incoming = path.join(root, "in.wav");
    const mixed = path.join(root, "mix.wav");
    await writeFile(outgoing, buildSineWav(8000, 180));
    const quiet = buildSineWav(8000, 180);
    const dataAt = quiet.indexOf(Buffer.from("data"));
    quiet.fill(0, dataAt + 8);
    await writeFile(incoming, quiet);
    const result = await renderMix(runner, binaries, {
      segments: [
        { filePath: outgoing, sourceStartMs: 0, sourceEndMs: 8000, gainDb: 0 },
        { filePath: incoming, sourceStartMs: 0, sourceEndMs: 8000, gainDb: 0 },
      ],
      overlapMs: [4000],
      outputPath: mixed,
      truePeakCeilingDb: -1,
      loudnessTargetLufs: -14,
      postProcess: false,
      applyLimiter: false,
      transitions: [{ type: "phrase_mix", barCount: 16, params: { targetBpm: 174 } }],
    });
    expect(result.limiterApplied).toBe(false);
    const steady = await measureMeanVolume(runner, binaries, mixed, 1500, 2500);
    const boundary = await measureMeanVolume(runner, binaries, mixed, 3600, 4000);
    expect(steady).not.toBeNull();
    expect(boundary).not.toBeNull();
    expect(Math.abs((steady ?? 0) - (boundary ?? 0))).toBeLessThan(3);
  }, 60_000);
});

async function measureMeanVolume(
  runner: ReturnType<typeof createNodeProcessRunner>,
  binaries: NonNullable<Awaited<ReturnType<typeof detectFfmpeg>>>,
  filePath: string,
  startMs: number,
  endMs: number,
): Promise<number | null> {
  const args = [
    "-nostdin",
    "-hide_banner",
    "-i",
    filePath,
    "-af",
    `atrim=start=${startMs / 1000}:end=${endMs / 1000},asetpts=PTS-STARTPTS,lowpass=f=180,volumedetect`,
    "-f",
    "null",
    "-",
  ];
  const run = await runner.run({ executable: binaries.ffmpegPath, args });
  const match = /mean_volume:\s*(-?[\d.]+)\s*dB/i.exec(run.stderr);
  return match ? Number(match[1]) : null;
}

async function measureIntegrated(
  runner: ReturnType<typeof createNodeProcessRunner>,
  binaries: NonNullable<Awaited<ReturnType<typeof detectFfmpeg>>>,
  filePath: string,
): Promise<number | null> {
  const args = [
    "-nostdin",
    "-hide_banner",
    "-i",
    filePath,
    "-filter_complex",
    "ebur128",
    "-f",
    "null",
    "-",
  ];
  const run = await runner.run({ executable: binaries.ffmpegPath, args });
  const match = /I:\s*(-?[\d.]+)\s*LUFS/i.exec(run.stderr);
  return match ? Number(match[1]) : null;
}
