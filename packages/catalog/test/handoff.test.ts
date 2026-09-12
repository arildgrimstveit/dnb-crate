import { describe, expect, it } from "vitest";

import { pickHandoffCandidate, scoreHandoff } from "../src/planning/handoff.ts";

describe("handoff candidate scoring", () => {
  it("DJ scoring prefers an active outgoing window to a longer quiet overlap", () => {
    const quiet = { barCount: 32 as const, exitKind: "quietTail" as const,
      phraseShape: "complementary" as const, incomingHeadEnergy: 0.1, outgoingTailEnergy: 0.1 };
    const active = { ...quiet, barCount: 16 as const, exitKind: "dropLanding" as const,
      phraseShape: "landing" as const, outgoingTailEnergy: 1 };
    expect(pickHandoffCandidate([quiet, active])).toBe(active);
    expect(scoreHandoff(active).valleyBars)
      .toBeLessThan(scoreHandoff(quiet).valleyBars!);
  });

  it("DJ scoring prefers a later cut to a 32-bar landing that starts in a quiet intro", () => {
    const quietThirtyTwo = {
      barCount: 32 as const,
      exitKind: "dropLanding" as const,
      phraseShape: "landing" as const,
      incomingHeadEnergy: 0.1,
      outgoingTailEnergy: 0.85,
      mixInMs: 12_053,
      mixInBar: 8,
      audioStartMs: 0,
      incomingBars: { rms: Array.from({ length: 32 }, (_, i) => (i < 24 ? 0.08 : 0.85)) },
      outgoingBars: { rms: Array(32).fill(0.85) },
    };
    const laterSixteen = {
      ...quietThirtyTwo,
      barCount: 16 as const,
      mixInMs: 34_000,
      mixInBar: 24,
      incomingBars: { rms: Array.from({ length: 16 }, (_, i) => (i < 8 ? 0.22 : 0.85)) },
      outgoingBars: { rms: Array(16).fill(0.85) },
    };
    expect(pickHandoffCandidate([quietThirtyTwo, laterSixteen]))
      .toBe(laterSixteen);
  });

  it("DJ scoring prefers a 16/32-bar landing to an energetic 8-bar landing", () => {
    const eight = {
      barCount: 8 as const,
      exitKind: "dropLanding" as const,
      phraseShape: "landing" as const,
      incomingHeadEnergy: 0.7,
      outgoingTailEnergy: 0.85,
      mixInMs: 55_000,
      mixInBar: 40,
      audioStartMs: 0,
      incomingBars: { rms: Array(8).fill(0.75) },
      outgoingBars: { rms: Array(8).fill(0.85) },
    };
    const sixteen = {
      ...eight,
      barCount: 16 as const,
      mixInMs: 44_000,
      mixInBar: 32,
      incomingBars: { rms: Array.from({ length: 16 }, (_, i) => (i < 8 ? 0.45 : 0.8)) },
      outgoingBars: { rms: Array(16).fill(0.85) },
    };
    const thirtyTwo = {
      ...eight,
      barCount: 32 as const,
      mixInMs: 22_000,
      mixInBar: 16,
      incomingBars: { rms: Array.from({ length: 32 }, (_, i) => (i < 16 ? 0.45 : 0.85)) },
      outgoingBars: { rms: Array(32).fill(0.85) },
    };
    expect(pickHandoffCandidate([eight, sixteen, thirtyTwo]))
      .toBe(thirtyTwo);
    expect(pickHandoffCandidate([eight, sixteen])).toBe(sixteen);
  });

  it("DJ scoring does not pick 8 bars when a longer window exists", () => {
    const quietThirtyTwo = {
      barCount: 32 as const,
      exitKind: "dropLanding" as const,
      phraseShape: "landing" as const,
      incomingHeadEnergy: 0.08,
      outgoingTailEnergy: 0.85,
      mixInMs: 12_000,
      mixInBar: 8,
      audioStartMs: 0,
      incomingBars: { rms: Array.from({ length: 32 }, (_, i) => (i < 24 ? 0.08 : 0.85)) },
      outgoingBars: { rms: Array(32).fill(0.85) },
    };
    const eight = {
      ...quietThirtyTwo,
      barCount: 8 as const,
      incomingHeadEnergy: 0.7,
      mixInMs: 45_000,
      mixInBar: 32,
      incomingBars: { rms: Array(8).fill(0.8) },
      outgoingBars: { rms: Array(8).fill(0.85) },
    };
    const sixteen = {
      ...eight,
      barCount: 16 as const,
      mixInMs: 34_000,
      mixInBar: 24,
      incomingBars: { rms: Array.from({ length: 16 }, (_, i) => (i < 8 ? 0.22 : 0.85)) },
      outgoingBars: { rms: Array(16).fill(0.85) },
    };
    expect(pickHandoffCandidate([quietThirtyTwo, eight]))
      .toBe(quietThirtyTwo);
    expect(pickHandoffCandidate([quietThirtyTwo, eight, sixteen]))
      .toBe(sixteen);
  });

  it("DJ scoring keeps a 32-bar landing that already has incoming energy", () => {
    const energeticThirtyTwo = {
      barCount: 32 as const,
      exitKind: "dropLanding" as const,
      phraseShape: "landing" as const,
      incomingHeadEnergy: 0.55,
      outgoingTailEnergy: 0.85,
      mixInMs: 23_446,
      mixInBar: 16,
      audioStartMs: 0,
      incomingBars: { rms: Array.from({ length: 32 }, (_, i) => (i < 24 ? 0.5 : 0.9)) },
      outgoingBars: { rms: Array(32).fill(0.85) },
    };
    const laterSixteen = {
      ...energeticThirtyTwo,
      barCount: 16 as const,
      mixInMs: 45_000,
      mixInBar: 32,
      incomingBars: { rms: Array.from({ length: 16 }, (_, i) => (i < 8 ? 0.5 : 0.9)) },
      outgoingBars: { rms: Array(16).fill(0.85) },
    };
    expect(pickHandoffCandidate([energeticThirtyTwo, laterSixteen]))
      .toBe(energeticThirtyTwo);
  });

  it("DJ scoring prefers a later energetic incoming cut to a file-start 32-bar intro", () => {
    const fileStart = {
      barCount: 32 as const,
      exitKind: "dropLanding" as const,
      phraseShape: "landing" as const,
      incomingHeadEnergy: 0.08,
      outgoingTailEnergy: 0.85,
      mixInMs: 177,
      mixInBar: 0,
      audioStartMs: 0,
      incomingBars: { rms: Array.from({ length: 32 }, (_, i) => (i < 28 ? 0.08 : 0.9)) },
      outgoingBars: { rms: Array(32).fill(0.85) },
    };
    const later = {
      ...fileStart,
      barCount: 16 as const,
      mixInMs: 22_000,
      mixInBar: 16,
      incomingBars: { rms: Array.from({ length: 16 }, (_, i) => (i < 12 ? 0.2 : 0.9)) },
      outgoingBars: { rms: Array(16).fill(0.85) },
    };
    expect(pickHandoffCandidate([fileStart, later])).toBe(later);
  });

  it("DJ scoring skips a quiet tail when an active energetic exit exists", () => {
    const quiet = {
      barCount: 8 as const,
      exitKind: "quietTail" as const,
      phraseShape: "complementary" as const,
      incomingHeadEnergy: 0.3,
      outgoingTailEnergy: 0.15,
      mixInMs: 55_000,
      mixInBar: 40,
      audioStartMs: 0,
    };
    const active = {
      ...quiet,
      exitKind: "dropLanding" as const,
      phraseShape: "landing" as const,
      outgoingTailEnergy: 0.9,
    };
    expect(pickHandoffCandidate([quiet, active])).toBe(active);
  });

  it("DJ scoring detects an interior valley even with strong window averages", () => {
    const base = { barCount: 16 as const, exitKind: "dropLanding" as const,
      phraseShape: "landing" as const, incomingHeadEnergy: 0.8, outgoingTailEnergy: 0.8,
      incomingBars: { rms: Array(16).fill(0.2) } };
    const strong = { ...base, outgoingBars: { rms: Array(16).fill(1) } };
    const valley = { ...base, outgoingBars: { rms: Array.from({ length: 16 }, (_, i) => i > 4 && i < 12 ? 0.02 : 1) } };
    expect(scoreHandoff(strong).score)
      .toBeGreaterThan(scoreHandoff(valley).score);
  });
  it("rejects an automatic 32-bar quietTail breather", () => {
    const long = scoreHandoff({
      barCount: 32,
      exitKind: "quietTail",
      phraseShape: "complementary",
      incomingHeadEnergy: 0.12,
      outgoingTailEnergy: 0.2,
    });
    const mid = scoreHandoff({
      barCount: 16,
      exitKind: "quietTail",
      phraseShape: "complementary",
      incomingHeadEnergy: 0.12,
      outgoingTailEnergy: 0.2,
    });
    expect(long.intent).toBe("lift");
    expect(mid.score).toBeGreaterThan(long.score);
  });

  it("prefers an energetic drop landing to a quiet 16-bar tail", () => {
    const chosen = pickHandoffCandidate([
      {
        barCount: 32,
        exitKind: "dropLanding",
        phraseShape: "landing",
        incomingHeadEnergy: 0.25,
        outgoingTailEnergy: 0.9,
        mixOutBar: 40,
      },
      {
        barCount: 16,
        exitKind: "quietTail",
        phraseShape: "complementary",
        incomingHeadEnergy: 0.12,
        outgoingTailEnergy: 0.2,
        mixOutBar: 48,
      },
    ]);
    expect(chosen?.exitKind).toBe("dropLanding");
    expect(chosen?.barCount).toBeGreaterThanOrEqual(16);
  });

  it("keeps a drop landing at 16 bars or longer when no quietTail exit is available", () => {
    const chosen = pickHandoffCandidate([
      {
        barCount: 32,
        exitKind: "dropLanding",
        phraseShape: "landing",
        incomingHeadEnergy: 0.25,
        outgoingTailEnergy: 0.9,
        mixOutBar: 48,
      },
      {
        barCount: 16,
        exitKind: "dropLanding",
        phraseShape: "landing",
        incomingHeadEnergy: 0.25,
        outgoingTailEnergy: 0.9,
        mixOutBar: 64,
      },
      {
        barCount: 8,
        exitKind: "dropLanding",
        phraseShape: "landing",
        incomingHeadEnergy: 0.25,
        outgoingTailEnergy: 0.9,
        mixOutBar: 72,
      },
    ]);
    expect(chosen?.barCount).toBeGreaterThanOrEqual(16);
    expect(chosen?.exitKind).toBe("dropLanding");
    expect(scoreHandoff(chosen!).intent).toBe("sustain");
  });

  it("keeps complementary quietTail at 16 bars instead of cutting to 8", () => {
    const chosen = pickHandoffCandidate([
      {
        barCount: 16,
        exitKind: "quietTail",
        phraseShape: "complementary",
        incomingHeadEnergy: 0.2,
        outgoingTailEnergy: 0.2,
      },
      {
        barCount: 8,
        exitKind: "quietTail",
        phraseShape: "sequential",
        incomingHeadEnergy: 0.6,
        outgoingTailEnergy: 0.2,
      },
    ]);
    expect(chosen?.barCount).toBe(16);
    expect(chosen?.phraseShape).toBe("complementary");
  });

  it("does not auto-pick 8 bars when a 16-bar kit-on sequential exists", () => {
    const chosen = pickHandoffCandidate([
      {
        barCount: 16,
        exitKind: "quietTail",
        phraseShape: "sequential",
        incomingHeadEnergy: 0.7,
        outgoingTailEnergy: 0.6,
      },
      {
        barCount: 8,
        exitKind: "quietTail",
        phraseShape: "sequential",
        incomingHeadEnergy: 0.7,
        outgoingTailEnergy: 0.6,
      },
    ]);
    expect(chosen?.barCount).toBe(16);
  });

  it("uses early-window bar energy when present", () => {
    const quietFront = scoreHandoff({
      barCount: 32,
      exitKind: "quietTail",
      phraseShape: "complementary",
      incomingHeadEnergy: 0.2,
      outgoingTailEnergy: 0.3,
      incomingBars: { rms: Array.from({ length: 32 }, (_, i) => (i < 20 ? 0.02 : 0.8)) },
    });
    const laterStart = scoreHandoff({
      barCount: 16,
      exitKind: "quietTail",
      phraseShape: "complementary",
      incomingHeadEnergy: 0.2,
      outgoingTailEnergy: 0.3,
      incomingBars: { rms: Array.from({ length: 16 }, (_, i) => (i < 4 ? 0.25 : 0.8)) },
    });
    expect(laterStart.incomingEarly).toBeGreaterThan(quietFront.incomingEarly);
    expect(laterStart.score).toBeGreaterThan(quietFront.score);
  });
});
