import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AUDIO_ENGINE_ID } from "@dnb-crate/domain";
import { sha256FileSync } from "@dnb-crate/audio-renderer";
import { describe, expect, it } from "vitest";

import { assertFrozenAudioIdentity, hashRubberbandCli } from "../src/render/engine-identity.ts";

describe("frozen audio identity", () => {
  it("hashes an existing Rubber Band executable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dnb-r3-"));
    const cli = path.join(root, "rubberband.exe");
    await writeFile(cli, "rubberband-v1");
    expect(hashRubberbandCli(cli)).toBe(sha256FileSync(cli));
    expect(hashRubberbandCli(path.join(root, "missing.exe"))).toBeNull();
  });

  it("rejects a queued engine id that no longer matches the running DSP", () => {
    expect(() =>
      assertFrozenAudioIdentity(
        {
          sampleRateHz: 48_000,
          edgeFadeMs: 10,
          previewWindowMs: 30_000,
          loudnessTargetLufs: -14,
          truePeakCeilingDb: -1,
          rendererVersion: "6.14.0",
          audioEngineId: "float-r3-lr4-join-v2",
          rubberbandAvailable: false,
          rubberbandCliPath: null,
          rubberbandSha256: null,
        },
        null,
      ),
    ).toThrow(/incompatible with running/);
    expect(() =>
      assertFrozenAudioIdentity(
        {
          sampleRateHz: 48_000,
          edgeFadeMs: 10,
          previewWindowMs: 30_000,
          loudnessTargetLufs: -14,
          truePeakCeilingDb: -1,
          rendererVersion: "6.14.1",
          audioEngineId: AUDIO_ENGINE_ID,
          rubberbandAvailable: false,
          rubberbandCliPath: null,
          rubberbandSha256: null,
        },
        null,
      ),
    ).not.toThrow();
  });

  it("rejects a replaced Rubber Band executable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dnb-r3-"));
    const cli = path.join(root, "rubberband.exe");
    await writeFile(cli, "rubberband-v1");
    const frozenHash = sha256FileSync(cli);
    await writeFile(cli, "rubberband-v2");
    expect(() =>
      assertFrozenAudioIdentity(
        {
          sampleRateHz: 48_000,
          edgeFadeMs: 10,
          previewWindowMs: 30_000,
          loudnessTargetLufs: -14,
          truePeakCeilingDb: -1,
          rendererVersion: "6.14.1",
          audioEngineId: AUDIO_ENGINE_ID,
          rubberbandAvailable: true,
          rubberbandCliPath: cli,
          rubberbandSha256: frozenHash,
        },
        cli,
      ),
    ).toThrow(/replaced after queue/);
  });
});
