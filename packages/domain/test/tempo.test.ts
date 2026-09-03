import { describe, expect, it } from "vitest";

import {
  analyzerVersionLessThan,
  assertPlaybackRate,
  DomainError,
  normalizeDnbBpm,
  phraseDurationMs,
  playbackRateForBpm,
  publishedBpmTolerance,
  reconstructGrid,
  resolveBpmHint,
  snapToNearestBeat,
} from "../src/index.ts";

describe("DnB tempo helpers", () => {
  it("folds half-time 87 BPM to 174", () => {
    const folded = normalizeDnbBpm(87);
    expect(folded?.bpm).toBeCloseTo(174, 5);
    expect(folded?.foldedFrom).toBe(87);
  });

  it("folds double-time 348 BPM to 174", () => {
    const folded = normalizeDnbBpm(348);
    expect(folded?.bpm).toBeCloseTo(174, 5);
  });

  it("rejects tempos that cannot land in 160–190", () => {
    expect(normalizeDnbBpm(100)).toBeNull();
    expect(normalizeDnbBpm(40)).toBeNull();
  });

  it("computes 16-bar phrase length at 174 BPM", () => {
    expect(Math.round(phraseDurationMs(16, 174))).toBe(22069);
  });

  it("enforces ±3% playback rate unless overridden", () => {
    const rate = playbackRateForBpm(174, 174 * 1.02);
    expect(() => assertPlaybackRate(rate)).not.toThrow();
    expect(() => assertPlaybackRate(playbackRateForBpm(174, 186))).toThrow(DomainError);
    expect(() =>
      assertPlaybackRate(playbackRateForBpm(174, 186), { allowExcessive: true }),
    ).not.toThrow();
  });

  it("reconstructs a 4/4 grid from a manual anchor", () => {
    const grid = reconstructGrid(120, 174, 10_000);
    expect(grid.beatTimesMs[0]).toBeGreaterThanOrEqual(0);
    const snapped = snapToNearestBeat(120, grid.beatTimesMs);
    expect(snapped).not.toBeNull();
    expect(Math.abs(snapped!.positionMs - 120)).toBeLessThan(5);
    expect(grid.downbeatTimesMs.length).toBeGreaterThan(0);
  });

  it("uses 1.0 BPM tolerance for integer published tempo", () => {
    expect(publishedBpmTolerance(176)).toBe(1);
    expect(publishedBpmTolerance(173.7)).toBe(0.5);
  });

  it("compares analyzer versions", () => {
    expect(analyzerVersionLessThan("2.0.0", "2.1.0")).toBe(true);
    expect(analyzerVersionLessThan("2.1.0", "2.1.0")).toBe(false);
    expect(analyzerVersionLessThan("3.0.0", "2.1.0")).toBe(false);
  });

  it("resolves a bpmHint only for rejected in-range raw estimates", () => {
    expect(
      resolveBpmHint({ gridRejected: true, bpmRaw: 174, bpmConfidence: 0.4 }).bpm,
    ).toBe(174);
    expect(
      resolveBpmHint({ gridRejected: true, bpmRaw: 124, bpmConfidence: 0.9 }).bpm,
    ).toBeNull();
    expect(
      resolveBpmHint({ gridRejected: true, bpmRaw: 174, bpmConfidence: 0.2 }).bpm,
    ).toBeNull();
    expect(
      resolveBpmHint({ gridRejected: false, bpmRaw: 174, bpmConfidence: 0.9 }).bpm,
    ).toBeNull();
  });
});
