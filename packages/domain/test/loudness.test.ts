import { describe, expect, it } from "vitest";

import { solveSetGains, windowShortTermLoudness, type SetGainEntry } from "../src/loudness.ts";

describe("window-aware loudness reading (Q04)", () => {
  const series = {
    hopMs: 100,
    shortTermLufs: [
      -13.6,
      -13.4,
      null,
      null, // quiet, partly silent intro
      -8.0,
      -7.9,
      -8.1,
      -8.0, // body
      -6.7,
      -6.8, // hot tail
    ],
  };

  it("reads the body window's representative short-term loudness with coverage", () => {
    const body = windowShortTermLoudness(series, { startMs: 400, endMs: 800 });
    expect(body).not.toBeNull();
    expect(body!.medianLufs).toBe(-8.0);
    expect(body!.coverage).toBe(1);
    expect(body!.frameCount).toBe(4);
  });

  it("reads a different value for the hot tail - sections differ", () => {
    const tail = windowShortTermLoudness(series, { startMs: 800, endMs: 1000 });
    // p50 uses the upper-middle element for even counts (documented
    // quantile convention).
    expect(tail!.medianLufs).toBe(-6.7);
  });

  it("returns null for windows with only silent frames - unknown stays unknown", () => {
    expect(windowShortTermLoudness(series, { startMs: 200, endMs: 400 })).toBeNull();
  });

  it("bounds reads to the series regardless of window overhang", () => {
    const overhang = windowShortTermLoudness(series, { startMs: 0, endMs: 60_000 });
    expect(overhang!.frameCount).toBe(10);
    expect(overhang!.coverage).toBeCloseTo(0.8, 5);
  });
});

describe("joint attenuate-first gain solver (Q04)", () => {
  it("attenuates the hot track instead of leaving the reproduced 5.9 LU difference", () => {
    // The roadmap's reproduced policy failure: levelMatchGainDb(-16, -10,
    // -0.1) returned +0.1 with true-peak headroom - the -10 LUFS track
    // pinned at 0 dB, leaving a 5.9 LU planned difference. The solver
    // brings the hot track DOWN to the quiet one within the -6 floor.
    const entries: SetGainEntry[] = [
      { id: "quiet", bodyShortTermLufs: -16.0, truePeakDb: -12.0, currentGainDb: 0 },
      { id: "hot", bodyShortTermLufs: -10.0, truePeakDb: -0.1, currentGainDb: 0 },
    ];
    const solution = solveSetGains(entries);
    expect(solution.referenceLufs).toBe(-16.0);
    const quiet = solution.gains.find((g) => g.id === "quiet")!;
    const hot = solution.gains.find((g) => g.id === "hot")!;
    // Attenuate-first: the quiet track defines the reference (0 dB) and
    // the HOT track comes DOWN the full 6 dB to meet it - zero total
    // boost, zero residual, where the old policy left 5.9 LU standing.
    expect(quiet.gainDb).toBe(0);
    expect(hot.gainDb).toBe(-6);
    expect(hot.residualLufs).toBeCloseTo(0, 1);
    expect(solution.totalBoostDb).toBe(0);
  });

  it("prefers zero-boost solutions when bodies already agree", () => {
    const entries: SetGainEntry[] = [
      { id: "a", bodyShortTermLufs: -9.0, truePeakDb: -1.0, currentGainDb: 0 },
      { id: "b", bodyShortTermLufs: -9.2, truePeakDb: -1.5, currentGainDb: 0 },
    ];
    const solution = solveSetGains(entries);
    expect(solution.totalBoostDb).toBe(0);
    expect(solution.gains.every((g) => g.gainDb <= 0)).toBe(true);
  });

  it("reports residuals when limits conflict instead of silently accepting", () => {
    // 10 LU spread with a -6 floor cannot be closed from either end.
    const entries: SetGainEntry[] = [
      { id: "very-quiet", bodyShortTermLufs: -20.0, truePeakDb: -0.1, currentGainDb: 0 },
      { id: "very-hot", bodyShortTermLufs: -10.0, truePeakDb: -0.1, currentGainDb: 0 },
    ];
    const solution = solveSetGains(entries);
    const residuals = solution.gains.filter((g) => Math.abs(g.residualLufs) > 0.05);
    expect(residuals.length).toBeGreaterThan(0);
    // The reported residual states exactly how much mismatch remains.
    const totalResidual = solution.gains.reduce((sum, g) => sum + Math.abs(g.residualLufs), 0);
    expect(totalResidual).toBeGreaterThan(3.5);
  });

  it("passes entries without loudness through untouched - unknown stays unknown", () => {
    const entries: SetGainEntry[] = [
      { id: "known", bodyShortTermLufs: -9.0, truePeakDb: -1.0, currentGainDb: 0 },
      { id: "unknown", bodyShortTermLufs: null, truePeakDb: null, currentGainDb: -2.5 },
    ];
    const solution = solveSetGains(entries);
    const unknown = solution.gains.find((g) => g.id === "unknown")!;
    expect(unknown.matched).toBe(false);
    expect(unknown.gainDb).toBe(-2.5);
  });

  it("handles a single-entry set", () => {
    const solution = solveSetGains([
      { id: "solo", bodyShortTermLufs: -8.0, truePeakDb: -1.0, currentGainDb: 0 },
    ]);
    expect(solution.referenceLufs).toBe(-8.0);
    expect(solution.gains[0]!.gainDb).toBe(0);
  });
});
