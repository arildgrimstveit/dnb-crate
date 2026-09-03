import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createNodeProcessRunner, detectFfmpeg, mixTagsFromTracklist, renderMix, requireFfmpeg } from "../src/index.ts";

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
    expect(result.invocation).toContain("concat=n=2");
  }, 90_000);

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
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        out,
      ],
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
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-print_format",
        "json",
        "-show_format",
        out,
      ],
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
