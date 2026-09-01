import { describe, expect, it } from "vitest";

import {
  buildAcrossfadeFilter,
  buildBassSwapFilter,
  buildPhraseMixFilter,
  expectedDurationMs,
  limiterAmplitudeFromCeilingDb,
  mixFilterArgs,
  parseEbur128,
  parseFfprobeJson,
  parseFilterComplexScriptSupport,
  parseOutTimeMs,
  parseVersionLine,
  redactInvocation,
} from "../src/index.ts";

describe("filter graph", () => {
  it("builds equal-power acrossfade with hsin curves and no file paths", () => {
    const filter = buildAcrossfadeFilter({
      trims: [
        { startSec: 0, endSec: 8, gainDb: 0 },
        { startSec: 0, endSec: 8, gainDb: -1.5 },
      ],
      overlapSeconds: [2],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
    });
    expect(filter).toContain("c1=hsin");
    expect(filter).toContain("c2=hsin");
    expect(filter).toContain("acrossfade=d=2");
    expect(filter).toContain("volume=-1.5dB");
    expect(filter).not.toMatch(/[A-Za-z]:\\/);
    expect(filter).not.toContain(".wav");
    expect(
      expectedDurationMs(
        [
          { startSec: 0, endSec: 8, gainDb: 0 },
          { startSec: 0, endSec: 8, gainDb: 0 },
        ],
        [2],
      ),
    ).toBe(14_000);
  });

  it("applies pitch-preserving atempo and stretches expected duration", () => {
    const filter = buildAcrossfadeFilter({
      trims: [
        { startSec: 0, endSec: 8, gainDb: 0, playbackRate: 1.03 },
        { startSec: 0, endSec: 8, gainDb: 0, playbackRate: 0.97 },
      ],
      overlapSeconds: [2],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
    });
    expect(filter).toContain("atempo=1.030000");
    expect(filter).toContain("atempo=0.970000");
    expect(filter).not.toContain("asetrate");
    const expected = expectedDurationMs(
      [
        { startSec: 0, endSec: 8, gainDb: 0, playbackRate: 1.03 },
        { startSec: 0, endSec: 8, gainDb: 0, playbackRate: 0.97 },
      ],
      [2],
    );
    expect(expected).toBe(Math.round((8 / 1.03 + 8 / 0.97 - 2) * 1000));
  });

  it("builds a phrase-mix graph with incoming high-pass fade-in", () => {
    const filter = buildPhraseMixFilter({
      trims: [
        { startSec: 10, endSec: 30, gainDb: 0, playbackRate: 1 },
        { startSec: 0, endSec: 20, gainDb: 0, playbackRate: 1 },
      ],
      overlapSeconds: [8],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
    });
    expect(filter).toContain("highpass=f=250");
    expect(filter).toContain("afade=t=in");
    expect(filter).toContain("afade=t=out");
    expect(filter).toContain("amix=inputs=2");
    expect(filter).not.toContain("lowpass");
    expect(filter).not.toMatch(/[A-Za-z]:\\/);
  });

  it("builds a bass-swap graph that splits lows and never uses model filter strings", () => {
    const filter = buildBassSwapFilter({
      trims: [
        { startSec: 0, endSec: 20, gainDb: 0 },
        { startSec: 0, endSec: 20, gainDb: 0 },
      ],
      overlapSeconds: [8],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
      transitions: [
        { type: "bass_swap", barCount: 16, bassSwap: { crossoverHz: 180, rampMs: 40 } },
      ],
    });
    expect(filter).toContain("lowpass=f=180");
    expect(filter).toContain("highpass=f=180");
    expect(filter).toContain("asplit=2");
    expect(filter).toContain("afade=t=out");
    expect(filter).toContain("afade=t=in");
    expect(filter).toContain("c1=hsin");
    expect(filter).not.toContain(".wav");
  });

  it("uses -filter_complex when the script option is unavailable", () => {
    expect(mixFilterArgs("acrossfade=d=1", "job.filter.txt", true)).toEqual([
      "-filter_complex_script",
      "job.filter.txt",
    ]);
    expect(mixFilterArgs("acrossfade=d=1", "job.filter.txt", false)).toEqual([
      "-filter_complex",
      "acrossfade=d=1",
    ]);
  });

  it("redacts filesystem arguments in invocation strings", () => {
    const text = redactInvocation("C:\\bin\\ffmpeg.exe", [
      "-i",
      "D:\\library\\secret.wav",
      "-filter_complex_script",
      "C:\\out\\job.filter.txt",
      "C:\\out\\job.wav",
    ]);
    expect(text.startsWith("ffmpeg ")).toBe(true);
    expect(text).not.toContain("secret");
    expect(text).toContain("[path]");
  });
});

describe("parsers", () => {
  it("parses ffmpeg version, ebur128, progress, and ffprobe json", () => {
    expect(parseVersionLine("ffmpeg version 7.1.1-full_build Copyright")).toBe("7.1.1-full_build");
    expect(
      parseFilterComplexScriptSupport("Missing argument for option 'filter_complex_script'"),
    ).toBe(true);
    expect(
      parseFilterComplexScriptSupport("Unrecognized option 'filter_complex_script'.\r\n"),
    ).toBe(false);
    expect(
      parseEbur128(
        "Integrated loudness:\n    I:         -14.4 LUFS\n  True peak:\n    Peak:       -1.02 dBFS",
      ),
    ).toEqual({ integratedLufs: -14.4, truePeakDb: -1.02 });
    expect(parseOutTimeMs("out_time_us=2500000\nprogress=continue")).toBe(2500);
    const probe = parseFfprobeJson(
      JSON.stringify({
        streams: [
          {
            codec_type: "audio",
            codec_name: "pcm_s24le",
            sample_rate: "48000",
            channels: 2,
            duration: "7.0",
          },
        ],
        format: { duration: "7.0" },
      }),
    );
    expect(probe).toMatchObject({
      durationMs: 7000,
      sampleRateHz: 48000,
      channels: 2,
      isAudio: true,
    });
  });
});
