import { describe, expect, it } from "vitest";

import {
  analyzerVersionLessThan,
  assertPlaybackRate,
  DomainError,
  normalizeDnbBpm,
  resolvePublishedReferenceBpm,
  publishedReferenceCandidates,
  outputToSourceMs,
  pairTargetBpm,
  phraseDurationMs,
  playbackRateDriftMs,
  overlapOnlyPlayableMs,
  playbackRateForBpm,
  sourceBpmForRate,
  sourceToOutputMs,
  snapPlaybackRate,
  shouldSkipAtempo,
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

  it("folds half-time published tags for the analyzer lock and leaves 150 unfolded", () => {
    const half = resolvePublishedReferenceBpm(87);
    expect(half.bpm).toBeCloseTo(174, 5);
    expect(half.foldedFrom).toBe(87);
    const crisp = resolvePublishedReferenceBpm(86.49);
    expect(crisp.bpm).toBeCloseTo(172.98, 5);
    expect(crisp.foldedFrom).toBe(86.49);
    const already = resolvePublishedReferenceBpm(176);
    expect(already.bpm).toBe(176);
    expect(already.foldedFrom).toBeNull();
    const off = resolvePublishedReferenceBpm(150);
    expect(off.bpm).toBe(150);
    expect(off.foldedFrom).toBeNull();
  });

  it("lists extra published-lock folds for 140, 105 and 145 tags", () => {
    expect(publishedReferenceCandidates(87)).toContain(174);
    expect(publishedReferenceCandidates(140)).toEqual(expect.arrayContaining([175, 140 * (4 / 3)]));
    expect(publishedReferenceCandidates(105)).toContain(175);
    expect(publishedReferenceCandidates(145)).toContain(174);
    expect(publishedReferenceCandidates(174)).toEqual([174]);
    expect(publishedReferenceCandidates(150).some((value) => Math.abs(value - 174) < 1)).toBe(false);
  });

  it("computes 16-bar phrase length at 174 BPM", () => {
    expect(Math.round(phraseDurationMs(16, 174))).toBe(22069);
  });

  it("locks same-integer pairs and prefers outgoing 174 over a 175 average", () => {
    expect(pairTargetBpm(174, 174)).toBe(174);
    expect(pairTargetBpm(174, 176)).toBe(174);
    expect(pairTargetBpm(174, 176, { chainTargetBpm: 174 })).toBe(174);
    expect(pairTargetBpm(175, 175)).toBe(175);
    expect(pairTargetBpm(175, 174)).toBe(175);
    expect(pairTargetBpm(175, 175, { chainTargetBpm: 174 })).toBe(174);
    expect(snapPlaybackRate(1.001)).toBe(1.001);
    expect(snapPlaybackRate(174 / 176)).toBeCloseTo(174 / 176, 5);
    expect(sourceBpmForRate(175, 176)).toBe(175);
    expect(sourceBpmForRate(null, 176)).toBe(176);
    expect(playbackRateForBpm(175, 174)).toBeCloseTo(174 / 175, 5);
  });

  it("keeps the featured body at rate 1 and stretches only the overlap", () => {
    const rate = 174 / 175;
    const overlap = 16 * 4 * (60_000 / 174);
    const source = 180_000;
    const overlapSrc = overlap * rate;
    expect(overlapOnlyPlayableMs({ sourceMs: source, rate, overlapToNextMs: overlap })).toBeCloseTo(
      source - overlapSrc + overlap,
      5,
    );
    expect(overlapOnlyPlayableMs({ sourceMs: source, rate: 1, overlapToNextMs: overlap })).toBe(source);
    expect(overlapOnlyPlayableMs({ sourceMs: source, rate })).toBeCloseTo(source / rate, 5);
    expect(overlapOnlyPlayableMs({ sourceMs: source, rate: 1.001, overlapToNextMs: 2_000 })).toBe(
      source,
    );
  });

  it("skips atempo only when accumulated drift stays under the 10 ms budget", () => {
    const overlap32 = 32 * 4 * (60_000 / 174);
    expect(playbackRateDriftMs(174 / 174.3, overlap32)).toBeCloseTo(75.97, 1);
    expect(shouldSkipAtempo(174 / 174.3, overlap32)).toBe(false);
    expect(shouldSkipAtempo(1.001, 8_000)).toBe(true);
    expect(shouldSkipAtempo(1, overlap32)).toBe(true);
    expect(sourceToOutputMs(102, 1.02)).toBeCloseTo(100, 10);
    expect(outputToSourceMs(100, 0.98)).toBeCloseTo(98, 10);
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
