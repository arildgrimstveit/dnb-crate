import { describe, expect, it } from "vitest";

import { expandPreset, type TrackSection } from "@dnb-crate/domain";
import { applyAlignmentOffset } from "@dnb-crate/audio-renderer";

import { bakeWindowAlignment, planPhraseWindow } from "../src/planning/windows.ts";
import type { PhraseWindow, WindowTrack } from "../src/planning/windows.ts";

const BPM = 174;
const BAR_MS = (4 * 60_000) / BPM;

function section(
  type: TrackSection["type"],
  startBar: number,
  endBar: number,
  sectionEnergy: number,
): TrackSection {
  return {
    type,
    startMs: Math.round(startBar * BAR_MS),
    endMs: Math.round(endBar * BAR_MS),
    startBar,
    endBar,
    confidence: 0.8,
    sectionEnergy,
  };
}

function track(id: string, sections: TrackSection[], endBar: number): WindowTrack {
  return {
    id,
    durationMs: Math.round(endBar * BAR_MS),
    bpm: BPM,
    analysis: {
      sections,
      canonicalBpm: BPM,
      audioStartMs: 0,
      audioEndMs: Math.round(endBar * BAR_MS),
      downbeatTimesMs: Array.from({ length: endBar * 4 + 1 }, (_, i) => Math.round((i * BAR_MS) / 4)),
      downbeatConfidence: 1,
    },
  };
}

