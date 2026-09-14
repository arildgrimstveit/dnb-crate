import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeMonoWav } from "@dnb-crate/audio-analysis";
import { createNodeProcessRunner } from "@dnb-crate/audio-renderer";
import type { AppConfig } from "@dnb-crate/domain";
import { probeKeyEngine, runKeyEngine } from "../src/analysis/key-engine.ts";

// Mandatory real detection. See docs/first-mix.md for the pinned native build.
describe("real KeyFinder integration", () => {
  it.each([
    { key: "Am", notes: [220, 261.625565, 329.627557] },
    { key: "Cm", notes: [261.625565, 311.126984, 391.995436] },
  ])(
    "detects a synthesized $key chord",
    async ({ key, notes }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "dnb-real-key-"));
      try {
        const config: AppConfig = {
          databasePath: ":memory:",
          libraryRoots: [root],
          outputRoot: path.join(root, "output"),
          logLevel: "error",
          supportedExtensions: [".wav"],
          keyfinderPath: process.env.DNB_CRATE_KEYFINDER_PATH,
        };
        const sampleRateHz = 44100;
        const samples = new Float32Array(sampleRateHz * 12);
        for (let i = 0; i < samples.length; i++) {
          const t = i / sampleRateHz;
          const envelope = Math.min(1, t * 10, (12 - t) * 10);
          samples[i] =
            envelope *
            notes.reduce(
              (sum, frequency, index) =>
                sum + (index ? 0.18 : 0.3) * Math.sin(2 * Math.PI * frequency * t),
              0,
            );
        }
        const file = path.join(root, "chord.wav");
        await writeFile(
          file,
          encodeMonoWav({ samples, sampleRateHz, durationMs: 12000, channels: 1 }),
        );
        const runner = createNodeProcessRunner();
        const probe = await probeKeyEngine(config, runner);
        expect(
          probe.available,
          "Build KeyFinder following docs/first-mix.md; this test must not be skipped.",
        ).toBe(true);
        const result = await runKeyEngine(runner, config, file, probe);
        expect(result.musicalKey).toBe(key);
        expect(result.keyConfidence).toBe(0.7);
        expect(result.beatTimesMs).toEqual([]);
        expect(probe.identity).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    60000,
  );
});
