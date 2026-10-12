import { describe, expect, it } from "vitest";

import {
  buildAcrossfadeFilter,
  buildBandMixFilter,
  buildBassSwapFilter,
  buildPhraseMixFilter,
  expectedDurationMs,
  parseEbur128Series,
  RATE_SPLICE_XFADE_SEC,
  limiterAmplitudeFromCeilingDb,
  mixFilterArgs,
  parseEbur128,
  parseFfprobeJson,
  parseFilterComplexScriptSupport,
  parseOutTimeMs,
  parseVersionLine,
  redactInvocation,
  rubberbandTempoFilter,
} from "../src/index.ts";

describe("filter graph", () => {
  it("anchors the acrossfade incoming at the planned timeline when the file boundary differs (Q08 parity)", () => {
    // The band graph honors the planned join anchor since 06371da; the
    // acrossfade path still chains at the processed file boundary. With
    // both decks carrying timeline positions and a real delta (the same
    // ~127 ms class the band graph had under rate-regions splicing), the
    // incoming must be delayed to the PLAN with an equal-power fade pair
    // instead of the boundary acrossfade.
    const filter = buildAcrossfadeFilter({
      trims: [
        { startSec: 0, endSec: 32.976, gainDb: 0, timelineStartSec: 0 },
        { startSec: 0, endSec: 36.625, gainDb: 0, timelineStartSec: 11.034 },
      ],
      overlapSeconds: [22.069],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
    });
    expect(filter).toContain("adelay=11034|11034");
    expect(filter).toContain("amix=inputs=2");
    expect(filter).not.toContain("acrossfade=");
    // The fade pair spans the planned overlap window, not the boundary.
    expect(filter).toContain("afade=t=out:st=");
  });

  it("keeps the boundary acrossfade when the planned anchor matches it (Q08 tolerance)", () => {
    const filter = buildAcrossfadeFilter({
      trims: [
        { startSec: 0, endSec: 32.976, gainDb: 0, timelineStartSec: 0 },
        { startSec: 0, endSec: 36.625, gainDb: 0, timelineStartSec: 10.907 },
      ],
      overlapSeconds: [22.069],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
    });
    expect(filter).toContain("acrossfade=d=22.069");
    expect(filter).not.toContain("adelay=");
  });

  it("parses the ebur128 per-frame loudness series with silence as null (Q04 measurement)", () => {
    // Shape captured from FFmpeg's ebur128 filter (100 ms frames; M/S go
    // -inf during silence; the summary line repeats per frame and the
    // final I/Peak close the log).
    const stderr = [
      "[Parsed_ebur128_0 @ 0x1] t: 0.10417 TARGET:-23 LUFS M: -18.4 S: -18.9 I: -18.7 LUFS LRA: 0.0 LU peak: -3.2 dBFS",
      "[Parsed_ebur128_0 @ 0x1] t: 0.20417 TARGET:-23 LUFS M: -19.1 S: -19.0 I: -18.8 LUFS LRA: 0.0 LU peak: -3.2 dBFS",
      "[Parsed_ebur128_0 @ 0x1] t: 0.30417 TARGET:-23 LUFS M:  -inf S:  -inf I: -18.8 LUFS LRA: 0.0 LU peak: -3.2 dBFS",
      "[Parsed_ebur128_0 @ 0x1] t: 0.40417 TARGET:-23 LUFS M: -19.3 S: -19.1 I: -18.8 LUFS LRA: 0.1 LU peak: -3.1 dBFS",
      "",
      "  Integrated loudness:",
      "    I:         -18.8 LUFS",
      "  Peak:",
      "    Peak:      -3.1 dBFS",
    ].join("\n");
    const series = parseEbur128Series(stderr);
    expect(series.hopMs).toBe(100);
    expect(series.frames).toHaveLength(4);
    expect(series.frames[0]).toEqual({ timeMs: 104, momentaryLufs: -18.4, shortTermLufs: -18.9 });
    // Silence keeps its timestamp with null values - validity and
    // coverage stay measurable.
    expect(series.frames[2]).toEqual({ timeMs: 304, momentaryLufs: null, shortTermLufs: null });
    expect(series.integratedLufs).toBe(-18.8);
    expect(series.truePeakDb).toBe(-3.1);
  });

  it("returns an empty series for logs without frames", () => {
    const series = parseEbur128Series("[Parsed_ebur128_0 @ 0x1] summary only");
    expect(series.frames).toEqual([]);
    expect(series.hopMs).toBe(100);
  });

  it("anchors the incoming at the planned timeline when the CLI-spliced outgoing boundary differs", () => {
    // Rate-regions geometry from the processed-deck corpus's unequal case
    // (174/178 into a 175 target, R3 CLI): the CLI-spliced outgoing runs
    // 32.976 s with a 22.069 s stretched overlap tail, so its pre-overlap
    // length (10.907 s) sits 127 ms BEFORE the planned join position
    // (11.034 s). The incoming deck - and the outgoing fade origin - must
    // anchor at the PLAN's timeline, not at the spliced file boundary,
    // or every kick in the blend flams by the difference.
    const filter = buildBandMixFilter({
      trims: [
        { startSec: 0, endSec: 32.976, gainDb: 0, timelineStartSec: 0 },
        { startSec: 0, endSec: 36.625, gainDb: 0, timelineStartSec: 11.034 },
      ],
      overlapSeconds: [22.069],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
      hasAfadeUnity: true,
      transitions: [{ type: "phrase_mix", barCount: 16, params: { targetBpm: 175 } }],
    });
    expect(filter).toContain("adelay=11034|11034");
    expect(filter).not.toContain("adelay=10907|10907");
  });

  it("falls back to the file-boundary anchor when no timeline is known", () => {
    const filter = buildBandMixFilter({
      trims: [
        { startSec: 0, endSec: 32.976, gainDb: 0 },
        { startSec: 0, endSec: 36.625, gainDb: 0 },
      ],
      overlapSeconds: [22.069],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
      hasAfadeUnity: true,
      transitions: [{ type: "phrase_mix", barCount: 16, params: { targetBpm: 175 } }],
    });
    expect(filter).toContain("adelay=10907|10907");
  });

  it("retains small tempo corrections across long phrases", () => {
    const rate = 174 / 174.3;
    const filter = buildAcrossfadeFilter({
      trims: [
        { startSec: 0, endSec: 90, gainDb: 0, playbackRate: rate },
        { startSec: 0, endSec: 90, gainDb: 0 },
      ],
      overlapSeconds: [44.138],
      limiterAmplitude: 0.89,
      sampleRateHz: 48_000,
    });
    expect(filter).toContain(`atempo=${rate.toFixed(6)}`);
  });
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
    const tiny = buildAcrossfadeFilter({
      trims: [
        { startSec: 0, endSec: 8, gainDb: 0, playbackRate: 1.001 },
        { startSec: 0, endSec: 8, gainDb: 0, playbackRate: 0.999 },
      ],
      overlapSeconds: [2],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
    });
    expect(tiny).not.toContain("atempo");
    const trims = [
      { startSec: 0, endSec: 8, gainDb: 0, playbackRate: 1.03 },
      { startSec: 0, endSec: 8, gainDb: 0, playbackRate: 0.97 },
    ];
    expect(expectedDurationMs(trims, [2], "all")).toBe(
      Math.round((8 / 1.03 + 8 / 0.97 - 2) * 1000),
    );
    expect(expectedDurationMs(trims, [2], "overlap")).toBe(14_000);
  });

  it("stretches only the overlap and acrossfades the rate splice", () => {
    const rate = 174 / 175;
    const overlap = (16 * 4 * 60) / 174;
    const source = 90;
    const filter = buildAcrossfadeFilter({
      trims: [
        { startSec: 0, endSec: source, gainDb: 0, playbackRate: rate },
        { startSec: 0, endSec: source, gainDb: 0 },
      ],
      overlapSeconds: [overlap],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
      tempoEngine: "rubberband",
    });
    expect(filter).toContain(rubberbandTempoFilter(rate));
    expect(filter).toContain("[r0]asplit=2[rb0][rt0]");
    expect(filter).toContain(`acrossfade=d=${RATE_SPLICE_XFADE_SEC}`);
    const whole = buildAcrossfadeFilter({
      trims: [
        { startSec: 0, endSec: source, gainDb: 0, playbackRate: rate },
        { startSec: 0, endSec: source, gainDb: 0 },
      ],
      overlapSeconds: [overlap],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
      tempoEngine: "rubberband",
      stretchScope: "all",
    });
    expect(whole).toContain(rubberbandTempoFilter(rate));
    expect(whole).not.toContain("[r0]asplit=2");
  });

  it("uses listen-accepted Rubber Band settings instead of atempo", () => {
    const rate = 174 / 175;
    const filter = buildAcrossfadeFilter({
      trims: [
        { startSec: 0, endSec: 44, gainDb: 0, playbackRate: rate },
        { startSec: 0, endSec: 44, gainDb: 0 },
      ],
      overlapSeconds: [8],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
      tempoEngine: "rubberband",
    });
    expect(filter).toContain(rubberbandTempoFilter(rate));
    expect(filter).toContain("pitchq=quality");
    expect(filter).toContain("channels=together");
    expect(filter).not.toContain("atempo=");
    expect(filter).not.toContain("transients=smooth");
    expect(filter).not.toContain("window=long");
    const skipped = buildAcrossfadeFilter({
      trims: [
        { startSec: 0, endSec: 8, gainDb: 0, playbackRate: 1.001 },
        { startSec: 0, endSec: 8, gainDb: 0 },
      ],
      overlapSeconds: [2],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
      tempoEngine: "rubberband",
    });
    expect(skipped).not.toContain("rubberband=");
  });

  it("builds a 3-band bass_swap graph with unity fades and no file paths", () => {
    const overlap = (16 * 4 * 60) / 174;
    const filter = buildBandMixFilter({
      trims: [
        { startSec: 0, endSec: 40, gainDb: 0 },
        { startSec: 0, endSec: 40, gainDb: 0 },
      ],
      overlapSeconds: [overlap],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
      hasAfadeUnity: true,
      transitions: [
        {
          type: "bass_swap",
          barCount: 16,
          params: { targetBpm: 174, crossoverHz: 180, swapAtBar: 8, rampMs: 40 },
        },
      ],
    });
    expect(filter).toContain("asplit=3");
    expect(filter).toContain("lowpass=f=180");
    expect(filter).toContain("highpass=f=180");
    expect(filter).toContain("highpass=f=2500");
    expect(filter).toContain("silence=0.063");
    expect(filter).toContain("st=28.965");
    expect(filter).toContain("adelay=17931|17931");
    expect(filter).toContain("[s0]asplit=3");
    expect(filter).not.toContain("[s0]asplit=2[dry][wet]");
    expect(filter).not.toContain("c1=tri:c2=tri");
    expect(filter).toContain("amix=inputs=6");
    expect(filter).not.toMatch(/[A-Za-z]:\\/);
    expect(filter).not.toContain(".wav");
  });

  it("reconstructs the outgoing prefix through complementary 3-band filters", () => {
    const filter = buildPhraseMixFilter({
      trims: [
        { startSec: 10, endSec: 30, gainDb: 0, playbackRate: 1 },
        { startSec: 0, endSec: 20, gainDb: 0, playbackRate: 1 },
      ],
      overlapSeconds: [8],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
      hasAfadeUnity: true,
    });
    expect(filter).toContain("[s0]asplit=3");
    expect(filter).not.toContain("[s0]asplit=2[dry][wet]");
    expect(filter).not.toContain("c1=tri:c2=tri");
    expect(filter).not.toContain("concat=n=2");
    expect(filter).toContain("adelay=12000|12000");
    expect(filter).not.toContain("[mixed]alimiter=");
    expect(filter).toContain("[joined]atrim=start=0:end=32.000000");
  });

  it("does not isolate a prefix shorter than the run-in dry floor", () => {
    const filter = buildPhraseMixFilter({
      trims: [
        { startSec: 0, endSec: 8.2, gainDb: 0, playbackRate: 1 },
        { startSec: 0, endSec: 8, gainDb: 0, playbackRate: 1 },
      ],
      overlapSeconds: [8],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
      hasAfadeUnity: true,
    });
    expect(filter).not.toContain("concat=n=2");
    expect(filter).toContain("[s0]asplit=3");
  });

  it("keeps a short preview prefix inside the 3-band graph", () => {
    const filter = buildPhraseMixFilter({
      trims: [
        { startSec: 229.31, endSec: 264.827, gainDb: 0, playbackRate: 1 },
        { startSec: 187.584, endSec: 223.101, gainDb: 0, playbackRate: 1 },
      ],
      overlapSeconds: [11.034],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
      hasAfadeUnity: true,
      isolatePrefix: false,
    });
    expect(filter).not.toContain("concat=n=2");
    expect(filter).toContain("[s0]asplit=3");
    expect(filter).toContain("adelay=");
    expect(filter).toContain("[joined]atrim=start=0:end=60.000000");
  });

  it("builds a phrase-mix graph as a 3-band split", () => {
    const filter = buildPhraseMixFilter({
      trims: [
        { startSec: 10, endSec: 30, gainDb: 0, playbackRate: 1 },
        { startSec: 0, endSec: 20, gainDb: 0, playbackRate: 1 },
      ],
      overlapSeconds: [8],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
      hasAfadeUnity: true,
    });
    expect(filter).toContain("asplit=3");
    expect(filter).toContain("afade=t=in");
    expect(filter).toContain("afade=t=out");
    expect(filter).toContain("amix=inputs=6");
    expect(filter).not.toMatch(/[A-Za-z]:\\/);
  });

  it("builds a bass-swap graph that splits three bands", () => {
    const filter = buildBassSwapFilter({
      trims: [
        { startSec: 0, endSec: 20, gainDb: 0 },
        { startSec: 0, endSec: 20, gainDb: 0 },
      ],
      overlapSeconds: [8],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
      hasAfadeUnity: true,
      transitions: [
        { type: "bass_swap", barCount: 16, bassSwap: { crossoverHz: 180, rampMs: 40 } },
      ],
    });
    expect(filter).toContain("lowpass=f=180");
    expect(filter).toContain("asplit=3");
    expect(filter).toContain("afade=t=out");
    expect(filter).toContain("afade=t=in");
    expect(filter).not.toContain(".wav");
  });

  it("splits a shared outgoing deck at the previous join’s crossover", () => {
    const filter = buildBandMixFilter({
      trims: [
        { startSec: 0, endSec: 8, gainDb: 0 },
        { startSec: 0, endSec: 8, gainDb: 0 },
      ],
      overlapSeconds: [2],
      limiterAmplitude: limiterAmplitudeFromCeilingDb(-1),
      sampleRateHz: 48_000,
      hasAfadeUnity: true,
      outgoingCrossoverHz: 120,
      transitions: [{ type: "phrase_mix", barCount: 16, params: { crossoverHz: 250 } }],
    });
    expect(filter).toContain("[oRawL]lowpass=f=120,lowpass=f=120[oL0]");
    expect(filter).toContain(
      "[oRawM]highpass=f=120,highpass=f=120,lowpass=f=2500,lowpass=f=2500[oM0]",
    );
    expect(filter).toContain("[iRawL]lowpass=f=250,lowpass=f=250[iL0]");
    expect(filter).toContain(
      "[iRawM]highpass=f=250,highpass=f=250,lowpass=f=2500,lowpass=f=2500[iM0]",
    );
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
    expect(
      parseEbur128(
        "t: 0.1 TARGET:-23 LUFS    M: -70.0 S: -70.0     I:  -70.0 LUFS\n  Integrated loudness:\n    I:         -8.4 LUFS\n  True peak:\n    Peak:       -1.02 dBFS",
      ),
    ).toEqual({ integratedLufs: -8.4, truePeakDb: -1.02 });
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
