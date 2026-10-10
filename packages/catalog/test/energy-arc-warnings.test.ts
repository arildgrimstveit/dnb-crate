import { describe, expect, it } from "vitest";

import type { SetPlanV1, Track } from "@dnb-crate/domain";
import { validateSetPlan } from "../src/planning/validate.ts";

function track(id: string, title: string, energy: number | null): Track {
  return {
    id,
    filePath: `${title}.wav`,
    fileFingerprint: title,
    artist: title,
    title,
    album: null,
    durationMs: 180_000,
    sampleRateHz: 44100,
    channels: 2,
    bpm: 174,
    bpmSource: "manual",
    musicalKey: "Am",
    camelotKey: "8A",
    keySource: "manual",
    energy,
    rating: 4,
    subgenres: [],
    moods: [],
    tags: [],
    notes: null,
    analysisStatus: "complete",
    fileMissing: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function plan(
  energies: Array<number | null>,
  arc: Array<{ atFraction: number; targetEnergy: number }>,
): SetPlanV1 {
  return {
    schemaVersion: 1,
    id: "plan",
    name: "arc fixture",
    targetDurationMs: energies.length * 120_000,
    targetBpm: null,
    requestedArc: arc,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    entries: energies.map((_energy, index) => ({
      id: `e${index}`,
      trackId: `t${index}`,
      order: index,
      sourceStartMs: 0,
      sourceEndMs: 100_000,
      timelineStartMs: index * 90_000,
      playbackRate: 1,
      gainDb: 0,
      transitionToNext:
        index < energies.length - 1
          ? {
              id: `tr${index}`,
              type: "phrase_mix" as const,
              durationMs: 22_069,
              outgoingCuePointId: null,
              incomingCuePointId: null,
              parameters: { barCount: 16, reason: "matched-grid-phrase" },
            }
          : null,
    })),
  };
}

function warningsFor(
  energies: Array<number | null>,
  arc: Array<{ atFraction: number; targetEnergy: number }>,
) {
  const tracksById = new Map(energies.map((e, i) => [`t${i}`, track(`t${i}`, `Track ${i}`, e)]));
  return validateSetPlan(plan(energies, arc), tracksById).warnings.filter(
    (issue) => issue.code === "ENERGY_ARC_DEVIATION",
  );
}

describe("energy-arc warnings stay signal, not noise (2026-10 sessions)", () => {
  const softArc = [
    { atFraction: 0, targetEnergy: 3 },
    { atFraction: 1, targetEnergy: 6 },
  ];

  it("collapses a systematic above-arc run into one summary warning", () => {
    const warnings = warningsFor([7, 7, 7, 8, 7, 7], softArc);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("4 of 6 entries sit above");
    expect(warnings[0]!.message).toContain("pool lacks softer opening material");
  });

  it("keeps isolated deviations as per-entry warnings", () => {
    const warnings = warningsFor([5, 5, 5, 8, 5, 6], softArc);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("Track 3 energy 8 vs target");
  });

  it("stays quiet when the plan tracks the arc", () => {
    expect(warningsFor([3, 4, 5, 5, 6, 6], softArc)).toHaveLength(0);
  });
});
