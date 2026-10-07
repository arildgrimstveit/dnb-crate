import { describe, expect, it } from "vitest";

import {
  PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP,
  PLANNER_GROOVE_SYNCOPATION_PENALTY_SLOPE,
  PLANNER_GROOVE_SYNCOPATION_TOLERANCE,
} from "@dnb-crate/domain";

import { chooseTransition, type TimelineTrack } from "../src/planning/timeline.ts";
import type { PhraseWindow } from "../src/planning/windows.ts";
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

function gridTrack(
  id: string,
  syncopation: number | null,
  barSync?: number | null,
  overrides: {
    /** Per-bar syncopation series overriding the constant barSync fill. */
    barSeries?: Array<number | null>;
    /** First downbeat time; shifts the bar-series origin. */
    downbeat0Ms?: number;
    bpm?: number;
  } = {},
): TimelineTrack {
  const bpm = overrides.bpm ?? 174;
  return {
    id,
    title: `Track ${id.slice(0, 4)}`,
    fileFingerprint: `fp-${id}`,
    durationMs: 180_000,
    energy: 7,
    bpm,
    camelotKey: "8A",
    analysis: {
      gridOk: true,
      bpm,
      canonicalBpm: bpm,
      bpmHint: bpm,
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
      downbeatTimesMs: Array.from(
        { length: 145 },
        (_, i) => (overrides.downbeat0Ms ?? 0) + i * ((4 * 60_000) / 174),
      ),
      downbeatConfidence: 1,
      audioStartMs: 0,
      audioEndMs: 180_000,
      mixInMs: 20_000,
      mixOutMs: 150_000,
      headEnergy: 0.2,
      tailEnergy: 0.2,
      integratedLufs: -10,
      keyConfidence: 1,
      ...(syncopation == null && barSync == null && overrides.barSeries == null
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
                ...(overrides.barSeries != null
                  ? { syncopation: overrides.barSeries }
                  : barSync == null
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
    // Profiles and beat grids cover the whole file so the overlap-local
    // slices at mix-out/mix-in read the same swapped patterns.
    const outgoing = gridTrack("eaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 0.55);
    outgoing.analysis!.bars = swappedBackbone(false);
    outgoing.analysis!.beatTimesMs = fullBeatGrid();
    const incoming = gridTrack("ebbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", 0.6);
    incoming.analysis!.bars = swappedBackbone(true);
    incoming.analysis!.beatTimesMs = fullBeatGrid();
    const chosen = chooseTransition(outgoing, incoming, { chainTargetBpm: 174 });
    expect(chosen.transition.type).toBe("bass_swap");
    expect(chosen.transition.parameters.reason).toBe("groove-kick-conflict");
    expect([8, 12]).toContain(chosen.transition.parameters.lowFadeBars);
    expect(chosen.transition.parameters.lowFadeBars).toBe(
      chosen.transition.parameters.barCount === 32 ? 12 : 8,
    );
  });
});

/** Beat grid covering the 180 s gridTrack fixture (345 ms two-step grid). */
function fullBeatGrid(): number[] {
  return Array.from({ length: Math.floor(180_000 / 345) }, (_, i) => i * 345);
}

describe("structural gate reads the actual overlap interval (F3)", () => {
  // F3 (repository review 2026-10-08): mixOutMs is the START of the outgoing
  // overlap, so the gate must sample the outgoing's bars FROM mixOut for the
  // join's bar count — the old code sampled the 16 bars BEFORE mixOut and
  // gated on material the blend never superimposes.
  const barMs = (4 * 60_000) / 174;
  // Default planning lands mixOut at the outro (150000 ms); the per-bar
  // series index of that position is round(150000 / barMs) = 109.
  const overlapBar = Math.round(150_000 / barMs);

  function series(from: number, to: number, high = 0.9, low = 0.2): Array<number | null> {
    return Array.from({ length: 131 }, (_, bar) => (bar >= from && bar <= to ? high : low));
  }

  function sparseWindow(): Array<number | null> {
    // Only one measured bar inside the overlap: below the two-bar floor.
    return Array.from({ length: 131 }, (_, bar) =>
      bar === overlapBar + 1 ? 0.9 : bar >= overlapBar && bar <= overlapBar + 15 ? null : 0.2,
    );
  }

  function explicitWindow(barCount: 8 | 16 | 32, mixOutMs = 150_000): PhraseWindow {
    return {
      mixInMs: 0,
      mixOutMs,
      mixInBar: 0,
      mixOutBar: null,
      barCount,
      exitKind: "quietTail",
      phraseShape: "complementary",
      incomingDropMs: null,
      dropAnchored: false,
      alignmentOffsetMs: 0,
      alignmentPeriodMs: null,
      alignmentMode: null,
      onsetLockBeats: null,
    };
  }

  it("ignores a syncopation conflict that is only before the overlap", () => {
    // The pre-fix gate read exactly these bars and crossfaded.
    const outgoing = gridTrack("gaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, null, {
      barSeries: series(overlapBar - 16, overlapBar - 1),
    });
    const incoming = gridTrack("gbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", null, null, {
      barSeries: series(0, 130, 0.2, 0.2),
    });
    const chosen = chooseTransition(outgoing, incoming, {
      chainTargetBpm: 174,
      window: explicitWindow(16),
    });
    expect(chosen.transition.type).toBe("phrase_mix");
  });

  it("fires on a conflict inside the overlap and records the evidence", () => {
    const outgoing = gridTrack("haaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, null, {
      barSeries: series(overlapBar, overlapBar + 15),
    });
    const incoming = gridTrack("hbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", null, null, {
      barSeries: series(0, 130, 0.2, 0.2),
    });
    const chosen = chooseTransition(outgoing, incoming, {
      chainTargetBpm: 174,
      window: explicitWindow(16),
    });
    expect(chosen.transition.type).toBe("crossfade");
    expect(chosen.transition.parameters.reason).toBe("groove-syncopation-conflict");
    expect(chosen.transition.parameters.grooveGap).toBeCloseTo(0.7, 2);
    expect(chosen.transition.parameters.grooveOutSync).toBeCloseTo(0.9, 2);
    expect(chosen.transition.parameters.grooveInSync).toBeCloseTo(0.2, 2);
    expect(chosen.transition.parameters.grooveOutBars).toBe(16);
    expect(chosen.transition.parameters.grooveInBars).toBe(16);
    expect(chosen.transition.parameters.grooveOutWindowMs).toBe(150_000);
    expect(chosen.transition.parameters.grooveInWindowMs).toBe(0);
  });

  it("ignores a conflict that is only after the overlap", () => {
    const outgoing = gridTrack("iaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, null, {
      barSeries: series(overlapBar + 16, 130),
    });
    const incoming = gridTrack("ibbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", null, null, {
      barSeries: series(0, 130, 0.2, 0.2),
    });
    const chosen = chooseTransition(outgoing, incoming, {
      chainTargetBpm: 174,
      window: explicitWindow(16),
    });
    expect(chosen.transition.type).toBe("phrase_mix");
  });

  it("fires on the incoming's overlap bars", () => {
    const outgoing = gridTrack("jaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, null, {
      barSeries: series(0, 130, 0.2, 0.2),
    });
    const incoming = gridTrack("jbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", null, null, {
      barSeries: series(0, 15, 0.9, 0.2),
    });
    const chosen = chooseTransition(outgoing, incoming, {
      chainTargetBpm: 174,
      window: explicitWindow(16),
    });
    expect(chosen.transition.type).toBe("crossfade");
    expect(chosen.transition.parameters.grooveInBars).toBe(16);
    expect(chosen.transition.parameters.grooveInWindowMs).toBe(0);
  });

  it("sizes the window to an 8-bar overlap", () => {
    // An 8-bar join must not read 16 bars, and the second 8 bars of the old
    // fixed window are outside this overlap.
    const conflictInFirstHalf = gridTrack("kaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, null, {
      barSeries: series(overlapBar, overlapBar + 7),
    });
    const conflictInSecondHalf = gridTrack("kbaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, null, {
      barSeries: series(overlapBar + 8, overlapBar + 15),
    });
    const incoming = gridTrack("kbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", null, null, {
      barSeries: series(0, 130, 0.2, 0.2),
    });
    expect(
      chooseTransition(conflictInFirstHalf, incoming, {
        chainTargetBpm: 174,
        window: explicitWindow(8),
      }).transition.type,
    ).toBe("crossfade");
    expect(
      chooseTransition(conflictInSecondHalf, incoming, {
        chainTargetBpm: 174,
        window: explicitWindow(8),
      }).transition.type,
    ).toBe("phrase_mix");
  });

  it("covers a 32-bar overlap and reports partial bar coverage honestly", () => {
    // The series ends at bar 130, so a 32-bar window from bar 109 measures
    // only 22 bars — measured, not fabricated.
    const outgoing = gridTrack("laaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, null, {
      barSeries: series(overlapBar, 130),
    });
    const incoming = gridTrack("lbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", null, null, {
      barSeries: series(0, 130, 0.2, 0.2),
    });
    const chosen = chooseTransition(outgoing, incoming, {
      chainTargetBpm: 174,
      window: explicitWindow(32),
    });
    expect(chosen.transition.type).toBe("crossfade");
    expect(chosen.transition.parameters.grooveOutBars).toBe(22);
  });

  it("abstains explicitly when the overlap window is drum-sparse", () => {
    const outgoing = gridTrack("maaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, null, {
      barSeries: sparseWindow(),
    });
    const incoming = gridTrack("mbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", null, null, {
      barSeries: series(0, 130, 0.2, 0.2),
    });
    const chosen = chooseTransition(outgoing, incoming, {
      chainTargetBpm: 174,
      window: explicitWindow(16),
    });
    expect(chosen.transition.type).toBe("phrase_mix");
    expect(chosen.transition.parameters.grooveAbstain).toBe("outgoing-sparse");
  });

  it("honors a nonzero bar-series origin", () => {
    // First downbeat at 690 ms shifts every series index by half a bar.
    const origin = 690;
    const originOverlapBar = Math.round((150_000 - origin) / barMs);
    const conflictInside = gridTrack("naaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, null, {
      barSeries: series(originOverlapBar, originOverlapBar + 15),
      downbeat0Ms: origin,
    });
    const conflictBefore = gridTrack("nbaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, null, {
      barSeries: series(originOverlapBar - 16, originOverlapBar - 1),
      downbeat0Ms: origin,
    });
    const incoming = gridTrack("nbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", null, null, {
      barSeries: series(0, 130, 0.2, 0.2),
    });
    expect(
      chooseTransition(conflictInside, incoming, {
        chainTargetBpm: 174,
        window: explicitWindow(16),
      }).transition.type,
    ).toBe("crossfade");
    expect(
      chooseTransition(conflictBefore, incoming, {
        chainTargetBpm: 174,
        window: explicitWindow(16),
      }).transition.type,
    ).toBe("phrase_mix");
  });

  it("rounds a fractional window start to the nearest bar", () => {
    // mix-out 600 ms past the grid position still samples from bar 109.
    const outgoing = gridTrack("oaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, null, {
      barSeries: series(overlapBar, overlapBar + 15),
    });
    const incoming = gridTrack("obbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", null, null, {
      barSeries: series(0, 130, 0.2, 0.2),
    });
    const chosen = chooseTransition(outgoing, incoming, {
      chainTargetBpm: 174,
      window: explicitWindow(16, 150_600),
    });
    expect(chosen.transition.type).toBe("crossfade");
  });

  it("measures each side in its own bars under unequal rates", () => {
    // Outgoing at 170 BPM plays at ~174/170: the 16-bar overlap at target
    // tempo consumes 16 of the outgoing's own (1411.76 ms) bars from
    // mix-out, in the outgoing's own bar indexing.
    const outBarMs = (4 * 60_000) / 170;
    const outOverlapBar = Math.round(150_000 / outBarMs); // 106
    const conflictInside = gridTrack("paaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, null, {
      barSeries: series(outOverlapBar, outOverlapBar + 15),
      bpm: 170,
    });
    const conflictBefore = gridTrack("pbaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, null, {
      barSeries: series(outOverlapBar - 16, outOverlapBar - 1),
      bpm: 170,
    });
    const incoming = gridTrack("pbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", null, null, {
      barSeries: series(0, 130, 0.2, 0.2),
    });
    expect(
      chooseTransition(conflictInside, incoming, {
        chainTargetBpm: 174,
        window: explicitWindow(16),
      }).transition.type,
    ).toBe("crossfade");
    expect(
      chooseTransition(conflictBefore, incoming, {
        chainTargetBpm: 174,
        window: explicitWindow(16),
      }).transition.type,
    ).toBe("phrase_mix");
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
  for (let beat = 0; beat < Math.floor(180_000 / 345); beat += 1) {
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
