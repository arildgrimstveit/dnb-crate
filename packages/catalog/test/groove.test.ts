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

function gridTrack(id: string, syncopation: number | null, barSync?: number): TimelineTrack {
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
      ...(syncopation == null && barSync == null
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
              bars: {
                rms: Array.from({ length: 131 }, (_, i) => (i < 16 ? 0.3 : i < 109 ? 0.8 : 0.3)),
                ...(barSync == null
                  ? {}
                  : {
                      // Constant per-bar syncopation: any overlap-local
                      // window reads exactly barSync.
                      syncopation: Array.from({ length: 131 }, () => barSync),
                    }),
              },
            },
          }),
    },
  };
}

describe("chooseTransition structural groove conflict", () => {
  it("crossfades when the overlap-local syncopation gap exceeds the threshold", () => {
    // Calibrated on X-Ray→Somewhere: local K=16 gap 0.706 (0.925 vs 0.219),
    // the only labeled pair that gallops under every grid-aligned template.
    const outgoing = gridTrack("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 0.84, 0.9);
    const incoming = gridTrack("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", 0.44, 0.2);
    const chosen = chooseTransition(outgoing, incoming, { chainTargetBpm: 174 });
    expect(0.9 - 0.2).toBeGreaterThan(PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP);
    expect(chosen.transition.type).toBe("crossfade");
    expect(chosen.transition.parameters.reason).toBe("groove-syncopation-conflict");
  });

  it("keeps grid-aligned templates for locally compatible grooves", () => {
    // LAMG→Barren shape: local gap 0.48 (0.20 straight tail vs 0.68
    // syncopated head) — user-praised ("Very very good / deep"). The gate
    // must stay silent below the calibrated band.
    const outgoing = gridTrack("caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 0.32, 0.2);
    const incoming = gridTrack("cbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", 0.68, 0.68);
    const chosen = chooseTransition(outgoing, incoming, { chainTargetBpm: 174 });
    expect(Math.abs(0.2 - 0.68)).toBeLessThan(PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP);
    expect(chosen.transition.type).toBe("phrase_mix");
  });

  it("never fires the gate on whole-track syncopation alone", () => {
    // Whole-track gap 0.40 cannot separate praised joins (LAMG→Barren 0.365)
    // from bad ones (X-Ray→Somewhere 0.400): without per-bar data the gate
    // must stay silent and the planner penalty alone steers the pairing.
    const outgoing = gridTrack("daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 0.84);
    const incoming = gridTrack("dbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", 0.44);
    const chosen = chooseTransition(outgoing, incoming, { chainTargetBpm: 174 });
    expect(chosen.transition.type).toBe("phrase_mix");
  });

  it("does not fire the gate when either overlap window is drum-sparse", () => {
    // Sparse incoming head (null bars): no groove to conflict with.
    const outgoing = gridTrack("eaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 0.84, 0.9);
    const incoming = gridTrack("ebbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", 0.44, null);
    const chosen = chooseTransition(outgoing, incoming, { chainTargetBpm: 174 });
    expect(chosen.transition.type).toBe("phrase_mix");
  });

  it("ignores the structural fallback when syncopation is unmeasured", () => {
    const outgoing = gridTrack("daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null);
    const incoming = gridTrack("dbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", null);
    const chosen = chooseTransition(outgoing, incoming, { chainTargetBpm: 174 });
    expect(chosen.transition.type).toBe("phrase_mix");
  });

  it("glides the low end on a groove-triggered bass_swap", () => {
    // Swapped kick/snare labels: the incoming's kicks sit where the
    // outgoing's snares are and vice versa — kick cosine dead, cross-terms
    // maximal — while syncopation stays compatible (no structural conflict).
    const outgoing = gridTrack("eaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 0.55);
    outgoing.analysis!.bars = swappedBackbone(false);
    const incoming = gridTrack("ebbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", 0.6);
    incoming.analysis!.bars = swappedBackbone(true);
    const chosen = chooseTransition(outgoing, incoming, { chainTargetBpm: 174 });
    expect(chosen.transition.type).toBe("bass_swap");
    expect(chosen.transition.parameters.reason).toBe("groove-kick-conflict");
    expect([8, 12]).toContain(chosen.transition.parameters.lowFadeBars);
    expect(chosen.transition.parameters.lowFadeBars).toBe(
      chosen.transition.parameters.barCount === 32 ? 12 : 8,
    );
  });
});

/** Two-step backbone with optionally swapped kick/snare placement. */
function swappedBackbone(swap: boolean): {
  rms: number[];
  beatKick: number[];
  beatSnare: number[];
  beatOnset: number[];
} {
  const beatKick: number[] = [];
  const beatSnare: number[] = [];
  const beatOnset: number[] = [];
  const rms: number[] = [];
  for (let beat = 0; beat < 64; beat += 1) {
    const pos = beat % 4;
    const kickPos = swap ? pos === 1 || pos === 3 : pos === 0;
    const snarePos = swap ? pos === 0 : pos === 1 || pos === 3;
    beatKick.push(kickPos ? 1 : 0);
    beatSnare.push(snarePos ? 1 : 0);
    beatOnset.push(kickPos || snarePos ? 0.8 : 0.1);
    rms.push(kickPos || snarePos ? 0.8 : 0.3);
  }
  return { rms, beatKick, beatSnare, beatOnset };
}
