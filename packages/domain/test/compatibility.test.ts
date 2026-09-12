import { describe, expect, it } from "vitest";

import {
  camelotDistance,
  camelotNumberDistance,
  interpolateEnergy,
  scoreCandidate,
} from "../src/index.ts";
import type { Track } from "../src/index.ts";

function track(partial: Partial<Track> & Pick<Track, "id" | "title">): Track {
  return {
    filePath: `/virtual/${partial.title}.wav`,
    fileFingerprint: partial.id,
    artist: null,
    album: null,
    durationMs: 150_000,
    sampleRateHz: 44100,
    channels: 2,
    bpm: 174,
    bpmSource: "manual",
    musicalKey: "F#m",
    camelotKey: "11A",
    keySource: "manual",
    energy: 5,
    rating: 4,
    subgenres: [],
    moods: [],
    tags: [],
    notes: null,
    analysisStatus: "not_analyzed",
    fileMissing: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("camelotDistance", () => {
  it("treats identical codes as 0 and relatives/neighbors as 1", () => {
    expect(camelotDistance("11A", "11A")).toBe(0);
    expect(camelotDistance("11A", "11B")).toBe(1);
    expect(camelotDistance("11A", "12A")).toBe(1);
    expect(camelotDistance("11A", "10A")).toBe(1);
    expect(camelotDistance("12A", "1A")).toBe(1);
    expect(camelotDistance("11A", "8B")).toBeGreaterThan(2);
  });

  it("returns null when a key is missing", () => {
    expect(camelotDistance(null, "11A")).toBeNull();
  });
});

describe("camelotNumberDistance", () => {
  it("treats 5A vs 5B as number distance 0", () => {
    expect(camelotNumberDistance("5A", "5B")).toBe(0);
    expect(camelotNumberDistance("5A", "6A")).toBe(1);
  });
});

describe("scoreCandidate", () => {
  it("rewards harmonic neighbours and penalizes missing metadata", () => {
    const source = track({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Source",
      camelotKey: "11A",
    });
    const good = track({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "Neighbour",
      camelotKey: "12A",
      moods: ["liquid"],
    });
    const missing = track({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      title: "Bare",
      bpm: null,
      camelotKey: null,
      energy: null,
    });
    const ctx = {
      source,
      targetEnergy: 6,
      direction: "any" as const,
      preferredMoods: ["liquid"],
      preferredSubgenres: [],
      preferredTags: [],
      preferredArtists: [],
      recentArtistIds: [],
      artistRepeatSpacing: 1,
      harmonicImportance: 1,
      explorationWeight: 0,
      seed: 1,
      alreadyUsed: false,
    };
    const goodScore = scoreCandidate({ ...ctx, candidate: good });
    const missingScore = scoreCandidate({ ...ctx, candidate: missing });
    expect(goodScore.reasons).toContain("HARMONIC_COMPATIBLE");
    expect(missingScore.reasons).toContain("MISSING_BPM");
    expect(goodScore.total).toBeGreaterThan(missingScore.total);
  });

  it("is deterministic for the same seed", () => {
    const candidate = track({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", title: "Same" });
    const ctx = {
      source: null,
      candidate,
      targetEnergy: 5,
      direction: "any" as const,
      preferredMoods: [],
      preferredSubgenres: [],
      preferredTags: [],
      preferredArtists: [],
      recentArtistIds: [],
      artistRepeatSpacing: 1,
      harmonicImportance: 1,
      explorationWeight: 1,
      seed: 7,
      alreadyUsed: false,
    };
    expect(scoreCandidate(ctx).total).toBe(scoreCandidate(ctx).total);
  });
});

describe("interpolateEnergy", () => {
  it("lerps between control points", () => {
    const arc = [
      { atFraction: 0, targetEnergy: 3 },
      { atFraction: 1, targetEnergy: 9 },
    ];
    expect(interpolateEnergy(arc, 0)).toBe(3);
    expect(interpolateEnergy(arc, 1)).toBe(9);
    expect(interpolateEnergy(arc, 0.5)).toBe(6);
  });
});
