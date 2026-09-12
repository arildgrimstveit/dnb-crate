import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ATEMPO_DRIFT_BUDGET_MS, resolveRateRegions, shouldSkipAtempo } from "@dnb-crate/domain";
import {
  createNodeProcessRunner,
  detectFfmpeg,
  renderMix,
  requireFfmpeg,
  resolveRubberbandCli,
} from "../src/index.ts";

function buildSineWav(durationMs: number, frequencyHz: number, sampleRate = 48_000): Buffer {
  const frameCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const data = Buffer.alloc(frameCount * 2);
  for (let i = 0; i < frameCount; i += 1) {
    const sample = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate);
    data.writeInt16LE(Math.round(sample * 8000), i * 2);
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

function plannedV2(segments: Array<{ sourceMs: number; rate: number }>, overlaps: number[]): number {
  let playable = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    playable += resolveRateRegions(
      segment.sourceMs,
      segment.rate,
      overlaps[i - 1] ?? 0,
      overlaps[i] ?? 0,
    ).at(-1)!.outputEndMs;
  }
  return Math.round(playable - overlaps.reduce((sum, overlap) => sum + overlap, 0));
}

const runner = createNodeProcessRunner();

describe("R3 rate-region fixtures", () => {
  it("matches planned duration for identity, 174→175→174, the inverse, mixed lengths, and aborts cleanly", async (ctx) => {
    const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    const cli = resolveRubberbandCli();
    if (!binaries || !cli) {
      ctx.skip();
      return;
    }
    requireFfmpeg(binaries);
    const root = path.join(os.tmpdir(), `dnb-r3-${process.pid}-${Date.now()}`);
    await mkdir(root, { recursive: true });
    const sourceMs = 20_000;
    const overlapA = 2_000;
    const overlapB = 4_000;
    const cases: Array<{ name: string; rates: number[]; overlaps: number[] }> = [
      { name: "identity", rates: [1, 1, 1], overlaps: [overlapA, overlapA] },
      { name: "174-175-174", rates: [1, 174 / 175, 1], overlaps: [overlapA, overlapA] },
      { name: "175-174-175", rates: [174 / 175, 1, 174 / 175], overlaps: [overlapA, overlapA] },
      { name: "unequal-joins", rates: [1, 174 / 175, 1], overlaps: [overlapA, overlapB] },
    ];
    for (const item of cases) {
      const files: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const filePath = path.join(root, `${item.name}-${i}.wav`);
        await writeFile(filePath, buildSineWav(sourceMs, 220 + i * 40));
        files.push(filePath);
      }
      const segments = files.map((filePath, i) => ({
        filePath,
        sourceStartMs: 0,
        sourceEndMs: sourceMs,
        gainDb: 0,
        playbackRate: item.rates[i],
      }));
      const planned = plannedV2(
        segments.map((segment) => ({
          sourceMs,
          rate: segment.playbackRate ?? 1,
        })),
        item.overlaps,
      );
      const result = await renderMix(runner, binaries, {
        segments,
        overlapMs: item.overlaps,
        outputPath: path.join(root, `${item.name}.wav`),
        rubberbandCliPath: cli,
        rateRegionsVersion: 2,
        truePeakCeilingDb: -1,
        loudnessTargetLufs: -14,
        postProcess: false,
        applyLimiter: false,
      });
      expect(Math.abs(result.durationMs - planned), item.name).toBeLessThan(1000);
      expect(Math.abs(result.expectedDurationMs - planned), item.name).toBeLessThan(50);
    }
    const pairSegments = [
      {
        filePath: path.join(root, "174-175-174-1.wav"),
        sourceStartMs: 0,
        sourceEndMs: sourceMs,
        gainDb: 0,
        playbackRate: 174 / 175,
      },
      {
        filePath: path.join(root, "174-175-174-2.wav"),
        sourceStartMs: 0,
        sourceEndMs: sourceMs,
        gainDb: 0,
        playbackRate: 1,
      },
    ];
    const pairPlanned = plannedV2(
      pairSegments.map((segment) => ({ sourceMs, rate: segment.playbackRate ?? 1 })),
      [overlapA],
    );
    const pair = await renderMix(runner, binaries, {
      segments: pairSegments,
      overlapMs: [overlapA],
      outputPath: path.join(root, "middle-pair.wav"),
      rubberbandCliPath: cli,
      rateRegionsVersion: 2,
      truePeakCeilingDb: -1,
      loudnessTargetLufs: -14,
      postProcess: false,
      applyLimiter: false,
    });
    expect(Math.abs(pair.expectedDurationMs - pairPlanned)).toBeLessThan(50);
    const controller = new AbortController();
    controller.abort();
    await expect(
      renderMix(runner, binaries, {
        segments: pairSegments,
        overlapMs: [overlapA],
        outputPath: path.join(root, "cancelled.wav"),
        rubberbandCliPath: cli,
        rateRegionsVersion: 2,
        truePeakCeilingDb: -1,
        loudnessTargetLufs: -14,
        postProcess: false,
        applyLimiter: false,
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(shouldSkipAtempo(1.001, 8_000)).toBe(true);
    expect(shouldSkipAtempo(174 / 174.3, (32 * 60_000) / 174)).toBe(false);
    expect(resolveRateRegions(20_000, 1.001, 8_000, 0)[0]!.rate).toBe(1);
    expect(ATEMPO_DRIFT_BUDGET_MS).toBe(10);
  }, 180_000);
});
