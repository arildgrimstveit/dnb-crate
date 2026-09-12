import { describe, expect, it } from "vitest";

import {
  harmonicMixScore,
  harmonicRelation,
  isConfidentKeyClash,
  isConservativeHarmonic,
  recipeFingerprint,
  resolveCanonicalKey,
  resolveCanonicalKeyConfidence,
} from "../src/index.ts";

describe("harmonic relation policy", () => {
  it("classifies same, relative, adjacent same-mode, and other", () => {
    expect(harmonicRelation("5A", "5A")).toBe("same");
    expect(harmonicRelation("5A", "5B")).toBe("relative");
    expect(harmonicRelation("5A", "6A")).toBe("adjacent_same_mode");
    expect(harmonicRelation("5A", "6B")).toBe("other");
    expect(harmonicRelation("5A", "8A")).toBe("other");
    expect(harmonicRelation(null, "5A")).toBe("unknown");
    expect(isConservativeHarmonic("same")).toBe(true);
    expect(isConservativeHarmonic("other")).toBe(false);
  });

  it("scores compatible relations above diagonal others", () => {
    expect(harmonicMixScore("same", 0)).toBe(1);
    expect(harmonicMixScore("relative", 0)).toBe(0.85);
    expect(harmonicMixScore("adjacent_same_mode", 1)).toBe(0.85);
    expect(harmonicMixScore("other", 1)).toBe(0.45);
    expect(harmonicMixScore("other", 3)).toBe(0);
    expect(harmonicMixScore("unknown", null)).toBe(0);
  });

  it("shortens only confident other clashes on long overlaps", () => {
    expect(
      isConfidentKeyClash({
        leftKey: "5A",
        rightKey: "8A",
        leftConfidence: 1,
        rightConfidence: 1,
        plannedBars: 16,
      }),
    ).toBe(true);
    expect(
      isConfidentKeyClash({
        leftKey: "5A",
        rightKey: "6A",
        leftConfidence: 1,
        rightConfidence: 1,
        plannedBars: 16,
      }),
    ).toBe(false);
    expect(
      isConfidentKeyClash({
        leftKey: "5A",
        rightKey: "8A",
        leftConfidence: 0.2,
        rightConfidence: 1,
        plannedBars: 16,
      }),
    ).toBe(false);
    expect(
      isConfidentKeyClash({
        leftKey: "5A",
        rightKey: "8A",
        leftConfidence: 1,
        rightConfidence: 1,
        plannedBars: 8,
      }),
    ).toBe(false);
  });
});

describe("canonical key confidence", () => {
  it("gives manual keys full confidence even when DSP confidence is tiny", () => {
    expect(
      resolveCanonicalKey(
        { musicalKey: "Fm", keySource: "manual" },
        { musicalKey: "Gm", keyConfidence: 0.01 },
      ),
    ).toEqual({ musicalKey: "Fm", source: "manual" });
    expect(
      resolveCanonicalKeyConfidence(
        { musicalKey: "Fm", keySource: "manual" },
        { musicalKey: "Gm", keyConfidence: 0.01 },
      ),
    ).toBe(1);
  });

  it("keeps analyzed keys gated and unknown at 0", () => {
    expect(
      resolveCanonicalKeyConfidence(
        { musicalKey: null, keySource: null },
        { musicalKey: "Gm", keyConfidence: 0.2 },
      ),
    ).toBe(0);
    expect(
      resolveCanonicalKeyConfidence(
        { musicalKey: null, keySource: null },
        { musicalKey: "Gm", keyConfidence: 0.8 },
      ),
    ).toBe(0.8);
  });
});

describe("recipe fingerprint", () => {
  it("is stable across object key order", () => {
    const a = recipeFingerprint({
      type: "phrase_mix",
      barCount: 16,
      intent: "sustain",
      outgoingTrackId: "out",
      incomingTrackId: "in",
    });
    const b = recipeFingerprint({
      incomingTrackId: "in",
      outgoingTrackId: "out",
      intent: "sustain",
      barCount: 16,
      type: "phrase_mix",
    });
    expect(a).toBe(b);
    expect(
      recipeFingerprint({
        type: "phrase_mix",
        barCount: 8,
        intent: "sustain",
        outgoingTrackId: "out",
        incomingTrackId: "in",
      }),
    ).not.toBe(a);
  });
});
