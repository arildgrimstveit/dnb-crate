import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCatalogRuntime } from "../src/index.ts";
import { DSP_ANALYZER_NAME, type AppConfig, type SonicDescriptors } from "@dnb-crate/domain";
import { validateSetPlan } from "../src/planning/validate.ts";
import { analysisToTimeline, buildEntries, chooseTransition, type TimelineAnalysis, type TimelineTrack } from "../src/planning/timeline.ts";
import { planTransition } from "../src/planning/transition-planner.ts";
import type { SetPlanV1, Track, TrackSection } from "@dnb-crate/domain";

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
    bpm?: number | null;
    camelot: string;
    energy?: number | null;
    moods?: string[];
    genres?: string[];
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
    bpm: spec.bpm ?? null,
    bpmSource: spec.bpm == null ? null : "manual",
    musicalKey: key,
    camelotKey: spec.camelot,
    keySource: "manual",
  });
  catalog.service.updateTrackMetadata(id, {
    energy: spec.energy === undefined ? 5 : spec.energy,
    rating: spec.rating ?? 4,
    moods: spec.moods ?? ["liquid"],
    subgenres: spec.genres ? [] : ["liquid"],
    genres: spec.genres,
  });
  return id;
}

function stubDescriptors(
  catalog: ReturnType<typeof runtime>,
  trackId: string,
  descriptors: Partial<SonicDescriptors> & { energy?: number | null },
  options: { gridRejected?: boolean; bpm?: number | null; bpmRaw?: number | null; bpmConfidence?: number | null } = {},
): void {
  catalog.analyses.upsert({
    trackId,
    analyzerName: DSP_ANALYZER_NAME,
    analyzerVersion: "3.0.0",
    bpm: options.bpm ?? 174,
    bpmConfidence: options.bpmConfidence ?? 0.8,
    bpmRaw: options.bpmRaw ?? options.bpm ?? 174,
    referenceBpm: null,
    beatTimesMs: [],
    downbeatTimesMs: [],
    gridRejected: options.gridRejected ?? false,
    gridRejectionReason: options.gridRejected ? "low confidence" : null,
    gridSource: "analyzed",
    musicalKey: null,
    keyConfidence: null,
    keyMode: null,
    camelotKey: null,
    tempoStability: null,
    downbeatConfidence: null,
    integratedLufs: null,
    truePeakDb: null,
    lowBandEnergy: null,
    midBandEnergy: null,
    highBandEnergy: null,
    waveformSummary: null,
    beatAnchorMs: null,
    descriptors: {
      integratedLufs: null,
      shortTermLufsMean: null,
      shortTermLufsMax: null,
      truePeakDb: null,
      subBassRatio: descriptors.subBassRatio ?? 0.5,
      brightness: descriptors.brightness ?? 0.1,
      onsetDensity: null,
      dynamicRange: null,
      dropIntensity: null,
      suggestedEnergy: descriptors.suggestedEnergy ?? (descriptors.energy != null ? Math.round(1 + 9 * descriptors.energy) : 6),
      energy: descriptors.energy ?? null,
      danceability: descriptors.danceability ?? null,
      acousticness: descriptors.acousticness ?? null,
      melodicness: descriptors.melodicness ?? null,
      valence: descriptors.valence ?? null,
      waveformSummary: [],
      lowBandEnergy: null,
      midBandEnergy: null,
      highBandEnergy: null,
      chromaVector: null,
      tempoEvidence: null,
    },
    engineRuntimeMs: 1,
    analyzedAt: new Date().toISOString(),
    suggestedCues: [],
    sections: [],
  });
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

  it("clones a plan and optionally replans entries", () => {
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
      bpm: 176,
      camelot: "12A",
      energy: 8,
    });
    const created = catalog.service.createSetPlan({
      name: "Original",
      targetDurationMs: 300_000,
      startTrackId: a,
      endTrackId: b,
      seed: 3,
    });
    const copied = catalog.service.cloneSetPlan({
      setPlanId: created.plan.id,
      name: "Copy",
    });
    expect(copied.plan.id).not.toBe(created.plan.id);
    expect(copied.plan.name).toBe("Copy");
    expect(copied.plan.entries.map((entry) => entry.trackId)).toEqual(
      created.plan.entries.map((entry) => entry.trackId),
    );
    expect(copied.plan.entries[0]?.playbackRate).toBe(created.plan.entries[0]?.playbackRate);
    const replanned = catalog.service.cloneSetPlan({
      setPlanId: created.plan.id,
      name: "Replan",
      replan: true,
    });
    expect(replanned.plan.id).not.toBe(created.plan.id);
    expect(replanned.plan.entries.map((entry) => entry.trackId)).toEqual(
      created.plan.entries.map((entry) => entry.trackId),
    );
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
    extra: Partial<TimelineAnalysis> = {},
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
        bpmHint: null,
        bpmHintConfidence: null,
        suggestedEnergy: energy,
        introStartMs: 0,
        outroStartMs: 140_000,
        outroEndMs: 180_000,
        introLenMs: 30_000,
        outroLenMs: 40_000,
        sections: [],
        downbeatTimesMs: [],
        audioStartMs: 0,
        audioEndMs: 180_000,
        mixInMs: 0,
        mixOutMs: 140_000,
        headEnergy: 0.3,
        tailEnergy: 0.4,
        ...extra,
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

  it("falls back to an 8s crossfade when 174/182 cannot lock within 3%", () => {
    const chosen = chooseTransition(gridTrack(174), gridTrack(182));
    expect(chosen.transition.type).toBe("crossfade");
    expect(chosen.outgoingRate).toBe(1);
    expect(chosen.incomingRate).toBe(1);
    expect(chosen.transition.parameters.reason).toBe("tempo-out-of-range");
    expect(chosen.transition.durationMs).toBe(8_000);
  });

  it("uses an 8s crossfade for a 125/174 pair", () => {
    const chosen = chooseTransition(gridTrack(125), gridTrack(174));
    expect(chosen.transition.type).toBe("crossfade");
    expect(chosen.transition.durationMs).toBe(8_000);
    expect(chosen.transition.parameters.reason).toBe("tempo-out-of-range");
  });

  it("uses an 8s crossfade when grids are missing and tempos disagree", () => {
    const outgoing = gridTrack(125, 5, { gridOk: false });
    const incoming = gridTrack(174, 5, { gridOk: false });
    const chosen = chooseTransition(outgoing, incoming);
    expect(chosen.transition.type).toBe("crossfade");
    expect(chosen.transition.durationMs).toBe(8_000);
    expect(chosen.transition.parameters.reason).toBe("tempo-out-of-range");
  });

  it("picks bass_swap for a drop-headed incoming regardless of suggestedEnergy", () => {
    const outgoing = gridTrack(174, 9, {
      suggestedEnergy: 9,
      tailEnergy: 0.3,
      sections: [
        {
          type: "drop",
          startMs: 20_000,
          endMs: 140_000,
          startBar: null,
          endBar: null,
          confidence: 0.8,
          sectionEnergy: 0.9,
        },
      ],
    });
    const incoming = gridTrack(174, 2, {
      suggestedEnergy: 2,
      mixInMs: 16_000,
      headEnergy: 0.85,
      sections: [
        {
          type: "intro",
          startMs: 0,
          endMs: 16_000,
          startBar: null,
          endBar: null,
          confidence: 0.7,
          sectionEnergy: 0.15,
        },
        {
          type: "drop",
          startMs: 16_000,
          endMs: 80_000,
          startBar: null,
          endBar: null,
          confidence: 0.8,
          sectionEnergy: 0.85,
        },
      ],
    });
    expect(chooseTransition(outgoing, incoming).transition.type).toBe("bass_swap");
  });

  it("picks phrase_mix for a quiet intro even when both tracks are energy 9", () => {
    const outgoing = gridTrack(174, 9, {
      suggestedEnergy: 9,
      tailEnergy: 0.25,
      mixOutMs: 140_000,
      sections: [
        {
          type: "outro",
          startMs: 140_000,
          endMs: 180_000,
          startBar: null,
          endBar: null,
          confidence: 0.7,
          sectionEnergy: 0.25,
        },
      ],
    });
    const incoming = gridTrack(174, 9, {
      suggestedEnergy: 9,
      mixInMs: 0,
      headEnergy: 0.2,
      sections: [
        {
          type: "intro",
          startMs: 0,
          endMs: 40_000,
          startBar: null,
          endBar: null,
          confidence: 0.7,
          sectionEnergy: 0.2,
        },
        {
          type: "drop",
          startMs: 40_000,
          endMs: 120_000,
          startBar: null,
          endBar: null,
          confidence: 0.8,
          sectionEnergy: 0.9,
        },
      ],
    });
    expect(chooseTransition(outgoing, incoming).transition.type).toBe("phrase_mix");
  });

  it("picks bass_swap when both tail and head are hot", () => {
    const outgoing = gridTrack(174, 4, {
      suggestedEnergy: 4,
      tailEnergy: 0.72,
      sections: [
        {
          type: "breakdown",
          startMs: 120_000,
          endMs: 160_000,
          startBar: null,
          endBar: null,
          confidence: 0.7,
          sectionEnergy: 0.72,
        },
      ],
    });
    const incoming = gridTrack(174, 4, {
      suggestedEnergy: 4,
      mixInMs: 8_000,
      headEnergy: 0.7,
      sections: [
        {
          type: "build",
          startMs: 0,
          endMs: 20_000,
          startBar: null,
          endBar: null,
          confidence: 0.7,
          sectionEnergy: 0.7,
        },
      ],
    });
    expect(chooseTransition(outgoing, incoming).transition.type).toBe("bass_swap");
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
    expect(timeline?.mixOutMs).toBe(140_000);
    expect(timeline?.mixInMs).toBe(0);
  });

  it("skips a silent outro and mixes out of the last energetic breakdown", () => {
    const timeline = analysisToTimeline(
      {
        gridRejected: false,
        bpm: 174,
        bpmConfidence: 0.8,
        descriptors: { suggestedEnergy: 7, audioStartMs: 0, audioEndMs: 242_800 },
        sections: [
          { type: "intro", startMs: 0, endMs: 20_000, sectionEnergy: 0.3 },
          { type: "drop", startMs: 20_000, endMs: 180_000, sectionEnergy: 0.9 },
          { type: "breakdown", startMs: 198_600, endMs: 242_000, sectionEnergy: 0.4 },
          { type: "outro", startMs: 242_000, endMs: 264_840, sectionEnergy: 0 },
        ],
      },
      174,
      [],
      264_840,
    );
    expect(timeline?.mixOutMs).toBe(198_600);
    expect(timeline?.tailEnergy).toBe(0.4);
  });

  it("builds windows from outro/intro and extends the start to keep 90s playable", () => {
    const section = (
      type: TrackSection["type"],
      startMs: number,
      endMs: number,
      sectionEnergy: number,
    ): TrackSection => ({
      type,
      startMs,
      endMs,
      startBar: null,
      endBar: null,
      confidence: 0.7,
      sectionEnergy,
    });
    const outgoing = gridTrack(174, 5, {
      audioStartMs: 0,
      audioEndMs: 240_000,
      mixInMs: 150_000,
      mixOutMs: 200_000,
      introStartMs: 150_000,
      introLenMs: 16_000,
      outroStartMs: 200_000,
      outroEndMs: 240_000,
      outroLenMs: 16_000,
      sections: [
        section("intro", 150_000, 170_000, 0.3),
        section("drop", 170_000, 200_000, 0.9),
        section("outro", 200_000, 216_000, 0.4),
      ],
    });
    outgoing.durationMs = 240_000;
    const incoming = gridTrack(174, 5, {
      audioStartMs: 0,
      audioEndMs: 240_000,
      mixInMs: 16_000,
      mixOutMs: 200_000,
      introStartMs: 16_000,
      introLenMs: 16_000,
      sections: [
        section("intro", 16_000, 32_000, 0.3),
        section("drop", 32_000, 200_000, 0.9),
      ],
    });
    incoming.durationMs = 240_000;
    const entries = buildEntries([outgoing, incoming]);
    const overlap = entries[0]!.transitionToNext!.durationMs;
    expect(entries[0]!.sourceEndMs).toBe(Math.min(200_000 + overlap, 240_000));
    expect(entries[1]!.sourceStartMs).toBe(16_000);
    expect(entries[0]!.sourceEndMs - entries[0]!.sourceStartMs).toBeGreaterThanOrEqual(90_000);
    expect(entries[0]!.sourceStartMs).toBeLessThan(150_000);
    expect(entries[0]!.transitionToNext?.parameters.mixOutMs).toBe(200_000);
    expect(entries[0]!.transitionToNext?.parameters.mixInMs).toBe(16_000);
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

describe("applyTransition and silence windows", () => {
  it("applies a phrase-length proposal without collapsing the outgoing start", () => {
    const catalog = runtime();
    const a = seedTrack(catalog, {
      title: "LongOut",
      artist: "A",
      bpm: 174,
      camelot: "11A",
      energy: 5,
      durationMs: 240_000,
    });
    const b = seedTrack(catalog, {
      title: "LongIn",
      artist: "B",
      bpm: 174,
      camelot: "12A",
      energy: 6,
      durationMs: 240_000,
    });
    const c = seedTrack(catalog, {
      title: "LongLast",
      artist: "C",
      bpm: 174,
      camelot: "1A",
      energy: 5,
      durationMs: 240_000,
    });
    const created = catalog.service.createSetPlan({
      name: "Apply",
      targetDurationMs: 600_000,
      requiredTrackIds: [a, b, c],
      startTrackId: a,
      endTrackId: c,
      seed: 1,
    });
    const outgoingStart = created.plan.entries[0]!.sourceStartMs;
    const middleEnd = created.plan.entries[1]!.sourceEndMs;
    const planned = catalog.service.planTransition({
      outgoingTrackId: a,
      incomingTrackId: b,
      preferredType: "phrase_mix",
    });
    const proposal = planned.proposals.find((item) => item.type === "phrase_mix")!;
    expect(proposal.outgoingSourceEndMs - proposal.outgoingSourceStartMs).toBeLessThan(90_000);
    const updated = catalog.service.updateSetPlan({
      setPlanId: created.plan.id,
      applyTransition: {
        entryId: created.plan.entries[0]!.id,
        type: proposal.type,
        durationMs: proposal.durationMs,
        outgoingPlaybackRate: proposal.outgoingPlaybackRate,
        incomingPlaybackRate: proposal.incomingPlaybackRate,
        outgoingSourceStartMs: proposal.outgoingSourceStartMs,
        outgoingSourceEndMs: proposal.outgoingSourceEndMs,
        incomingSourceStartMs: proposal.incomingSourceStartMs,
        incomingSourceEndMs: proposal.incomingSourceEndMs,
      },
    });
    expect(updated.plan.entries[0]!.sourceStartMs).toBe(outgoingStart);
    expect(updated.plan.entries[0]!.sourceEndMs).toBe(proposal.outgoingSourceEndMs);
    expect(updated.plan.entries[1]!.sourceEndMs).toBe(middleEnd);
    expect(updated.plan.entries[0]!.sourceEndMs - updated.plan.entries[0]!.sourceStartMs).toBeGreaterThanOrEqual(
      90_000,
    );
  });

  it("warns WINDOW_IN_SILENCE when the source end sits in digital silence", () => {
    const now = new Date().toISOString();
    const track: Track = {
      id: "t1",
      filePath: "t1.wav",
      fileFingerprint: "t1",
      artist: "A",
      title: "Silent End",
      album: null,
      durationMs: 264_840,
      sampleRateHz: 44100,
      channels: 2,
      bpm: 174,
      bpmSource: "manual",
      musicalKey: "Fm",
      camelotKey: "4A",
      keySource: "manual",
      energy: 7,
      rating: 4,
      subgenres: [],
      moods: [],
      tags: [],
      notes: null,
      analysisStatus: "complete",
      fileMissing: false,
      createdAt: now,
      updatedAt: now,
    };
    const plan: SetPlanV1 = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      name: "silence",
      targetDurationMs: 180_000,
      targetBpm: 174,
      requestedArc: [
        { atFraction: 0, targetEnergy: 5 },
        { atFraction: 1, targetEnergy: 5 },
      ],
      entries: [
        {
          id: "e1",
          trackId: track.id,
          order: 0,
          sourceStartMs: 0,
          sourceEndMs: 264_840,
          timelineStartMs: 0,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: null,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    const result = validateSetPlan(plan, new Map([[track.id, track]]), {
      audioEndMsByTrackId: new Map([[track.id, 242_800]]),
    });
    expect(result.warnings.some((issue) => issue.code === "WINDOW_IN_SILENCE")).toBe(true);
  });
});

describe("descriptor filters and mood presets", () => {
  it("hard-filters the pool by descriptor energy", () => {
    const catalog = runtime();
    const low = seedTrack(catalog, { title: "Low", artist: "A", bpm: 174, camelot: "8A", energy: 5 });
    const high = seedTrack(catalog, { title: "High", artist: "B", bpm: 174, camelot: "9A", energy: 5 });
    stubDescriptors(catalog, low, { energy: 0.4 });
    stubDescriptors(catalog, high, { energy: 0.85 });
    const created = catalog.service.createSetPlan({
      name: "Peak only",
      targetDurationMs: 300_000,
      descriptors: { energy: { min: 0.7 } },
      seed: 1,
    });
    const ids = created.plan.entries.map((entry) => entry.trackId);
    expect(ids).toContain(high);
    expect(ids).not.toContain(low);
    expect(created.explanation.rejected.some((row) => row.reason === "DESCRIPTOR_OUT_OF_RANGE")).toBe(
      true,
    );
  });

  it("scores mood presets when manual moods are empty and ignores them when set", () => {
    const catalog = runtime();
    const liquid = seedTrack(catalog, {
      title: "Liquid Bed",
      artist: "A",
      bpm: 174,
      camelot: "8A",
      energy: 5,
      moods: [],
    });
    const peak = seedTrack(catalog, {
      title: "Peak Bed",
      artist: "B",
      bpm: 174,
      camelot: "9A",
      energy: 5,
      moods: [],
    });
    stubDescriptors(catalog, liquid, { energy: 0.5, melodicness: 0.7, danceability: 0.65 });
    stubDescriptors(catalog, peak, { energy: 0.85, melodicness: 0.2, danceability: 0.8 });
    const created = catalog.service.createSetPlan({
      name: "Preset liquid",
      targetDurationMs: 180_000,
      startTrackId: liquid,
      preferredMoods: ["liquid"],
      seed: 1,
    });
    expect(created.explanation.selected[0]?.score.reasons).toContain("MOOD_PRESET");

    const manual = seedTrack(catalog, {
      title: "Manual Peak",
      artist: "C",
      bpm: 174,
      camelot: "10A",
      energy: 5,
      moods: ["liquid"],
    });
    stubDescriptors(catalog, manual, { energy: 0.85, melodicness: 0.1 });
    const withManual = catalog.service.createSetPlan({
      name: "Manual wins",
      targetDurationMs: 180_000,
      startTrackId: manual,
      preferredMoods: ["liquid"],
      seed: 1,
    });
    expect(withManual.explanation.selected[0]?.score.reasons).toContain("MOOD_MATCH");
    expect(withManual.explanation.selected[0]?.score.reasons).not.toContain("MOOD_PRESET");
  });

  it("uses descriptor energy for arc validation", () => {
    const catalog = runtime();
    const id = seedTrack(catalog, {
      title: "Arc",
      artist: "A",
      bpm: 174,
      camelot: "8A",
      energy: null,
    });
    stubDescriptors(catalog, id, { energy: 0.8 });
    const created = catalog.service.createSetPlan({
      name: "Arc energy",
      targetDurationMs: 150_000,
      startTrackId: id,
      requestedArc: [
        { atFraction: 0, targetEnergy: 8 },
        { atFraction: 1, targetEnergy: 8 },
      ],
      seed: 1,
    });
    expect(created.validation.diagnostics.energyByEntry[0]?.actualEnergy).toBe(8);
  });

  it("never co-selects the same recording_key", () => {
    const catalog = runtime();
    const a = seedTrack(catalog, { title: "Copy A", artist: "A", bpm: 174, camelot: "8A", energy: 6 });
    const b = seedTrack(catalog, { title: "Copy B", artist: "A", bpm: 174, camelot: "8A", energy: 6 });
    catalog.db
      .prepare("UPDATE tracks SET recording_key = ? WHERE id IN (?, ?)")
      .run("mbid:same-recording", a, b);
    const created = catalog.service.createSetPlan({
      name: "Dedupe",
      targetDurationMs: 400_000,
      seed: 1,
    });
    const ids = created.plan.entries.map((entry) => entry.trackId);
    expect(ids.includes(a) && ids.includes(b)).toBe(false);
    expect(created.explanation.rejected.some((row) => row.reason === "DUPLICATE_RECORDING")).toBe(
      true,
    );
  });

  it("treats Chase & Status and Chase And Status as one artist for spacing", () => {
    const catalog = runtime();
    const a = seedTrack(catalog, {
      title: "One",
      artist: "Chase & Status",
      bpm: 174,
      camelot: "8A",
      energy: 6,
    });
    const b = seedTrack(catalog, {
      title: "Two",
      artist: "Chase And Status",
      bpm: 174,
      camelot: "9A",
      energy: 7,
    });
    const created = catalog.service.createSetPlan({
      name: "Spacing",
      targetDurationMs: 300_000,
      startTrackId: a,
      endTrackId: b,
      artistRepeatSpacing: 1,
      seed: 1,
    });
    expect(created.validation.warnings.some((issue) => issue.code === "ARTIST_REPEAT")).toBe(true);
  });

  it("excludes IDM via genre filters", () => {
    const catalog = runtime();
    const keep = seedTrack(catalog, {
      title: "Keep",
      artist: "A",
      bpm: 174,
      camelot: "8A",
      energy: 6,
      genres: ["drum and bass"],
    });
    const drop = seedTrack(catalog, {
      title: "Drop",
      artist: "B",
      bpm: 174,
      camelot: "9A",
      energy: 6,
      genres: ["idm"],
    });
    const created = catalog.service.createSetPlan({
      name: "No IDM",
      targetDurationMs: 300_000,
      genres: { exclude: ["idm"] },
      seed: 1,
    });
    const ids = created.plan.entries.map((entry) => entry.trackId);
    expect(ids).toContain(keep);
    expect(ids).not.toContain(drop);
    expect(created.explanation.rejected.some((row) => row.reason === "GENRE_EXCLUDED")).toBe(true);
  });

  it("lets bpmHint satisfy BPM filters and keeps the join as crossfade", () => {
    const catalog = runtime();
    const grid = seedTrack(catalog, { title: "Grid", artist: "A", bpm: 174, camelot: "8A", energy: 6 });
    const hint = seedTrack(catalog, {
      title: "Hint",
      artist: "B",
      bpm: null,
      camelot: "9A",
      energy: 6,
    });
    stubDescriptors(catalog, hint, { energy: 0.6 }, {
      gridRejected: true,
      bpm: null,
      bpmRaw: 174,
      bpmConfidence: 0.55,
    });
    const created = catalog.service.createSetPlan({
      name: "Hint pool",
      targetDurationMs: 300_000,
      bpmMin: 170,
      bpmMax: 180,
      startTrackId: grid,
      endTrackId: hint,
      seed: 1,
    });
    expect(created.plan.entries.some((entry) => entry.trackId === hint)).toBe(true);
    const hintScore = created.explanation.selected.find((row) => row.trackId === hint);
    expect(hintScore?.score.reasons).toContain("BPM_HINT_ONLY");
    const join = created.plan.entries[0]?.transitionToNext;
    expect(join?.type).toBe("crossfade");
  });
});

