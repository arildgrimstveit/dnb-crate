import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildClickTrackPcm, encodeMonoWav, type PcmAudio } from "@dnb-crate/audio-analysis";
import {
  createNodeProcessRunner,
  detectFfmpeg,
  renderMix,
  requireFfmpeg,
  type FfmpegBinaries,
} from "@dnb-crate/audio-renderer";
import { DEFAULT_SUPPORTED_EXTENSIONS, type SetPlanV1 } from "@dnb-crate/domain";

import { createCatalogRuntime } from "../src/index.ts";
import { loadPcmForAnalysis } from "../src/analysis/load-pcm.ts";

const runner = createNodeProcessRunner();
const durationMs = 12_000;
const beatMs = 60_000 / 174;
let root: string;
let library: string;
let binaries: FfmpegBinaries;
let catalog: ReturnType<typeof createCatalogRuntime> | undefined;
const files: Record<string, string> = {};

async function ffmpeg(args: string[]) {
  const result = await runner.run({
    executable: binaries.ffmpegPath,
    args: ["-nostdin", "-hide_banner", "-y", ...args],
  });
  expect(result.exitCode, result.stderr).toBe(0);
}

// Find a click's strongest sample in a narrow window. This catches encoder-delay
// offsets without requiring lossy samples to be identical to the WAV original.
function peakMs(pcm: PcmAudio, expectedMs: number): number {
  const start = Math.max(0, Math.floor(((expectedMs - 40) * pcm.sampleRateHz) / 1000));
  const end = Math.min(
    pcm.samples.length,
    Math.ceil(((expectedMs + 40) * pcm.sampleRateHz) / 1000),
  );
  let peak = start;
  for (let i = start; i < end; i++) {
    if (Math.abs(pcm.samples[i]!) > Math.abs(pcm.samples[peak]!)) peak = i;
  }
  expect(Math.abs(pcm.samples[peak]!), `missing click around ${expectedMs} ms`).toBeGreaterThan(
    0.005,
  );
  return (peak * 1000) / pcm.sampleRateHz;
}

