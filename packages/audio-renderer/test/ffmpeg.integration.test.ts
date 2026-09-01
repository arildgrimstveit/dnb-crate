import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createNodeProcessRunner, detectFfmpeg, renderMix, requireFfmpeg } from "../src/index.ts";

function buildSineWav(durationMs: number, frequencyHz: number, sampleRate = 44_100): Buffer {
  const frameCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const data = Buffer.alloc(frameCount * 2);
  for (let i = 0; i < frameCount; i += 1) {
    const sample = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate);
    data.writeInt16LE(Math.round(sample * 12000), i * 2);
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
});