describe("phrase windows", () => {
  it("drop-anchors a 48-bar intro onto a drop-ending outgoing as landing/32", () => {
    const outgoing = track("out", [section("drop", 16, 80, 0.9)], 80);
    const incoming = track(
      "in",
      [section("intro", 0, 16, 0.2), section("build", 16, 48, 0.25), section("drop", 48, 80, 0.9)],
      80,
    );
    const window = planPhraseWindow(outgoing, incoming);
    expect(window.mixInBar).toBe(16);
    expect(window.barCount).toBe(32);
    expect(window.exitKind).toBe("dropLanding");
    expect(window.phraseShape).toBe("landing");
    const curve = expandPreset("phrase_mix", { phraseShape: "landing" }, 32, BAR_MS);
    const incomingLow = curve.find((ev) => ev.target === "incoming_low");
    expect(incomingLow?.atBar).toBe(31);
    expect(incomingLow?.fromDb).toBeNull();
  });

  it("mixes out at the outro phrase boundary as quietTail", () => {
    const outgoing = track(
      "out",
      [section("drop", 16, 48, 0.9), section("outro", 48, 72, 0.2)],
      72,
    );
    const incoming = track(
      "in",
      [section("intro", 0, 16, 0.2), section("build", 16, 48, 0.2), section("drop", 48, 80, 0.85)],
      80,
    );
    const window = planPhraseWindow(outgoing, incoming);
    expect(window.exitKind).toBe("quietTail");
    expect(window.phraseShape).toBe("complementary");
    expect(window.mixOutBar).toBe(48);
  });

  it("uses B=8 when the incoming drop is at bar 8", () => {
    const outgoing = track("out", [section("drop", 16, 48, 0.4), section("outro", 48, 64, 0.2)], 64);
    const incoming = track("in", [section("intro", 0, 8, 0.2), section("drop", 8, 48, 0.85)], 48);
    const window = planPhraseWindow(outgoing, incoming);
    expect(window.barCount).toBe(8);
    expect(window.mixInBar).toBe(0);
    expect(window.mixInMs).toBeGreaterThanOrEqual(0);
  });

  it("marks a kit-on intro sequential with a 2-bar overlap", () => {
    const outgoing = track(
      "out",
      [section("drop", 16, 48, 0.9), section("outro", 48, 72, 0.2)],
      72,
    );
    const incoming = track(
      "in",
      [section("intro", 0, 16, 0.2), section("build", 16, 48, 0.7), section("drop", 48, 80, 0.9)],
      80,
    );
    const window = planPhraseWindow(outgoing, incoming);
    expect(window.exitKind).toBe("quietTail");
    expect(window.phraseShape).toBe("sequential");
    const curve = expandPreset("phrase_mix", { phraseShape: "sequential" }, window.barCount, BAR_MS);
    const incomingMid = curve.find((ev) => ev.target === "incoming_mid");
    const outgoingMid = curve.find((ev) => ev.target === "outgoing_mid");
    expect((outgoingMid?.durationBars ?? 0) - (incomingMid?.atBar ?? 99)).toBe(2);
  });

  it("bakes a 360 ms phrase phase into mix-in and keeps the drop at overlap end", () => {
    const phase = 360;
    const outgoing = track("out", [section("drop", 16, 80, 0.9)], 80);
    const incoming = track(
      "in",
      [section("intro", 0, 16, 0.2), section("build", 16, 48, 0.25), section("drop", 48, 80, 0.9)],
      80,
    );
    const inAnalysis = incoming.analysis!;
    inAnalysis.sections = inAnalysis.sections.map((item) =>
      item.type === "drop" ? { ...item, startMs: item.startMs + phase } : item,
    );
    inAnalysis.downbeatTimesMs = (inAnalysis.downbeatTimesMs ?? []).map((time) => time + phase);
    const unaligned = Math.round(16 * BAR_MS);
    const window = planPhraseWindow(outgoing, incoming);
    expect(window.mixInMs).toBeCloseTo(unaligned + phase, 0);
    expect(window.barCount).toBe(32);
    expect(window.incomingDropMs).toBeCloseTo(window.mixInMs + window.barCount * BAR_MS, 0);
    expect(window.alignmentOffsetMs).toBeCloseTo(phase, 0);
  });

  it("shifts mix-out when a negative nudge cannot move mix-in below 0", () => {
    const outgoing = track("out", [section("drop", 16, 80, 0.9)], 80);
    const incoming = track("in", [section("intro", 0, 8, 0.2), section("drop", 8, 48, 0.85)], 48);
    const base: PhraseWindow = {
      mixInMs: 0,
      mixOutMs: Math.round(48 * BAR_MS),
      mixInBar: 0,
      mixOutBar: 48,
      barCount: 8,
      exitKind: "dropLanding",
      phraseShape: "landing",
      incomingDropMs: Math.round(8 * BAR_MS),
      dropAnchored: true,
      alignmentOffsetMs: 0,
      alignmentPeriodMs: null,
      alignmentMode: null,
    };
    const drop = incoming.analysis!.sections.find((item) => item.type === "drop");
    if (drop) {
      drop.startBar = 9;
    }
    const outAnalysis = outgoing.analysis!;
    outAnalysis.downbeatTimesMs = (outAnalysis.downbeatTimesMs ?? []).map((time) => time + 80);
    const baked = bakeWindowAlignment(outgoing, incoming, base);
    expect(baked.mixInMs).toBe(0);
    expect(baked.mixOutMs).toBeGreaterThan(base.mixOutMs);
    expect(Math.abs(baked.alignmentOffsetMs)).toBeLessThan(BAR_MS / 2);
    expect(Math.abs(baked.alignmentOffsetMs)).not.toBeCloseTo(BAR_MS * 8, 0);
  });

  it("never applies a one-beat period nudge at source start 0", () => {
    const period = BAR_MS / 4;
    const applied = applyAlignmentOffset({
      incomingStartMs: 0,
      incomingEndMs: 180_000,
      outgoingEndMs: 200_000,
      offsetMs: -20,
      periodMs: period,
      incomingRate: 1,
      outgoingRate: 1,
    });
    expect(Math.abs(applied.appliedOffsetMs)).not.toBeCloseTo(period, 0);
    expect(applied.incomingStartMs).toBe(0);
    expect(applied.outgoingEndMs).toBe(200_020);
  });
});