describe("real compressed audio integration (requires FFmpeg and libmp3lame)", () => {
  beforeAll(async () => {
    binaries = requireFfmpeg(
      await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" }),
    );
    root = await mkdtemp(path.join(os.tmpdir(), "dnb-compressed-"));
    library = path.join(root, "library");
    await mkdir(library);
    files.wav = path.join(library, "reference.wav");
    await writeFile(
      files.wav,
      encodeMonoWav(buildClickTrackPcm({ bpm: 174, durationMs, offsetMs: 137 })),
    );
    for (const [name, extension, codec] of [
      ["cbr", "mp3", ["-c:a", "libmp3lame", "-b:a", "192k"]],
      ["vbr", "mp3", ["-c:a", "libmp3lame", "-q:a", "2"]],
      ["aac", "m4a", ["-c:a", "aac", "-b:a", "192k"]],
      ["flac", "flac", ["-c:a", "flac"]],
    ] as const) {
      files[name] = path.join(library, `${name}.${extension}`);
      await ffmpeg([
        "-i",
        files.wav,
        ...codec,
        "-metadata",
        `title=${name}`,
        "-metadata",
        "artist=Codec fixture",
        files[name],
      ]);
    }
    const packets = await runner.run({
      executable: binaries.ffprobePath,
      args: [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_packets",
        "-show_entries",
        "packet=size",
        "-of",
        "json",
        files.vbr!,
      ],
    });
    expect(packets.exitCode, packets.stderr).toBe(0);
    const sizes = (JSON.parse(packets.stdout) as { packets: { size: string }[] }).packets.map(
      (packet) => Number(packet.size),
    );
    // CBR padding changes a frame by only one byte; this must be real VBR.
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeGreaterThan(100);
  }, 60_000);

  afterAll(async () => {
    await catalog?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("scans tags, analyzes real CBR/VBR MP3s and renders a mixed-format catalog set", async () => {
    catalog = createCatalogRuntime(
      {
        databasePath: path.join(root, "catalog.sqlite"),
        libraryRoots: [library],
        outputRoot: path.join(root, "output"),
        logLevel: "error",
        supportedExtensions: [...DEFAULT_SUPPORTED_EXTENSIONS],
      },
      undefined,
      { rubberbandCliPath: null },
    );
    await writeFile(path.join(library, "broken.mp3"), "This is not audio");
    const hash = async (file: string) =>
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    const before = await Promise.all(Object.values(files).map(hash));
    const scan = await catalog.service.scanLibrary();
    expect(scan.result.upserted).toBe(5);
    expect(scan.result.skippedMalformed).toBe(1);
    expect(scan.warnings.join(" ")).toContain("broken.mp3");
    expect(scan.warnings.join(" ")).toContain("replace or re-export");
    const tracks = catalog.service.searchTracks({ limit: 20 }).tracks;
    for (const name of ["cbr", "vbr", "aac", "flac"]) {
      expect(tracks.find((track) => track.title === name)?.artist).toBe("Codec fixture");
    }
    const started = catalog.service.startTrackAnalysis({
      trackIds: tracks.map((track) => track.id),
    });
    expect((await catalog.service.waitForAnalysisJob(started.job.id, 60_000)).status).toBe(
      "succeeded",
    );
    for (const track of tracks) {
      const analysis = catalog.service.getTrackAnalysis(track.id);
      expect(Math.abs((analysis.bpm ?? 0) - 174)).toBeLessThan(1);
      expect(analysis.suggestedCues.length).toBeGreaterThan(0);
    }
    const now = new Date().toISOString();
    const plan: SetPlanV1 = {
      schemaVersion: 1,
      id: randomUUID(),
      name: "Mixed format fixture",
      targetDurationMs: 56_000,
      targetBpm: 174,
      requestedArc: [
        { atFraction: 0, targetEnergy: 3 },
        { atFraction: 1, targetEnergy: 6 },
      ],
      entries: tracks.map((track, order) => ({
        id: randomUUID(),
        trackId: track.id,
        order,
        sourceStartMs: 0,
        sourceEndMs: durationMs,
        timelineStartMs: order * 11_000,
        playbackRate: 1,
        gainDb: 0,
        transitionToNext:
          order === tracks.length - 1
            ? null
            : {
                id: randomUUID(),
                type: "crossfade",
                durationMs: 1000,
                outgoingCuePointId: null,
                incomingCuePointId: null,
                parameters: { purpose: "fixture" },
              },
      })),
      createdAt: now,
      updatedAt: now,
    };
    catalog.setPlans.save(plan, 1, {
      seed: 1,
      selected: [],
      rejected: [],
      harmonicCoverage: { knownJoins: 0, totalJoins: 0 },
    });
    const render = await catalog.service.startSetRender({ setPlanId: plan.id });
    const done = await catalog.service.waitForRenderJob(render.job.id, 60_000);
    expect(done.status, JSON.stringify(done)).toBe("succeeded");
    expect(done.outputFormat).toBe("flac");
    const master = await loadPcmForAnalysis(
      path.join(root, "output", done.outputRootRelativePath!),
      runner,
      binaries,
    );
    expect(Math.abs(master.durationMs - 56_000)).toBeLessThan(5);
    expect(done.listenRootRelativePath).toBeTruthy();
    expect(await Promise.all(Object.values(files).map(hash))).toEqual(before);
  }, 120_000);

  it.each(["cbr", "vbr"])(
    "keeps %s MP3 analysis, nonzero cues and transition landmarks on the WAV timeline",
    async (name) => {
      const reference = await loadPcmForAnalysis(files.wav!, runner, binaries);
      const decoded = await loadPcmForAnalysis(files[name]!, runner, binaries);
      expect(Math.abs(decoded.durationMs - reference.durationMs)).toBeLessThan(1);
      for (const beat of [0, 1, 15, 33]) {
        const time = 137 + beat * beatMs;
        expect(Math.abs(peakMs(decoded, time) - peakMs(reference, time))).toBeLessThan(2);
      }
      // Trim both decks at non-frame-aligned cues and align the same beat phase.
      // Check before, inside, and after the overlap against an all-WAV render.
      const cue = 137 + 2 * beatMs - 50;
      const segmentMs = 20 * beatMs;
      const overlapMs = 4 * beatMs;
      for (const type of ["crossfade", "phrase_mix"] as const) {
        const outputs: PcmAudio[] = [];
        for (const sources of [
          [files.wav!, files.wav!],
          [files[name]!, files.flac!],
          [files.flac!, files[name]!],
        ]) {
          const outputPath = path.join(root, `${name}-${type}-${outputs.length}.wav`);
          await renderMix(runner, binaries, {
            segments: sources.map((filePath) => ({
              filePath,
              sourceStartMs: cue,
              sourceEndMs: cue + segmentMs,
              gainDb: 0,
            })),
            overlapMs: [overlapMs],
            transitions: [{ type }],
            outputPath,
            sampleRateHz: 48_000,
            loudnessTargetLufs: -14,
            truePeakCeilingDb: -1,
            postProcess: false,
            applyLimiter: false,
            edgeFadeMs: 0,
          });
          outputs.push(await loadPcmForAnalysis(outputPath, runner, binaries));
        }
        for (const output of outputs.slice(1)) {
          expect(Math.abs(output.durationMs - (2 * segmentMs - overlapMs))).toBeLessThan(2);
          for (const beat of [0, 1, 15, 16, 17, 19, 20, 34]) {
            const time = 50 + beat * beatMs;
            expect(
              Math.abs(peakMs(output, time) - peakMs(outputs[0]!, time)),
              `${type} beat ${beat}`,
            ).toBeLessThan(2);
            expect(Math.abs(peakMs(output, time) - time)).toBeLessThan(5);
          }
        }
      }
    },
    60_000,
  );

  it("reports an actionable decode error for an unreadable MP3", async () => {
    const broken = path.join(root, "unreadable.mp3");
    await writeFile(broken, "not an MP3");
    await expect(loadPcmForAnalysis(broken, runner, binaries)).rejects.toThrow(
      "Cannot decode audio for analysis: unreadable.mp3",
    );
    await expect(loadPcmForAnalysis(broken, runner, binaries)).rejects.toThrow(
      "replace or re-export",
    );
  });
});
