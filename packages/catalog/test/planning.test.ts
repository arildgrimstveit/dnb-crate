import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCatalogRuntime } from "../src/index.ts";
import type { AppConfig } from "@dnb-crate/domain";
import { analysisToTimeline, buildEntries, chooseTransition, type TimelineTrack } from "../src/planning/timeline.ts";
import { planTransition } from "../src/planning/transition-planner.ts";

function testConfig(root: string): AppConfig {
  return {
    databasePath: path.join(root, "catalog.sqlite"),
    libraryRoots: [path.join(root, "library")],
    outputRoot: path.join(root, "output"),
    logLevel: "error",
    supportedExtensions: [".wav", ".flac", ".mp3", ".m4a", ".aiff", ".aif"],
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function runtime() {
  const root = path.join(
    os.tmpdir(),
    `dnb-plan-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const created = createCatalogRuntime(testConfig(root));
  cleanups.push(() => created.close());
  return created;
}

function seedTrack(
  catalog: ReturnType<typeof runtime>,
  spec: {
    title: string;
    artist: string;
    bpm: number;
    camelot: string;
    energy: number;
    moods?: string[];
    rating?: number;
    durationMs?: number;
  },
): string {
  const id = crypto.randomUUID();
  const key = spec.camelot.endsWith("A") ? "xmin" : "X";
  catalog.repository.upsertFromScan({
    id,
    filePath: path.join("C:", "virtual", `${spec.title}.wav`),
    fileFingerprint: spec.title,
    artist: spec.artist,
    title: spec.title,
    album: null,
    durationMs: spec.durationMs ?? 150_000,
    sampleRateHz: 44100,
    channels: 2,
    bpm: spec.bpm,
    bpmSource: "manual",
    musicalKey: key,
    camelotKey: spec.camelot,
    keySource: "manual",
  });
  catalog.service.updateTrackMetadata(id, {
    energy: spec.energy,
    rating: spec.rating ?? 4,
    moods: spec.moods ?? ["liquid"],
    subgenres: ["liquid"],
  });
  return id;
}

describe("set planning", () => {
  it("builds a deterministic plan that honors start, end, and seed", () => {
    const catalog = runtime();
    const start = seedTrack(catalog, {
      title: "Opener",
      artist: "Alpha",
      bpm: 172,
      camelot: "8A",
      energy: 3,
    });
    seedTrack(catalog, { title: "Warm", artist: "Bravo", bpm: 173, camelot: "9A", energy: 5 });
    seedTrack(catalog, { title: "Peak", artist: "Charlie", bpm: 174, camelot: "10A", energy: 9 });
    seedTrack(catalog, { title: "Groove", artist: "Delta", bpm: 174, camelot: "11A", energy: 8 });
    const ending = seedTrack(catalog, {
      title: "The Nightfall",
      artist: "Technimatic",
      bpm: 174,
      camelot: "11A",
      energy: 6,
    });

    const first = catalog.service.createSetPlan({
      name: "Liquid hour",
      targetDurationMs: 600_000,
      startTrackId: start,
      endTrackId: ending,
      preferredMoods: ["liquid"],
      artistRepeatSpacing: 1,
      seed: 1,
    });
    const second = catalog.service.createSetPlan({
      name: "Liquid hour again",
      targetDurationMs: 600_000,
      startTrackId: start,
      endTrackId: ending,
      preferredMoods: ["liquid"],
      artistRepeatSpacing: 1,
      seed: 1,
    });

    expect(first.plan.entries[0]?.trackId).toBe(start);
    expect(first.plan.entries.at(-1)?.trackId).toBe(ending);
    expect(first.plan.schemaVersion).toBe(1);
    expect(second.plan.entries.map((entry) => entry.trackId)).toEqual(
      first.plan.entries.map((entry) => entry.trackId),
    );
    expect(first.explanation.selected.length).toBe(first.plan.entries.length);
    expect(first.validation.diagnostics.energyByEntry.length).toBe(first.plan.entries.length);
  });

  it("returns a partial plan when the library cannot fill an hour", () => {
    const catalog = runtime();
    seedTrack(catalog, { title: "Only", artist: "Solo", bpm: 174, camelot: "11A", energy: 5 });
    const created = catalog.service.createSetPlan({
      name: "Too small",
      targetDurationMs: 3_600_000,
      seed: 1,
    });
    expect(created.partial).toBe(true);
    expect(created.plan.entries.length).toBeGreaterThan(0);
    expect(created.validation.warnings.some((issue) => issue.code === "DURATION_OFF_TARGET")).toBe(
      true,
    );
  });

  it("does not invent cue points and keeps manual BPM across a metadata update", () => {
    const catalog = runtime();
    const id = seedTrack(catalog, {
      title: "Cue Me",
      artist: "Echo",
      bpm: 174,
      camelot: "11A",
      energy: 5,
    });
    const cues = catalog.service.setCuePoints(id, [
      { type: "drop", positionMs: 32_000, label: "drop" },
    ]);
    expect(cues.cuePoints).toHaveLength(1);
    expect(cues.cuePoints[0]?.source).toBe("manual");
    const updated = catalog.service.updateTrackMetadata(id, { bpm: 175 });
    expect(updated.bpm).toBe(175);
    expect(updated.bpmSource).toBe("manual");
    const detail = catalog.service.getTrack(id);
    expect(detail.cuePoints).toHaveLength(1);
    const created = catalog.service.createSetPlan({
      name: "cues",
      targetDurationMs: 150_000,
      seed: 2,
    });
    expect(created.plan.entries[0]?.transitionToNext?.outgoingCuePointId ?? null).toBeNull();
  });

  it("validates duplicates, unknown tracks, and artist spacing warnings", async () => {
    const catalog = runtime();
    const a = seedTrack(catalog, {
      title: "One",
      artist: "Same",
      bpm: 174,
      camelot: "11A",
      energy: 5,
    });
    const b = seedTrack(catalog, {
      title: "Two",
      artist: "Same",
      bpm: 186,
      camelot: "5A",
      energy: 9,
    });
    const created = catalog.service.createSetPlan({
      name: "clashy",
      targetDurationMs: 300_000,
      startTrackId: a,
      endTrackId: b,
      artistRepeatSpacing: 1,
      seed: 1,
    });
    const validation = await catalog.service.validateSavedSetPlan(created.plan.id);
    expect(validation.warnings.some((issue) => issue.code === "ARTIST_REPEAT")).toBe(true);
    expect(validation.warnings.some((issue) => issue.code === "BPM_JUMP")).toBe(true);
    expect(validation.warnings.some((issue) => issue.code === "KEY_CLASH")).toBe(true);
  });

  it("updates, lists, and deletes a plan with confirm", () => {
    const catalog = runtime();
    const a = seedTrack(catalog, {
      title: "Left",
      artist: "A",
      bpm: 174,
      camelot: "11A",
      energy: 4,
    });
    const b = seedTrack(catalog, {
      title: "Right",
      artist: "B",
      bpm: 174,
      camelot: "12A",
      energy: 5,
    });
    const created = catalog.service.createSetPlan({
      name: "Draft",
      targetDurationMs: 300_000,
      startTrackId: a,
      endTrackId: b,
      seed: 3,
    });
    const renamed = catalog.service.updateSetPlan({ setPlanId: created.plan.id, name: "Final" });
    expect(renamed.plan.name).toBe("Final");
    const listed = catalog.service.listSetPlans();
    expect(listed.plans.some((plan) => plan.id === created.plan.id)).toBe(true);
    const deleted = catalog.service.deleteSetPlan(created.plan.id, true);
    expect(deleted.deleted).toBe(true);
    expect(() => catalog.service.getSetPlan(created.plan.id)).toThrow();
  });

  it("ranks compatible neighbours above distant keys", () => {
    const catalog = runtime();
    const source = seedTrack(catalog, {
      title: "Source",
      artist: "X",
      bpm: 174,
      camelot: "11A",
      energy: 6,
    });
    const near = seedTrack(catalog, {
      title: "Near",
      artist: "Y",
      bpm: 174,
      camelot: "12A",
      energy: 7,
    });
    seedTrack(catalog, { title: "Far", artist: "Z", bpm: 160, camelot: "5A", energy: 2 });
    const ranked = catalog.service.findCompatibleTracks({ sourceTrackId: source, direction: "up" });
    expect(ranked.candidates[0]?.track.id).toBe(near);
  });
});

describe("planner tempo matching", () => {
  function gridTrack(
    bpm: number,
    energy = 5,
  ): TimelineTrack {
    return {
      id: crypto.randomUUID(),
      durationMs: 180_000,
      energy,
      bpm,
      analysis: {
        gridOk: true,
        bpm,
        canonicalBpm: bpm,
        suggestedEnergy: energy,
        introStartMs: 0,
        outroStartMs: 140_000,
        outroEndMs: 180_000,
        introLenMs: 30_000,
        outroLenMs: 40_000,
      },
    };
  }

  it("tempo-matches 174/176 onto 175", () => {
    const a = gridTrack(174, 4);
    const b = gridTrack(176, 9);
    const chosen = chooseTransition(a, b);
    expect(["bass_swap", "phrase_mix"]).toContain(chosen.transition.type);
    expect(chosen.targetBpm).toBe(175);
    expect(chosen.transition.parameters.targetBpm).toBe(175);
    expect(chosen.incomingRate).toBeCloseTo(175 / 176, 5);
    expect(chosen.outgoingRate).toBeCloseTo(175 / 174, 5);
    expect(Math.abs(chosen.incomingRate - 1)).toBeLessThanOrEqual(0.03);
    expect(Math.abs(chosen.outgoingRate - 1)).toBeLessThanOrEqual(0.03);
    const entries = buildEntries([a, b]);
    expect(entries[0]?.playbackRate).toBeCloseTo(175 / 174, 5);
    expect(entries[1]?.playbackRate).toBeCloseTo(175 / 176, 5);
  });

  it("falls back to crossfade when 174/182 cannot lock within 3%", () => {
    const chosen = chooseTransition(gridTrack(174), gridTrack(182));
    expect(chosen.transition.type).toBe("crossfade");
    expect(chosen.outgoingRate).toBe(1);
    expect(chosen.incomingRate).toBe(1);
    expect(chosen.transition.parameters.reason).toBe("tempo-out-of-range");
  });

  it("keeps a 174/175/176 chain monotone and within 3%", () => {
    const entries = buildEntries([gridTrack(174), gridTrack(175), gridTrack(176)]);
    const rates = entries.map((entry) => entry.playbackRate);
    expect(rates[0]!).toBeGreaterThanOrEqual(rates[1]!);
    expect(rates[1]!).toBeGreaterThanOrEqual(rates[2]!);
    const canons = [174, 175, 176];
    for (let i = 0; i < rates.length; i += 1) {
      expect(Math.abs(rates[i]! - 1)).toBeLessThanOrEqual(0.03);
      const effective = canons[i]! * rates[i]!;
      expect(Math.abs(effective / canons[i]! - 1)).toBeLessThanOrEqual(0.03);
    }
  });

  it("preserves a manual playbackRate on re-plan", () => {
    const a = gridTrack(174);
    const b = gridTrack(176);
    const first = buildEntries([a, b]);
    expect(first[0]?.playbackRate).not.toBe(1);
    const prior = new Map([
      [a.id, { ...first[0]!, playbackRate: 1.01 }],
      [b.id, first[1]!],
    ]);
    const again = buildEntries([a, b], undefined, prior);
    expect(again[0]?.playbackRate).toBe(1.01);
  });

  it("copies canonicalBpm into the timeline view", () => {
    const timeline = analysisToTimeline(
      {
        gridRejected: false,
        bpm: 174.2,
        bpmConfidence: 0.8,
        descriptors: { suggestedEnergy: 7 },
        sections: [
          { type: "intro", startMs: 0, endMs: 20_000 },
          { type: "outro", startMs: 140_000, endMs: 180_000 },
        ],
      },
      174,
    );
    expect(timeline?.canonicalBpm).toBe(174);
    expect(timeline?.introLenMs).toBe(20_000);
    expect(timeline?.outroLenMs).toBe(40_000);
    expect(timeline?.gridOk).toBe(true);
  });
});

describe("analyzed cue provenance", () => {
  it("treats analyzer cues as reasons, not blockers, and never mixes out before the drop", () => {
    const outgoing = {
      track: {
        id: "out",
        filePath: "out.wav",
        fileFingerprint: "out",
        artist: "A",
        title: "Out",
        album: null,
        durationMs: 180_000,
        sampleRateHz: 44100,
        channels: 2,
        bpm: 174,
        bpmSource: "manual" as const,
        musicalKey: "Fm",
        camelotKey: "4A",
        keySource: "manual" as const,
        energy: 5,
        rating: 4,
        subgenres: [],
        moods: [],
        tags: [],
        notes: null,
        analysisStatus: "complete" as const,
        fileMissing: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      analysis: {
        trackId: "out",
        analyzerName: "dnb-crate-dsp",
        analyzerVersion: "2.1.0",
        bpm: 174,
        bpmConfidence: 0.8,
        bpmRaw: 174,
        beatTimesMs: [0, 345, 689],
        downbeatTimesMs: [0, 1379],
        gridRejected: false,
        gridRejectionReason: null,
        musicalKey: "Fm",
        keyConfidence: 0.7,
        keyMode: "minor" as const,
        camelotKey: "4A",
        tempoStability: 0.8,
        downbeatConfidence: 0.7,
        integratedLufs: null,
        truePeakDb: null,
        lowBandEnergy: null,
        midBandEnergy: null,
        highBandEnergy: null,
        waveformSummary: null,
        beatAnchorMs: null,
        descriptors: null,
        engineRuntimeMs: 1,
        analyzedAt: new Date().toISOString(),
        suggestedCues: [],
        sections: [
          { type: "intro" as const, startMs: 0, endMs: 20_000, startBar: 0, endBar: 8, confidence: 0.6, sectionEnergy: 0.4 },
          { type: "drop" as const, startMs: 20_000, endMs: 80_000, startBar: 8, endBar: 32, confidence: 0.8, sectionEnergy: 0.9 },
          { type: "outro" as const, startMs: 140_000, endMs: 180_000, startBar: 56, endBar: 72, confidence: 0.62, sectionEnergy: 0.3 },
        ],
      },
      cues: [
        {
          id: "c1",
          trackId: "out",
          type: "outro_start" as const,
          positionMs: 140_000,
          beatIndex: null,
          barIndex: 56,
          confidence: 0.62,
          source: "analyzed" as const,
          label: null,
        },
      ],
    };
    const incoming = {
      ...outgoing,
      track: { ...outgoing.track, id: "in", title: "In", fileFingerprint: "in" },
      analysis: {
        ...outgoing.analysis,
        trackId: "in",
        sections: [
          { type: "intro" as const, startMs: 0, endMs: 16_000, startBar: 0, endBar: 8, confidence: 0.55, sectionEnergy: 0.3 },
          { type: "drop" as const, startMs: 16_000, endMs: 80_000, startBar: 8, endBar: 32, confidence: 0.8, sectionEnergy: 0.9 },
        ],
      },
      cues: [
        {
          id: "c2",
          trackId: "in",
          type: "intro_start" as const,
          positionMs: 0,
          beatIndex: null,
          barIndex: 0,
          confidence: 0.55,
          source: "analyzed" as const,
          label: null,
        },
      ],
    };
    const planned = planTransition(outgoing, incoming, {
      outgoingTrackId: "out",
      incomingTrackId: "in",
      preferredType: "phrase_mix",
    });
    const proposal = planned.proposals[0]!;
    expect(proposal.feasible).toBe(true);
    expect(proposal.blockers).toHaveLength(0);
    expect(proposal.reasons.some((reason) => /analyzer-derived/i.test(reason))).toBe(true);
    expect(proposal.outgoingSourceEndMs).toBeGreaterThanOrEqual(80_000);
  });

  it("does not add a reason when the outro cue is manual", () => {
    const base = {
      track: {
        id: "out",
        filePath: "out.wav",
        fileFingerprint: "out",
        artist: "A",
        title: "Out",
        album: null,
        durationMs: 180_000,
        sampleRateHz: 44100,
        channels: 2,
        bpm: 174,
        bpmSource: "manual" as const,
        musicalKey: "Fm",
        camelotKey: "4A",
        keySource: "manual" as const,
        energy: 5,
        rating: 4,
        subgenres: [],
        moods: [],
        tags: [],
        notes: null,
        analysisStatus: "complete" as const,
        fileMissing: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      analysis: null,
      cues: [
        {
          id: "manual-outro",
          trackId: "out",
          type: "outro_start" as const,
          positionMs: 150_000,
          beatIndex: null,
          barIndex: null,
          confidence: 1,
          source: "manual" as const,
          label: null,
        },
      ],
    };
    const incoming = {
      ...base,
      track: { ...base.track, id: "in", title: "In", fileFingerprint: "in" },
      cues: [],
    };
    const planned = planTransition(base, incoming, {
      outgoingTrackId: "out",
      incomingTrackId: "in",
      preferredType: "crossfade",
    });
    const proposal = planned.proposals.find((item) => item.type === "crossfade")!;
    expect(proposal.reasons.some((reason) => /analyzer-derived/i.test(reason))).toBe(false);
  });
});

