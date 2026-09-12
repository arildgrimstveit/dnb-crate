import { describe, expect, it } from "vitest";

import {
  chooseMixIntent,
  choosePhraseShape,
  clampMixPresetParams,
  expandPreset,
  isMonotoneBand,
  resolveRenderPhraseShape,
  sequentialHandoffLabel,
} from "../src/mix-presets.ts";

const BAR_MS = (4 * 60_000) / 174;

describe("mix presets", () => {
  it("softens the incoming vocal-band entrance without moving bass or outgoing automation", () => {
    const base = {
      phraseShape: "landing" as const,
      landingFadeBars: 8 as const,
      landingCarryBars: 4 as const,
    };
    const old = expandPreset("phrase_mix", base, 32, BAR_MS);
    const soft = expandPreset("phrase_mix", { ...base, landingIncomingFadeBars: 8 }, 32, BAR_MS);
    for (const target of ["incoming_mid", "incoming_high"]) {
      expect(old.find((event) => event.target === target)?.atBar).toBe(0);
      expect(old.find((event) => event.target === target)?.durationBars).toBe(28);
      expect(soft.find((event) => event.target === target)?.atBar).toBe(24);
      expect(soft.find((event) => event.target === target)?.durationBars).toBe(8);
    }
    expect(
      soft.filter((event) => !["incoming_mid", "incoming_high"].includes(event.target)),
    ).toEqual(old.filter((event) => !["incoming_mid", "incoming_high"].includes(event.target)));
    expect(clampMixPresetParams({ landingIncomingFadeBars: 32 }, 8).landingIncomingFadeBars).toBe(
      8,
    );
  });
  it("delays the audition arrival by four beats without changing the outgoing mid/high fade", () => {
    const events = expandPreset(
      "phrase_mix",
      { phraseShape: "landing", landingFadeBars: 8, landingCarryBars: 3.5 },
      32,
      BAR_MS,
    );
    expect(events.find((event) => event.target === "incoming_mid")?.durationBars).toBe(28.5);
    expect(events.find((event) => event.target === "incoming_low")?.atBar).toBe(27.5);
    expect(
      events.find((event) => event.target === "outgoing_low" && event.toDb === -24)?.atBar,
    ).toBe(27.5);
    expect(
      events.find((event) => event.target === "outgoing_low" && event.toDb == null)?.atBar,
    ).toBe(28.5);
    expect(events.find((event) => event.target === "outgoing_mid")?.atBar).toBe(24);
  });
  it("moves the landing bass handoff two beats earlier with the incoming drop", () => {
    const events = expandPreset(
      "phrase_mix",
      { phraseShape: "landing", landingFadeBars: 8, landingCarryBars: 4.5 },
      32,
      BAR_MS,
    );
    expect(events.find((event) => event.target === "incoming_mid")?.durationBars).toBe(27.5);
    expect(events.find((event) => event.target === "incoming_low")?.atBar).toBe(26.5);
    expect(
      events.find((event) => event.target === "outgoing_low" && event.toDb === -24)?.atBar,
    ).toBe(26.5);
    expect(
      events.find((event) => event.target === "outgoing_low" && event.toDb == null)?.atBar,
    ).toBe(27.5);
    expect(events.find((event) => event.target === "outgoing_mid")?.atBar).toBe(24);
  });
  it("carries outgoing presence past an earlier drop while releasing its bass separately", () => {
    const events = expandPreset(
      "phrase_mix",
      { phraseShape: "landing", landingFadeBars: 8, landingCarryBars: 4 },
      32,
      BAR_MS,
    );
    expect(events.find((event) => event.target === "incoming_mid")?.durationBars).toBe(28);
    expect(events.find((event) => event.target === "incoming_low")?.atBar).toBe(27);
    expect(
      events.find((event) => event.target === "outgoing_low" && event.toDb === -24)?.atBar,
    ).toBe(27);
    expect(
      events.find((event) => event.target === "outgoing_low" && event.toDb == null)?.atBar,
    ).toBe(28);
    expect(
      events.find((event) => event.target === "outgoing_low" && event.toDb == null)?.durationBars,
    ).toBe(1);
    expect(events.find((event) => event.target === "outgoing_mid")?.atBar).toBe(24);
    expect(events.find((event) => event.target === "outgoing_mid")?.durationBars).toBe(8);
  });
  it("holds outgoing presence until the DJ landing release without changing historical fades", () => {
    const old = expandPreset("phrase_mix", { phraseShape: "landing" }, 32, BAR_MS);
    const dj = expandPreset(
      "phrase_mix",
      { phraseShape: "landing", landingFadeBars: 2 },
      32,
      BAR_MS,
    );
    expect(old.find((event) => event.target === "outgoing_mid")?.atBar).toBe(24);
    expect(dj.find((event) => event.target === "outgoing_mid")?.atBar).toBe(30);
    expect(dj.find((event) => event.target === "outgoing_mid")?.durationBars).toBe(2);
    expect(dj.find((event) => event.target === "incoming_low")?.atBar).toBe(31);
    expect(dj.find((event) => event.target === "outgoing_low" && event.toDb === -24)?.atBar).toBe(
      31,
    );
    expect(dj.find((event) => event.target === "outgoing_low" && event.toDb == null)?.atBar).toBe(
      32,
    );
  });
  it("hands over lift phrase_mix low earlier and holds outgoing mid/high first", () => {
    const sixteen = expandPreset("phrase_mix", null, 16, BAR_MS);
    const incoming16 = sixteen.find((ev) => ev.target === "incoming_low");
    expect(incoming16?.atBar).toBe(8);
    expect(sixteen.some((ev) => ev.toDb === -24 || ev.fromDb === -24)).toBe(true);
    expect(sixteen.find((ev) => ev.target === "outgoing_mid")?.atBar).toBe(4);
    expect(sixteen.find((ev) => ev.target === "outgoing_mid")?.durationBars).toBe(12);
    expect(sixteen.find((ev) => ev.target === "incoming_mid")?.durationBars).toBe(16);
    const thirtyTwo = expandPreset("phrase_mix", null, 32, BAR_MS);
    const incoming32 = thirtyTwo.find((ev) => ev.target === "incoming_low");
    expect(incoming32?.atBar).toBe(16);
    expect(thirtyTwo.find((ev) => ev.target === "outgoing_high")?.atBar).toBe(4);
    expect(thirtyTwo.find((ev) => ev.target === "outgoing_high")?.durationBars).toBe(28);
    expect(isMonotoneBand(sixteen)).toBe(true);
    expect(isMonotoneBand(thirtyTwo)).toBe(true);
  });

  it("keeps sustain complementary as a full-span fade", () => {
    const sixteen = expandPreset("phrase_mix", { intent: "sustain" }, 16, BAR_MS);
    expect(sixteen.find((ev) => ev.target === "incoming_low")?.atBar).toBe(12);
    expect(sixteen.find((ev) => ev.target === "outgoing_mid")?.atBar).toBe(0);
    expect(sixteen.find((ev) => ev.target === "outgoing_mid")?.durationBars).toBe(16);
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
      choosePhraseShape(
        { type: "drop", sectionEnergy: 0.334 },
        { type: "intro", sectionEnergy: 0.217 },
      ),
    ).toBe("sequential");
    expect(
      choosePhraseShape(
        { type: "drop", sectionEnergy: 0.255 },
        { type: "intro", sectionEnergy: 0.204 },
      ),
    ).toBe("complementary");
    expect(
      choosePhraseShape(
        { type: "breakdown", sectionEnergy: 0.096 },
        { type: "intro", sectionEnergy: 0.159 },
      ),
    ).toBe("complementary");
    expect(
      choosePhraseShape(
        { type: "drop", sectionEnergy: 0.334 },
        { type: "intro", sectionEnergy: 0.078 },
      ),
    ).toBe("complementary");
  });

  it("keeps a planned landing at render even when sections look sequential", () => {
    const hotDrop = { type: "drop" as const, sectionEnergy: 0.334 };
    const hotIntro = { type: "intro" as const, sectionEnergy: 0.217 };
    expect(choosePhraseShape(hotDrop, hotIntro)).toBe("sequential");
    expect(resolveRenderPhraseShape("landing", null, hotDrop, hotIntro)).toBe("landing");
    expect(resolveRenderPhraseShape("complementary", "dropLanding", hotDrop, hotIntro)).toBe(
      "complementary",
    );
    expect(resolveRenderPhraseShape("sequential", "quietTail", hotDrop, null)).toBe("sequential");
    expect(resolveRenderPhraseShape(undefined, undefined, hotDrop, hotIntro)).toBe("sequential");
    expect(
      resolveRenderPhraseShape("complementary", "quietTail", hotDrop, {
        type: "intro",
        sectionEnergy: 0.078,
      }),
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
    const outgoingLowEnd = events.find((ev) => ev.target === "outgoing_low" && ev.atBar === 32);
    expect(outgoingLowEnd?.durationMs).toBeGreaterThanOrEqual(1);
  });

  it("crosses landing lows so the last bar is not two full basslines", () => {
    const events = expandPreset("phrase_mix", { phraseShape: "landing" }, 8, BAR_MS);
    const incomingLow = events.find((ev) => ev.target === "incoming_low");
    const outgoingAtten = events.find((ev) => ev.target === "outgoing_low" && ev.toDb === -24);
    const outgoingCut = events.find((ev) => ev.target === "outgoing_low" && ev.toDb == null);
    expect(incomingLow?.atBar).toBe(7);
    expect(outgoingAtten?.atBar).toBe(7);
    expect(outgoingAtten?.fromDb).toBe(0);
    expect(outgoingCut?.atBar).toBe(8);
    expect(outgoingCut?.fromDb).toBe(-24);
    expect(isMonotoneBand(events)).toBe(true);
  });

  it("opens incoming landing bass two bars before an upcoming drop", () => {
    const mixInMs = 45_509;
    const atCut = expandPreset(
      "phrase_mix",
      { phraseShape: "landing", mixInMs, incomingDropMs: mixInMs + 32 * BAR_MS, rampMs: 40 },
      32,
      BAR_MS,
    );
    expect(atCut.find((ev) => ev.target === "incoming_low")?.atBar).toBe(30);
    expect(atCut.find((ev) => ev.target === "incoming_low")?.durationBars).toBe(2);
    expect(atCut.find((ev) => ev.target === "incoming_mid")?.durationBars).toBe(28);
    expect(atCut.find((ev) => ev.target === "outgoing_low" && ev.toDb === -24)?.atBar).toBe(32);
    expect(isMonotoneBand(atCut)).toBe(true);

    const mid = expandPreset(
      "phrase_mix",
      { phraseShape: "landing", mixInMs, incomingDropMs: mixInMs + 16 * BAR_MS },
      32,
      BAR_MS,
    );
    expect(mid.find((ev) => ev.target === "incoming_low")?.atBar).toBe(14);
    expect(mid.find((ev) => ev.target === "outgoing_low" && ev.toDb === -24)?.atBar).toBe(16);

    const alreadyDropping = expandPreset(
      "phrase_mix",
      { phraseShape: "landing", mixInMs, incomingDropMs: mixInMs - 8_000 },
      32,
      BAR_MS,
    );
    expect(alreadyDropping.find((ev) => ev.target === "incoming_low")?.atBar).toBe(31);
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
    expect(clamped.lowHandoverBar).toBe(8);
    expect(clamped.intent).toBe("lift");
  });

  it("does not invent a breather intent", () => {
    expect(chooseMixIntent({ phraseShape: "complementary", exitKind: "quietTail" })).toBe("lift");
    expect(chooseMixIntent({ phraseShape: "sequential" })).toBe("sustain");
    expect(chooseMixIntent({ phraseShape: "landing" })).toBe("sustain");
    expect(chooseMixIntent({ requested: "breather" })).toBe("breather");
  });

  it("describes supported sequential as an overlap, not a mid-phrase hold", () => {
    const supported = expandPreset(
      "phrase_mix",
      { phraseShape: "sequential", sequentialHandoff: "supported" },
      16,
      BAR_MS,
    );
    expect(supported.find((ev) => ev.target === "incoming_mid")?.atBar).toBe(0);
    expect(supported.find((ev) => ev.target === "incoming_mid")?.durationBars).toBe(16);
    expect(supported.find((ev) => ev.target === "outgoing_mid")?.atBar).toBe(0);
    expect(supported.find((ev) => ev.target === "outgoing_mid")?.durationBars).toBe(16);
    expect(sequentialHandoffLabel("supported")).toBe("supported overlap");
    expect(sequentialHandoffLabel("early")).toBe("early overlap");
    expect(sequentialHandoffLabel("legacy")).toBe("incoming kit held until mid-phrase");
  });
});
