import { describe, expect, it } from "vitest";

import { expandPreset, type TrackSection } from "@dnb-crate/domain";
import { applyAlignmentOffset } from "@dnb-crate/audio-renderer";

import {
  bakeWindowAlignment,
  breakdownEntry,
  landingErrorMs,
  planPhraseWindow,
} from "../src/planning/windows.ts";
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
      downbeatTimesMs: Array.from({ length: endBar * 4 + 1 }, (_, i) =>
        Math.round((i * BAR_MS) / 4),
      ),
      downbeatConfidence: 1,
    },
  };
}

describe("phrase windows", () => {
  it("skips a long quiet outro and intro while keeping the drop aligned", () => {
    const outgoing = track(
      "out",
      [section("drop", 16, 96, 0.9), section("outro", 96, 160, 0.08)],
      160,
    );
    const incoming = track(
      "in",
      [section("intro", 0, 80, 0.08), section("drop", 80, 160, 0.9)],
      160,
    );
    const window = planPhraseWindow(outgoing, incoming);
    expect(window.mixOutMs + window.barCount * BAR_MS).toBeLessThanOrEqual(96 * BAR_MS + 2);
    expect(window.mixInMs).toBeGreaterThan(40 * BAR_MS);
    expect(Math.abs(landingErrorMs(window, 1, window.barCount * BAR_MS)!)).toBeLessThan(2);
    expect(window.continuity?.evidence).toBe("section-energy-proxy");
    expect(window.continuity?.energyFloor).toBeGreaterThan(0.25);
  });

  it("skips a 32-bar quiet intro that starts after file-start when a later cut exists", () => {
    const outgoing = track("out", [section("drop", 16, 96, 0.9)], 96);
    const incoming = track("in", [section("intro", 0, 41, 0.08), section("drop", 41, 96, 0.9)], 96);
    const dj = planPhraseWindow(outgoing, incoming);
    expect(dj.mixInMs).toBeGreaterThan(2_800);
    expect(dj.barCount).toBeLessThan(32);
    expect(Math.abs(landingErrorMs(dj, 1, dj.barCount * BAR_MS)!)).toBeLessThan(2);
  });

  it("keeps a 32-bar landing that starts in an opening build, not at file start", () => {
    const outgoing = track("out", [section("drop", 16, 96, 0.9)], 96);
    const incoming = track(
      "in",
      [section("intro", 0, 16, 0.12), section("build", 16, 48, 0.4), section("drop", 48, 96, 0.9)],
      96,
    );
    const dj = planPhraseWindow(outgoing, incoming);
    expect(dj.barCount).toBe(32);
    expect(dj.mixInBar).toBe(16);
    expect(Math.abs(landingErrorMs(dj, 1, 32 * BAR_MS)!)).toBeLessThan(2);
  });

  it("skips a file-start 32-bar intro when a later cut exists", () => {
    const outgoing = track("out", [section("drop", 16, 96, 0.9)], 96);
    const incoming = track("in", [section("intro", 0, 32, 0.08), section("drop", 32, 96, 0.9)], 96);
    const dj = planPhraseWindow(outgoing, incoming);
    expect(dj.mixInBar).toBeGreaterThan(0);
    expect(dj.barCount).toBeLessThan(32);
    expect(Math.abs(landingErrorMs(dj, 1, dj.barCount * BAR_MS)!)).toBeLessThan(2);
  });

  it("never auto-picks an 8-bar join when 16 is feasible", () => {
    const outgoing = track("out", [section("drop", 16, 96, 0.9)], 96);
    const incoming = track(
      "in",
      [section("intro", 0, 8, 0.2), section("build", 8, 24, 0.7), section("drop", 24, 64, 0.9)],
      64,
    );
    const dj = planPhraseWindow(outgoing, incoming);
    expect(dj.barCount).toBeGreaterThanOrEqual(16);
    expect(dj.mixInBar).toBeGreaterThanOrEqual(8);
    expect(Math.abs(landingErrorMs(dj, 1, dj.barCount * BAR_MS)!)).toBeLessThan(2);
  });

  it("cuts a late-only drop 16 bars before the drop instead of file start", () => {
    const outgoing = track("out", [section("drop", 16, 144, 0.9)], 160);
    const incoming = track(
      "in",
      [
        section("intro", 0, 8, 0.05),
        section("build", 8, 184, 0.22),
        section("drop", 184, 200, 0.38),
        section("bridge", 200, 220, 0.29),
      ],
      220,
    );
    const dj = planPhraseWindow(outgoing, incoming);
    expect(dj.barCount).toBe(16);
    expect(dj.mixInBar).toBe(168);
    expect(dj.mixInMs).toBeGreaterThan(160 * BAR_MS);
    expect(Math.abs(landingErrorMs(dj, 1, 16 * BAR_MS)!)).toBeLessThan(2);
  });

  it("keeps a late-drop outgoing tail after a deep incoming cut", () => {
    const outgoing = track(
      "out",
      [
        section("intro", 0, 8, 0.05),
        section("build", 8, 184, 0.22),
        section("drop", 184, 200, 0.38),
        section("bridge", 200, 220, 0.29),
      ],
      220,
    );
    const incoming = track(
      "in",
      [section("intro", 0, 64, 0.2), section("drop", 80, 160, 0.9)],
      160,
    );
    const start = 168 * BAR_MS;
    const dj = planPhraseWindow(outgoing, incoming, {
      outgoingSourceStartMs: start,
      outgoingHeadEndMs: start + 16 * BAR_MS,
    });
    expect(dj.barCount).toBeGreaterThanOrEqual(16);
    expect(dj.mixOutMs).toBeGreaterThan(184 * BAR_MS);
    expect(dj.mixOutMs + dj.barCount * BAR_MS - start).toBeGreaterThan(60_000);
  });

  it("prefers a 16/32-bar landing to an 8 when the longer cut has energy", () => {
    const outgoing = track("out", [section("drop", 16, 96, 0.9)], 96);
    const incoming = track(
      "in",
      [section("intro", 0, 16, 0.35), section("build", 16, 48, 0.5), section("drop", 48, 96, 0.9)],
      96,
    );
    const dj = planPhraseWindow(outgoing, incoming);
    expect(dj.exitKind).toBe("dropLanding");
    expect(dj.barCount).toBeGreaterThanOrEqual(16);
    expect(Math.abs(landingErrorMs(dj, 1, dj.barCount * BAR_MS)!)).toBeLessThan(2);
  });

  it("skips a quiet tail when an earlier energetic exit exists", () => {
    const outgoing = track(
      "out",
      [section("drop", 16, 80, 0.9), section("outro", 80, 112, 0.1)],
      112,
    );
    const incoming = track("in", [section("intro", 0, 8, 0.2), section("drop", 8, 64, 0.9)], 64);
    const dj = planPhraseWindow(outgoing, incoming);
    expect(dj.exitKind).toBe("dropLanding");
    expect(dj.mixOutBar).toBeLessThan(80);
    expect(dj.phraseShape).toBe("landing");
  });

  it("respects manual source cues", () => {
    const outgoing = track(
      "out",
      [section("drop", 16, 96, 0.9), section("outro", 96, 160, 0.08)],
      160,
    );
    const incoming = track(
      "in",
      [section("intro", 0, 80, 0.08), section("drop", 80, 160, 0.9)],
      160,
    );
    outgoing.analysis!.manualMixOutMs = Math.round(104 * BAR_MS);
    const window = planPhraseWindow(outgoing, incoming);
    expect(window.mixOutMs).toBeCloseTo(outgoing.analysis!.manualMixOutMs, 0);
  });

  it("chooses a feasible exit when the active exit leaves too little featured audio", () => {
    const outgoing = track(
      "out",
      [section("drop", 16, 96, 0.9), section("outro", 96, 160, 0.08)],
      160,
    );
    const incoming = track(
      "in",
      [section("intro", 0, 80, 0.4), section("drop", 80, 160, 0.9)],
      160,
    );
    const window = planPhraseWindow(outgoing, incoming, {
      outgoingSourceStartMs: 48 * BAR_MS,
      outgoingHeadEndMs: 64 * BAR_MS,
    });
    expect(window.mixOutMs + window.barCount * BAR_MS - 48 * BAR_MS).toBeGreaterThanOrEqual(90_000);
    expect(window.mixOutMs).toBeGreaterThan(64 * BAR_MS);
  });
  it("keeps a 32-bar opening landing when the build is not a dead intro", () => {
    const outgoing = track("out", [section("drop", 16, 80, 0.9)], 80);
    const incoming = track(
      "in",
      [section("intro", 0, 16, 0.2), section("build", 16, 48, 0.25), section("drop", 48, 80, 0.9)],
      80,
    );
    const window = planPhraseWindow(outgoing, incoming);
    expect(window.barCount).toBe(32);
    expect(window.mixInBar).toBe(16);
    expect(window.exitKind).toBe("dropLanding");
    expect(window.phraseShape).toBe("landing");
    expect(Math.abs(landingErrorMs(window, 1, 32 * BAR_MS)!)).toBeLessThan(2);
  });

  it("drop-anchors a 48-bar intro onto a drop-ending outgoing", () => {
    const outgoing = track("out", [section("drop", 16, 80, 0.9)], 80);
    const incoming = track(
      "in",
      [section("intro", 0, 16, 0.2), section("build", 16, 48, 0.25), section("drop", 48, 80, 0.9)],
      80,
    );
    const window = planPhraseWindow(outgoing, incoming);
    expect(window.barCount).toBeGreaterThanOrEqual(16);
    expect(window.exitKind).toBe("dropLanding");
    expect(window.phraseShape).toBe("landing");
    expect(Math.abs(landingErrorMs(window, 1, window.barCount * BAR_MS)!)).toBeLessThan(2);
  });

  it("prefers a 32-bar drop landing to a quiet-tail duck when the opening build exists", () => {
    const outgoing = track(
      "out",
      [section("drop", 16, 48, 0.9), section("outro", 48, 72, 0.2)],
      72,
    );
    const incoming = track(
      "in",
      [section("intro", 0, 16, 0.15), section("build", 16, 48, 0.2), section("drop", 48, 80, 0.85)],
      80,
    );
    const window = planPhraseWindow(outgoing, incoming);
    expect(window.exitKind).toBe("dropLanding");
    expect(window.barCount).toBe(32);
    expect(window.mixInBar).toBe(16);
    expect(window.phraseShape).toBe("landing");
  });

  it("uses B=8 when the incoming drop is at bar 8", () => {
    const outgoing = track(
      "out",
      [section("drop", 16, 48, 0.4), section("outro", 48, 64, 0.2)],
      64,
    );
    const incoming = track("in", [section("intro", 0, 8, 0.2), section("drop", 8, 48, 0.85)], 48);
    const window = planPhraseWindow(outgoing, incoming);
    expect(window.barCount).toBe(8);
    expect(window.mixInBar).toBe(0);
    expect(window.mixInMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps incoming kit arriving two bars before outgoing mids drop on a sequential curve", () => {
    const curve = expandPreset("phrase_mix", { phraseShape: "sequential" }, 16, BAR_MS);
    const incomingMid = curve.find((ev) => ev.target === "incoming_mid");
    const outgoingMid = curve.find((ev) => ev.target === "outgoing_mid");
    expect((outgoingMid?.durationBars ?? 0) - (incomingMid?.atBar ?? 99)).toBe(2);
  });

  it("does not cut a kit-on join to 8 bars when 16 is feasible", () => {
    const outgoing = track(
      "out",
      [section("drop", 16, 48, 0.9), section("outro", 48, 72, 0.45)],
      72,
    );
    const incoming = track(
      "in",
      [section("intro", 0, 16, 0.2), section("build", 16, 48, 0.7), section("drop", 48, 80, 0.9)],
      80,
    );
    const window = planPhraseWindow(outgoing, incoming);
    expect(window.barCount).toBeGreaterThanOrEqual(16);
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
    const window = planPhraseWindow(outgoing, incoming);
    expect(window.barCount).toBeGreaterThanOrEqual(16);
    expect(window.mixInMs).toBeCloseTo(Math.round((48 - window.barCount) * BAR_MS) + phase, 0);
    expect(window.incomingDropMs).toBeCloseTo(window.mixInMs + window.barCount * BAR_MS, 0);
    // Solving from the actual drop already incorporates its phase; no second nudge is needed.
    expect(window.alignmentOffsetMs).toBeCloseTo(0, 0);
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
      onsetLockBeats: null,
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

  it("moves mix-out by one beat when incoming kicks sit on the outgoing snare", () => {
    const outgoing = track("out", [section("drop", 16, 80, 0.9)], 80);
    const incoming = track("in", [section("intro", 0, 16, 0.2), section("drop", 16, 64, 0.9)], 64);
    const drum = (lengthBars: number, kickShift: number) => {
      const beats = lengthBars * 4;
      const beatKick: number[] = [];
      const beatSnare: number[] = [];
      for (let i = 0; i < beats; i += 1) {
        const pos = (((i - kickShift) % 4) + 4) % 4;
        beatKick.push(pos === 0 ? 1 : 0.02);
        beatSnare.push(pos === 2 ? 1 : 0.05);
      }
      return {
        rms: Array(lengthBars).fill(0.8),
        beatKick,
        beatSnare,
        beatOnset: beatKick.map((value, i) => value + (beatSnare[i] ?? 0)),
      };
    };
    outgoing.analysis!.bars = drum(80, 0);
    incoming.analysis!.bars = drum(64, 1);
    const base: PhraseWindow = {
      mixInMs: 0,
      mixOutMs: Math.round(32 * BAR_MS),
      mixInBar: 0,
      mixOutBar: 32,
      barCount: 16,
      exitKind: "dropLanding",
      phraseShape: "landing",
      incomingDropMs: Math.round(16 * BAR_MS),
      dropAnchored: true,
      alignmentOffsetMs: 0,
      alignmentPeriodMs: null,
      alignmentMode: null,
      onsetLockBeats: null,
    };
    const baked = bakeWindowAlignment(outgoing, incoming, base);
    expect(baked.mixInMs).toBe(0);
    expect(baked.alignmentMode).toBe("bar");
    expect(Math.abs(baked.alignmentOffsetMs - BAR_MS / 4)).toBeLessThan(5);
    expect(base.mixOutMs - baked.mixOutMs).toBeCloseTo(BAR_MS / 4, 0);
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

  it("re-solves a drop-anchored mix-in when a key-clash overlap is shortened to 8 bars", () => {
    const outgoing = track("out", [section("drop", 16, 80, 0.9)], 80);
    const incoming = track(
      "in",
      [section("intro", 0, 16, 0.2), section("build", 16, 48, 0.25), section("drop", 48, 80, 0.9)],
      80,
    );
    const long = planPhraseWindow(outgoing, incoming);
    const short = planPhraseWindow(outgoing, incoming, { maxBars: 8 });
    expect(long.barCount).toBeGreaterThanOrEqual(16);
    expect(short.barCount).toBe(8);
    expect(short.mixInBar).toBe(40);
    const overlap = short.barCount * BAR_MS;
    expect(landingErrorMs(short, 1, overlap)).toBeCloseTo(0, 0);
    expect(Math.abs(landingErrorMs(short, 1, overlap)!)).toBeLessThanOrEqual(10);
  });

  it("keeps drop landing within 10 ms at a non-unity incoming rate", () => {
    const outgoing = track("out", [section("drop", 16, 80, 0.9)], 80);
    const incoming = track(
      "in",
      [section("intro", 0, 16, 0.2), section("build", 16, 48, 0.25), section("drop", 48, 80, 0.9)],
      80,
    );
    const rate = 1.02;
    const window = planPhraseWindow(outgoing, incoming, { incomingRate: rate, targetBpm: BPM });
    const overlap = window.barCount * BAR_MS;
    expect(Math.abs(landingErrorMs(window, rate, overlap)!)).toBeLessThanOrEqual(10);
  });

  it("honors a manual incoming mix-in instead of the drop-anchored start", () => {
    const outgoing = track("out", [section("drop", 16, 80, 0.9)], 80);
    const incoming = track(
      "in",
      [section("intro", 0, 16, 0.2), section("build", 16, 48, 0.25), section("drop", 48, 80, 0.9)],
      80,
    );
    incoming.analysis!.manualMixInMs = 12_000;
    const window = planPhraseWindow(outgoing, incoming);
    expect(window.mixInMs).toBe(12_000);
  });

  it("does not auto-shorten a kit-on drop landing to 8 bars", () => {
    const outgoing = track("out", [section("drop", 16, 80, 0.9)], 80);
    const incoming = track(
      "in",
      [section("intro", 0, 16, 0.2), section("build", 16, 48, 0.7), section("drop", 48, 80, 0.9)],
      80,
    );
    const window = planPhraseWindow(outgoing, incoming);
    expect(window.exitKind).toBe("dropLanding");
    expect(window.phraseShape).toBe("landing");
    expect(window.barCount).toBeGreaterThanOrEqual(16);
  });
});

describe("onset-lock composition", () => {
  const BEAT_MS = BAR_MS / 4;

  function drumTrack(
    id: string,
    options: { phaseBeats?: number; patternShift?: number; gridOffsetMs?: number } = {},
  ): WindowTrack {
    const phase = options.phaseBeats ?? 0;
    const pattern = options.patternShift ?? 0;
    const gridOffset = options.gridOffsetMs ?? 0;
    const beats = 160;
    const beatTimesMs = Array.from({ length: beats }, (_, i) => gridOffset + i * BEAT_MS);
    const downbeatTimesMs = beatTimesMs.filter((_, i) => (i - phase) % 4 === 0);
    const pos = (i: number): number => (((i - pattern) % 4) + 4) % 4;
    const totalBars = Math.floor((beats - phase) / 4);
    return {
      id,
      durationMs: gridOffset + beats * BEAT_MS,
      bpm: BPM,
      analysis: {
        sections: [],
        canonicalBpm: BPM,
        audioStartMs: 0,
        audioEndMs: gridOffset + beats * BEAT_MS,
        beatTimesMs,
        downbeatTimesMs,
        downbeatConfidence: 1,
        bars: {
          rms: new Array<number>(totalBars).fill(0.7),
          beatKick: beatTimesMs.map((_, i) => (pos(i) === 0 ? 1 : 0.02)),
          beatSnare: beatTimesMs.map((_, i) => (pos(i) === 2 ? 1 : 0.05)),
          beatOnset: beatTimesMs.map((_, i) => (pos(i) === 0 || pos(i) === 2 ? 1 : 0.05)),
        },
      },
    };
  }

  function dropWindow(outMixOutMs: number, inMixInMs: number): PhraseWindow {
    return {
      mixInMs: Math.round(inMixInMs),
      mixOutMs: Math.round(outMixOutMs),
      mixInBar: 8,
      mixOutBar: 8,
      barCount: 16,
      exitKind: "dropLanding",
      phraseShape: "sequential",
      incomingDropMs: null,
      dropAnchored: true,
      alignmentOffsetMs: 0,
      alignmentPeriodMs: null,
      alignmentMode: null,
      onsetLockBeats: null,
    };
  }

  const downbeat = (t: WindowTrack, index: number): number =>
    t.analysis?.downbeatTimesMs?.[index] ?? 0;

  describe("breakdown entry", () => {
    const entryTrack = (onset: number[]): WindowTrack => ({
      id: "in",
      durationMs: Math.round(120 * BAR_MS),
      bpm: BPM,
      analysis: {
        sections: [],
        canonicalBpm: BPM,
        audioStartMs: 0,
        audioEndMs: Math.round(120 * BAR_MS),
        downbeatTimesMs: Array.from({ length: 121 }, (_, i) => Math.round(i * BAR_MS)),
        downbeatConfidence: 1,
        bars: { rms: new Array<number>(120).fill(0.3), onsetDensity: onset },
      },
    });

    it("admits a drum exit: one grooving bar then air", () => {
      const onset = new Array<number>(120).fill(0.05);
      onset[48] = 0.4;
      expect(breakdownEntry(entryTrack(onset), 48)).toBe(true);
    });

    it("rejects a sustained groove", () => {
      expect(breakdownEntry(entryTrack(new Array<number>(120).fill(0.4)), 48)).toBe(false);
    });

    it("rejects a dead bar and missing bars", () => {
      const onset = new Array<number>(120).fill(0.05);
      expect(breakdownEntry(entryTrack(onset), 48)).toBe(false);
      expect(breakdownEntry({ id: "x", durationMs: 1000, bpm: BPM, analysis: null }, 48)).toBe(
        false,
      );
    });
  });

  describe("late-drop 32-bar breakdown landing", () => {
    // Mirrors a real liquid build: late drop, quiet-labeled build, drums that
    // stop ~30 bars before the drop. The blend should open at the drum exit.
    function buildIncoming(): WindowTrack {
      const dropBar = 80;
      const totalBars = 100;
      const onset = new Array<number>(totalBars).fill(0.05);
      onset[48] = 0.4;
      onset[49] = 0.3;
      const beat = BAR_MS / 4;
      const totalBeats = totalBars * 4;
      const section = (
        type: TrackSection["type"],
        startBar: number,
        endBar: number,
        sectionEnergy: number,
      ): TrackSection => ({
        type,
        startMs: Math.round(startBar * BAR_MS),
        endMs: Math.round(endBar * BAR_MS),
        startBar,
        endBar,
        confidence: 0.8,
        sectionEnergy,
      });
      return {
        id: "in",
        durationMs: Math.round(totalBars * BAR_MS),
        bpm: BPM,
        analysis: {
          sections: [
            section("intro", 0, 16, 0.1),
            section("build", 16, dropBar, 0.15),
            section("drop", dropBar, totalBars, 0.9),
          ],
          canonicalBpm: BPM,
          audioStartMs: 0,
          audioEndMs: Math.round(totalBars * BAR_MS),
          beatTimesMs: Array.from({ length: totalBeats }, (_, i) => i * beat),
          downbeatTimesMs: Array.from({ length: totalBars + 1 }, (_, i) => i * BAR_MS),
          downbeatConfidence: 1,
          bars: {
            rms: new Array<number>(totalBars).fill(0.2),
            onsetDensity: onset,
          },
        },
      };
    }

    function buildOutgoing(): WindowTrack {
      const totalBars = 200;
      const beat = BAR_MS / 4;
      const totalBeats = totalBars * 4;
      const bar = (n: number): number => Math.round(n * BAR_MS);
      return {
        id: "out",
        durationMs: bar(totalBars),
        bpm: BPM,
        analysis: {
          sections: [
            {
              type: "drop",
              startMs: bar(16),
              endMs: bar(180),
              startBar: 16,
              endBar: 180,
              confidence: 0.8,
              sectionEnergy: 0.9,
            },
          ],
          canonicalBpm: BPM,
          audioStartMs: 0,
          audioEndMs: bar(totalBars),
          beatTimesMs: Array.from({ length: totalBeats }, (_, i) => i * beat),
          downbeatTimesMs: Array.from({ length: totalBars + 1 }, (_, i) => i * BAR_MS),
          downbeatConfidence: 1,
          bars: {
            rms: new Array<number>(totalBars).fill(0.7),
            onsetDensity: new Array<number>(totalBars).fill(0.4),
          },
        },
      };
    }

    it("takes 32 bars from the drum exit instead of 16 from dead air", () => {
      const window = planPhraseWindow(buildOutgoing(), buildIncoming());
      expect(window.barCount).toBe(32);
      expect(window.mixInBar).toBe(48);
    });
  });

  it("leaves an already drum-aligned join alone when grids carry a downbeat phase", () => {
    // Same absolute grid; the incoming tracker started two beats before the
    // first downbeat. Drums sit on labeled downbeats on both decks, so the
    // overlap content already coincides. An unanchored lock reads the wrong
    // slice and invents a +2-beat slip (+690 ms) that ruins the join.
    const outgoing = drumTrack("out");
    const incoming = drumTrack("in", { phaseBeats: 2, patternShift: 2 });
    const base = dropWindow(downbeat(outgoing, 8), downbeat(incoming, 8));
    const baked = bakeWindowAlignment(outgoing, incoming, base, { targetBpm: BPM });
    expect(baked.alignmentOffsetMs).toBeCloseTo(0, 5);
    expect(baked.mixOutMs).toBe(base.mixOutMs);
    expect(baked.mixInMs).toBe(base.mixInMs);
  });

  it("slips two beats when the drums sit off the labeled downbeats", () => {
    // Same absolute grid, but the incoming kicks sit two beats before its
    // labeled downbeats. The drum evidence must overrule the labels.
    const outgoing = drumTrack("out");
    const incoming = drumTrack("in", { phaseBeats: 2, patternShift: 0 });
    const base = dropWindow(downbeat(outgoing, 8), downbeat(incoming, 8));
    const baked = bakeWindowAlignment(outgoing, incoming, base, { targetBpm: BPM });
    expect(baked.alignmentOffsetMs).toBe(Math.round(-2 * BEAT_MS));
    // Drop-anchored: the outgoing mix-out moves, the incoming drop stays put.
    expect(baked.mixInMs).toBe(base.mixInMs);
    expect(baked.mixOutMs).toBe(base.mixOutMs + Math.round(2 * BEAT_MS));
  });

  it("adds the sub-beat residual on top of a whole-beat drum slip", () => {
    // One-beat kick/snare swap plus a 37 ms grid offset with the mix-in placed
    // off the incoming grid. The lock used to discard the 37 ms entirely.
    const outgoing = drumTrack("out");
    const incoming = drumTrack("in", { patternShift: 1, gridOffsetMs: 37 });
    const base = dropWindow(downbeat(outgoing, 8), downbeat(incoming, 8) - 37);
    const baked = bakeWindowAlignment(outgoing, incoming, base, { targetBpm: BPM });
    expect(baked.alignmentOffsetMs).toBe(Math.round(BEAT_MS + 37));
  });
});
