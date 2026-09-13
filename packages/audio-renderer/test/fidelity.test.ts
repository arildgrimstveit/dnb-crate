import { describe, expect, it } from "vitest";

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFakeFfmpegRunner, detectFfmpeg, limiterFilter, renderMix } from "../src/index.ts";

describe("render fidelity policy", () => {
  it("compensates alimiter lookahead when a graph limiter is requested", () => {
    expect(limiterFilter(0.89, true)).toContain("latency=1");
    expect(limiterFilter(0.89, false)).toBe("anull");
  });

  it("refuses stretch fallback in fidelity mode", async () => {
    const runner = createFakeFfmpegRunner({ probeDurationSec: 4 });
    const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    if (!binaries) {
      throw new Error("expected fake FFmpeg binaries");
    }
    await expect(
      renderMix(runner, binaries, {
        segments: [
          { filePath: "a.wav", sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0, playbackRate: 1.02 },
        ],
        overlapMs: [],
        outputPath: "out.wav",
        truePeakCeilingDb: -1,
        loudnessTargetLufs: -14,
        fidelityMode: true,
        postProcess: false,
      }),
    ).rejects.toThrow(/Fidelity mode requires Rubber Band R3/);
  });

  it("refuses stretch fallback on a three-deck fidelity mix before pairwise dispatch", async () => {
    const runner = createFakeFfmpegRunner({ probeDurationSec: 4 });
    const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    if (!binaries) {
      throw new Error("expected fake FFmpeg binaries");
    }
    const request = {
      overlapMs: [1000, 1000],
      outputPath: "out.wav",
      truePeakCeilingDb: -1,
      loudnessTargetLufs: -14,
      fidelityMode: true,
      postProcess: false,
      transitions: [{ type: "bass_swap" as const }, { type: "bass_swap" as const }],
    };
    await expect(
      renderMix(runner, binaries, {
        ...request,
        segments: [
          { filePath: "a.wav", sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0, playbackRate: 1.02 },
          { filePath: "b.wav", sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0 },
          { filePath: "c.wav", sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0 },
        ],
      }),
    ).rejects.toThrow(/Fidelity mode requires Rubber Band R3/);
    await expect(
      renderMix(runner, binaries, {
        ...request,
        segments: [
          { filePath: "a.wav", sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0 },
          { filePath: "b.wav", sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0, playbackRate: 1.02 },
          { filePath: "c.wav", sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0 },
        ],
      }),
    ).rejects.toThrow(/Fidelity mode requires Rubber Band R3/);
  });

  it("refuses a fidelity encode whose measured true peak exceeds the ceiling", async () => {
    const runner = createFakeFfmpegRunner({
      probeDurationSec: 4,
      eburForInput: (inputPath) =>
        inputPath.toLowerCase().endsWith(".flac") ? { truePeakDb: 0.4 } : undefined,
    });
    const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    if (!binaries) {
      throw new Error("expected fake FFmpeg binaries");
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "dnb-peak-"));
    const out = path.join(root, "master.flac");
    await writeFile(path.join(root, "a.wav"), Buffer.from("wav"));
    await expect(
      renderMix(runner, binaries, {
        segments: [
          { filePath: path.join(root, "a.wav"), sourceStartMs: 0, sourceEndMs: 4000, gainDb: 0 },
        ],
        overlapMs: [],
        outputPath: out,
        truePeakCeilingDb: -1,
        loudnessTargetLufs: -14,
        fidelityMode: true,
      }),
    ).rejects.toThrow(/Encoded master true peak 0\.40 dB exceeds ceiling -1 dB/);
  });
});
