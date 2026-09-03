import { describe, expect, it } from "vitest";

import {
  choosePhraseShape,
  clampMixPresetParams,
  expandPreset,
  isMonotoneBand,
} from "../src/mix-presets.ts";

const BAR_MS = (4 * 60_000) / 174;

describe("mix presets", () => {
  it("hands over phrase_mix low at bar 12 of 16 and 24 of 32", () => {
    const sixteen = expandPreset("phrase_mix", null, 16, BAR_MS);
    const incoming16 = sixteen.find((ev) => ev.target === "incoming_low");
    expect(incoming16?.atBar).toBe(12);
    expect(sixteen.some((ev) => ev.toDb === -24 || ev.fromDb === -24)).toBe(true);
    expect(sixteen.find((ev) => ev.target === "outgoing_mid")?.atBar).toBe(0);
    expect(sixteen.find((ev) => ev.target === "outgoing_mid")?.durationBars).toBe(16);
    expect(sixteen.find((ev) => ev.target === "incoming_mid")?.durationBars).toBe(16);
    const thirtyTwo = expandPreset("phrase_mix", null, 32, BAR_MS);
    const incoming32 = thirtyTwo.find((ev) => ev.target === "incoming_low");
    expect(incoming32?.atBar).toBe(24);
    expect(thirtyTwo.find((ev) => ev.target === "outgoing_high")?.durationBars).toBe(32);
    expect(isMonotoneBand(sixteen)).toBe(true);
    expect(isMonotoneBand(thirtyTwo)).toBe(true);
  });

  it("holds incoming drums until mid-phrase on a sequential phrase_mix", () => {
    const thirtyTwo = expandPreset("phrase_mix", { phraseShape: "sequential" }, 32, BAR_MS);
    expect(thirtyTwo.find((ev) => ev.target === "incoming_mid")?.atBar).toBe(14);
    expect(thirtyTwo.find((ev) => ev.target === "incoming_mid")?.durationBars).toBe(18);
    expect(thirtyTwo.find((ev) => ev.target === "outgoing_mid")?.atBar).toBe(0);
    expect(thirtyTwo.find((ev) => ev.target === "outgoing_mid")?.durationBars).toBe(16);
    expect(isMonotoneBand(thirtyTwo)).toBe(true);
  });

  it("uses sequential drums only for a hot drop into a drum-heavy intro", () => {
    expect(
      choosePhraseShape({ type: "drop", sectionEnergy: 0.334 }, { type: "intro", sectionEnergy: 0.217 }),
    ).toBe("sequential");
    expect(
      choosePhraseShape({ type: "drop", sectionEnergy: 0.255 }, { type: "intro", sectionEnergy: 0.204 }),
    ).toBe("complementary");
    expect(
      choosePhraseShape(
        { type: "breakdown", sectionEnergy: 0.096 },
        { type: "intro", sectionEnergy: 0.159 },
      ),
    ).toBe("complementary");
    expect(
      choosePhraseShape({ type: "drop", sectionEnergy: 0.334 }, { type: "intro", sectionEnergy: 0.078 }),
    ).toBe("complementary");
  });

  it("holds incoming low at -inf until the last bar on a landing phrase", () => {
    const events = expandPreset("phrase_mix", { phraseShape: "landing" }, 32, BAR_MS);
    const incomingLow = events.find((ev) => ev.target === "incoming_low");
    expect(incomingLow?.atBar).toBe(31);
    expect(incomingLow?.fromDb).toBeNull();
    expect(incomingLow?.toDb).toBe(0);
    expect(events.find((ev) => ev.target === "outgoing_mid")?.atBar).toBe(24);
    expect(events.find((ev) => ev.target === "outgoing_mid")?.durationBars).toBe(8);
    expect(isMonotoneBand(events)).toBe(true);
  });

  it("swaps bass at bar 8 of 16 and 16 of 32", () => {
    const sixteen = expandPreset("bass_swap", null, 16, BAR_MS);
    expect(sixteen.find((ev) => ev.target === "incoming_low")?.atBar).toBe(8);
    expect(sixteen.some((ev) => ev.toDb === -24 || ev.fromDb === -24)).toBe(true);
    const thirtyTwo = expandPreset("bass_swap", null, 32, BAR_MS);
    expect(thirtyTwo.find((ev) => ev.target === "incoming_low")?.atBar).toBe(16);
    expect(isMonotoneBand(sixteen)).toBe(true);
    expect(isMonotoneBand(thirtyTwo)).toBe(true);
  });

  it("clamps invalid preset params", () => {
    const clamped = clampMixPresetParams(
      {
        crossoverHz: 80,
        rampMs: 5,
        swapAtBar: 7,
        lowAttenuationDb: -80,
        midDipDb: -40,
        lowHandoverBar: 3,
        targetBpm: 174,
      },
      16,
    );
    expect(clamped.crossoverHz).toBe(120);
    expect(clamped.rampMs).toBe(20);
    expect(clamped.swapAtBar).toBe(8);
    expect(clamped.lowAttenuationDb).toBe(-36);
    expect(clamped.midDipDb).toBe(-24);
    expect(clamped.lowHandoverBar).toBe(12);
  });
});
