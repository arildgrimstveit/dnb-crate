import { describe, expect, it } from "vitest";

import {
  PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP,
  PLANNER_GROOVE_SYNCOPATION_PENALTY_SLOPE,
  PLANNER_GROOVE_SYNCOPATION_TOLERANCE,
} from "@dnb-crate/domain";

import { chooseTransition, type TimelineTrack } from "../src/planning/timeline.ts";
import { grooveCompatibility } from "../src/planning/shared.ts";

function barsWithBackbone(): { beatKick: number[]; beatSnare: number[]; beatOnset: number[] } {
  // 64 beats of a two-step: kick on bar starts, snare on beats 2 and 4.
  const beatKick: number[] = [];
  const beatSnare: number[] = [];
  const beatOnset: number[] = [];
  for (let beat = 0; beat < 64; beat += 1) {
    const pos = beat % 4;
    beatKick.push(pos === 0 ? 1 : 0);
    beatSnare.push(pos === 1 || pos === 3 ? 1 : 0);
    beatOnset.push(pos === 0 || pos === 1 || pos === 3 ? 0.8 : 0.1);
  }
  return { beatKick, beatSnare, beatOnset };
}

describe("grooveCompatibility syncopation penalty", () => {
  it("leaves compatible syncopation levels unscored", () => {
    const bars = barsWithBackbone();
    const base = grooveCompatibility(bars, bars);
    const close = grooveCompatibility(bars, bars, 64, {
      outgoingSyncopation: 0.5,
      incomingSyncopation: 0.5 + PLANNER_GROOVE_SYNCOPATION_TOLERANCE,
    });
    expect(base).not.toBeNull();
    expect(close).toBeCloseTo(base!, 6);
  });

  it("penalizes syncopation gaps linearly above the tolerance", () => {
    const bars = barsWithBackbone();
    const base = grooveCompatibility(bars, bars)!;
    const gap = 0.4; // the measured X-Ray vs Somewhere gap
    const penalized = grooveCompatibility(bars, bars, 64, {
      outgoingSyncopation: 0.84,
      incomingSyncopation: 0.84 - gap,
    })!;
    const expected =
      (gap - PLANNER_GROOVE_SYNCOPATION_TOLERANCE) * PLANNER_GROOVE_SYNCOPATION_PENALTY_SLOPE;
    expect(base - penalized).toBeCloseTo(expected, 6);
  });

  it("applies the penalty even when beat profiles are identical", () => {
    // The cosine terms cannot see off-grid syncopation: identical profiles
    // score perfectly unless the syncopation gap says otherwise.
    const bars = barsWithBackbone();
    const score = grooveCompatibility(bars, bars, 64, {
      outgoingSyncopation: 0.84,
      incomingSyncopation: 0.44,
    })!;
    expect(score).toBeLessThan(grooveCompatibility(bars, bars)! - 0.5);
  });
});

function gridTrack(id: string, syncopation: number | null): TimelineTrack {
  return {
    id,
    title: `Track ${id.slice(0, 4)}`,
    fileFingerprint: `fp-${id}`,
    durationMs: 180_000,
    energy: 7,
    bpm: 174,
    camelotKey: "8A",
    analysis: {
      gridOk: true,
      bpm: 174,
      canonicalBpm: 174,
      bpmHint: 174,
      bpmHintConfidence: 1,
      suggestedEnergy: 0.7,
      introStartMs: 0,
      outroStartMs: 150_000,
      outroEndMs: 180_000,
      introLenMs: 20_000,
      outroLenMs: 30_000,
      sections: [
        {
          type: "intro",
          startMs: 0,
          endMs: 20_000,
          startBar: 0,
          endBar: 16,
          confidence: 1,
          sectionEnergy: 0.2,
        },
        {
          type: "drop",
          startMs: 20_000,
          endMs: 150_000,
          startBar: 16,
          endBar: 120,
          confidence: 1,
          sectionEnergy: 0.8,
        },
        {
          type: "outro",
          startMs: 150_000,
          endMs: 180_000,
          startBar: 120,
          endBar: 144,
          confidence: 1,
          sectionEnergy: 0.2,
        },
      ],
      downbeatTimesMs: Array.from({ length: 145 }, (_, i) => i * ((4 * 60_000) / 174)),
      downbeatConfidence: 1,
      audioStartMs: 0,
      audioEndMs: 180_000,
      mixInMs: 20_000,
      mixOutMs: 150_000,
      headEnergy: 0.2,
      tailEnergy: 0.2,
      integratedLufs: -10,
      keyConfidence: 1,
      ...(syncopation == null
        ? {}
        : {
            descriptors: {
              energy: 0.7,
              danceability: 0.7,
              valence: 0.5,
              acousticness: 0.1,
              melodicness: 0.4,
              subBassRatio: 0.3,
              brightness: 0.5,
              suggestedEnergy: 0.7,
              grooveSyncopation: syncopation,
              backbeatConcentration: 0.6,
              bars: null,
            },
          }),
    },
  };
}

describe("chooseTransition structural groove conflict", () => {
  it("crossfades when the syncopation gap exceeds the structural threshold", () => {
    const outgoing = gridTrack("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 0.84);
    const incoming = gridTrack("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", 0.44);
    // The measured X-Ray vs Somewhere pair must clear the threshold.
    expect(0.84 - 0.44).toBeGreaterThan(PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP);
    const chosen = chooseTransition(outgoing, incoming, { chainTargetBpm: 174 });
    // 0.84 - 0.44 = 0.40 > 0.25: no grid-aligned template can blend these
    // backbones; the only non-fighting option is an equal-power crossfade.
    expect(chosen.transition.type).toBe("crossfade");
    expect(chosen.transition.parameters.reason).toBe("groove-syncopation-conflict");
  });

  it("keeps grid-aligned templates for compatible syncopation levels", () => {
    const outgoing = gridTrack("caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 0.6);
    const incoming = gridTrack("cbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", 0.5);
    const chosen = chooseTransition(outgoing, incoming, { chainTargetBpm: 174 });
    expect(chosen.transition.type).not.toBe("crossfade");
    expect(chosen.transition.type).toBe("phrase_mix");
  });

  it("ignores the structural fallback when syncopation is unmeasured", () => {
    const outgoing = gridTrack("daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null);
    const incoming = gridTrack("dbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", null);
    const chosen = chooseTransition(outgoing, incoming, { chainTargetBpm: 174 });
    expect(chosen.transition.type).toBe("phrase_mix");
  });
});
