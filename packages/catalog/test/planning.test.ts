import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCatalogRuntime } from "../src/index.ts";
import {
  DSP_ANALYZER_NAME,
  type AppConfig,
  type CreateSetPlanInput,
  type SonicDescriptors,
} from "@dnb-crate/domain";
import { relaxDescriptorFilters } from "../src/planning/planner.ts";
import { validateSetPlan } from "../src/planning/validate.ts";
import {
  analysisToTimeline,
  buildEntries,
  chooseTransition,
  levelMatchGainDb,
  musicalWindow,
  planDurationMs,
  playableOutputMs,
  type TimelineAnalysis,
  type TimelineTrack,
} from "../src/planning/timeline.ts";
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

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
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

function createPlan(catalog: ReturnType<typeof runtime>, input: CreateSetPlanInput) {
  return catalog.service.createSetPlan({ ...input, qualityPolicy: input.qualityPolicy ?? "off" });
}

function seedTrack(
  catalog: ReturnType<typeof runtime>,
  spec: {
    id?: string;
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
  const id = spec.id ?? crypto.randomUUID();
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

function testSonicDescriptors(
  descriptors: Partial<SonicDescriptors> & { energy?: number | null } = {},
): SonicDescriptors {
  return {
    integratedLufs: null,
    shortTermLufsMean: null,
    shortTermLufsMax: null,
    truePeakDb: null,
    subBassRatio: descriptors.subBassRatio ?? 0.5,
    brightness: descriptors.brightness ?? 0.1,
    onsetDensity: null,
    dynamicRange: null,
    dropIntensity: null,
    suggestedEnergy:
      descriptors.suggestedEnergy ??
      (descriptors.energy != null ? Math.round(1 + 9 * descriptors.energy) : 6),
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
    audioStartMs: descriptors.audioStartMs,
    audioEndMs: descriptors.audioEndMs,
  };
}

function stubDescriptors(
  catalog: ReturnType<typeof runtime>,
  trackId: string,
  descriptors: Partial<SonicDescriptors> & { energy?: number | null },
  options: {
    gridRejected?: boolean;
    bpm?: number | null;
    bpmRaw?: number | null;
    bpmConfidence?: number | null;
    integratedLufs?: number | null;
  } = {},
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
    integratedLufs: options.integratedLufs ?? null,
    truePeakDb: null,
    lowBandEnergy: null,
    midBandEnergy: null,
    highBandEnergy: null,
    waveformSummary: null,
    beatAnchorMs: null,
    descriptors: testSonicDescriptors(descriptors),
    engineRuntimeMs: 1,
    analyzedAt: new Date().toISOString(),
    suggestedCues: [],
    sections: [],
  });
}

describe("set planning", () => {
  it("diversifies against explicit mixes, persists the history and keeps hard requests", () => {
    const catalog = runtime();
    for (let i = 0; i < 12; i += 1)
      seedTrack(catalog, {
        title: `Variety ${i}`,
        artist: `Artist ${i}`,
        bpm: 174,
        camelot: "8A",
        energy: 5,
      });
    const brief = { name: "Variety", targetDurationMs: 270_000, seed: 12, explorationWeight: 0 };
    const first = createPlan(catalog, brief);
    const nextBrief = { ...brief, variety: { referencePlanIds: [first.plan.id], strength: 1 } };
    const next = createPlan(catalog, nextBrief);
    const repeat = createPlan(catalog, nextBrief);
    expect(next.plan.entries.map((entry) => entry.trackId)).toEqual(
      repeat.plan.entries.map((entry) => entry.trackId),
    );
    expect(next.explanation.variety?.repeatedTracks).toBe(0);
    expect(catalog.setPlans.findById(next.plan.id)?.explanation.variety).toEqual(
      next.explanation.variety,
    );
    expect(catalog.setPlans.findById(next.plan.id)?.plan.handoffPolicy).toBe("dj-continuity-v1");
    const required = createPlan(catalog, {
      ...nextBrief,
      startTrackId: first.plan.entries[0]!.trackId,
    });
    expect(required.plan.entries[0]?.trackId).toBe(first.plan.entries[0]!.trackId);
    expect(required.explanation.variety?.repeatedTracks).toBeGreaterThan(0);
    expect(() =>
      createPlan(catalog, { ...brief, variety: { referencePlanIds: [crypto.randomUUID()] } }),
    ).toThrow();
  });
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

    const first = createPlan(catalog, {
      name: "Liquid hour",
      targetDurationMs: 600_000,
      startTrackId: start,
      endTrackId: ending,
      preferredMoods: ["liquid"],
      artistRepeatSpacing: 1,
      seed: 1,
    });
    const second = createPlan(catalog, {
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
    expect(first.plan.handoffPolicy).toBe("dj-continuity-v1");
    expect(first.plan.rateRegionsVersion).toBe(2);
    expect(first.plan.targetBpm).toBeNull();
  });

  it("stores a minutes duration request on the plan", () => {
    const catalog = runtime();
    seedTrack(catalog, { title: "Only", artist: "Solo", bpm: 174, camelot: "11A", energy: 5 });
    const created = createPlan(catalog, {
      name: "Twenty",
      targetDurationMinutes: 20,
      seed: 1,
    });
    expect(created.plan.targetDurationMs).toBe(1_200_000);
  });

  it("returns a partial plan when the library cannot fill an hour", () => {
    const catalog = runtime();
    seedTrack(catalog, { title: "Only", artist: "Solo", bpm: 174, camelot: "11A", energy: 5 });
    const created = createPlan(catalog, {
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
    const created = createPlan(catalog, {
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
    const created = createPlan(catalog, {
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
    const created = createPlan(catalog, {
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
    const created = createPlan(catalog, {
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

  it("keeps a non-zero manual gain across clone --replan", () => {
    const catalog = runtime();
    const a = seedTrack(catalog, {
      title: "Loud",
      artist: "A",
      bpm: 174,
      camelot: "11A",
      energy: 6,
    });
    const b = seedTrack(catalog, {
      title: "Quiet",
      artist: "B",
      bpm: 174,
      camelot: "12A",
      energy: 6,
    });
    stubDescriptors(catalog, a, { energy: 0.7 }, { bpm: 174 });
    stubDescriptors(catalog, b, { energy: 0.7 }, { bpm: 174 });
    catalog.analyses.upsert({
      ...catalog.analyses.findByTrackId(a)!,
      integratedLufs: -8,
    });
    catalog.analyses.upsert({
      ...catalog.analyses.findByTrackId(b)!,
      integratedLufs: -16,
    });
    const created = createPlan(catalog, {
      name: "Levels",
      targetDurationMs: 300_000,
      startTrackId: a,
      endTrackId: b,
      seed: 1,
    });
    expect(created.plan.entries[0]?.gainDb).toBe(-4);
    expect(created.plan.entries[1]?.gainDb).toBe(3);
    const edited = {
      ...created.plan,
      entries: created.plan.entries.map((entry, index) =>
        index === 0 ? { ...entry, gainDb: -1.25 } : entry,
      ),
    };
    catalog.setPlans.save(edited, 1, created.explanation);
    const replanned = catalog.service.cloneSetPlan({
      setPlanId: created.plan.id,
      name: "Levels replan",
      replan: true,
    });
    expect(replanned.plan.entries[0]?.gainDb).toBe(-1.25);
    expect(replanned.plan.entries[1]?.gainDb).toBe(3);
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
      camelotKey: null,
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
        downbeatConfidence: null,
        audioStartMs: 0,
        audioEndMs: 180_000,
        mixInMs: 0,
        mixOutMs: 140_000,
        headEnergy: 0.3,
        tailEnergy: 0.4,
        integratedLufs: null,
        keyConfidence: null,
        ...extra,
      },
    };
  }

  it("locks a 174/176 pair to the outgoing integer instead of averaging to 175", () => {
    const a = gridTrack(174, 4);
    const b = gridTrack(176, 9);
    const chosen = chooseTransition(a, b);
    expect(["bass_swap", "phrase_mix"]).toContain(chosen.transition.type);
    expect(chosen.targetBpm).toBe(174);
    expect(chosen.transition.parameters.targetBpm).toBe(174);
    expect(chosen.outgoingRate).toBe(1);
    expect(chosen.incomingRate).toBeCloseTo(174 / 176, 5);
    expect(Math.abs(chosen.incomingRate - 1)).toBeLessThanOrEqual(0.03);
    const entries = buildEntries([a, b]);
    expect(entries[0]?.playbackRate).toBe(1);
    expect(entries[1]?.playbackRate).toBeCloseTo(174 / 176, 5);
  });

  it("keeps a locked middle deck's absolute rate when solving the next pair", () => {
    const a = gridTrack(176);
    const b = gridTrack(172);
    const chosen = chooseTransition(a, b, { outgoingEffectiveBpm: 174 });
    expect(chosen.outgoingRate).toBeCloseTo(174 / 176, 10);
    expect(chosen.incomingRate).toBeCloseTo(174 / 172, 10);
  });

  it("preserves explicit short source windows and records the actual join", () => {
    const a = gridTrack(174);
    const b = gridTrack(174, 5, { manualMixInMs: 120_000 });
    const entries = buildEntries([a, b]);
    expect(entries[1]!.sourceStartMs).toBe(120_000);
    expect(entries[0]!.transitionToNext!.parameters.mixInMs).toBe(120_000);
    expect(entries[0]!.transitionToNext!.parameters.recipeVersion).toBe(1);
  });

  it("extends a drop-anchored tail to 90s without moving mix-in", () => {
    const track = gridTrack(174, 5, { audioEndMs: 240_000, mixOutMs: 160_000 });
    track.durationMs = 240_000;
    const window = musicalWindow(track, 44_000, 1, false, { mixInMs: 140_000, mixOutMs: 160_000 });
    expect(window.sourceStartMs).toBe(140_000);
    expect(window.sourceEndMs - window.sourceStartMs).toBeGreaterThanOrEqual(90_000);
  });

  it("keeps a 174+174+176 chain at 174 and only stretches the 176", () => {
    const entries = buildEntries([gridTrack(174), gridTrack(174), gridTrack(176)]);
    expect(entries[0]?.playbackRate).toBe(1);
    expect(entries[1]?.playbackRate).toBe(1);
    expect(entries[2]?.playbackRate).toBeCloseTo(174 / 176, 5);
    expect(entries[0]?.transitionToNext?.parameters.targetBpm).toBe(174);
    expect(entries[1]?.transitionToNext?.parameters.targetBpm).toBe(174);
  });

  it("floats a 175/175 pair instead of pulling it to 174", () => {
    const entries = buildEntries([gridTrack(175), gridTrack(175)]);
    expect(entries[0]?.playbackRate).toBe(1);
    expect(entries[1]?.playbackRate).toBe(1);
    expect(entries[0]?.transitionToNext?.parameters.targetBpm).toBe(175);
  });

  it("still locks 175/175 when the brief sets targetBpm", () => {
    const entries = buildEntries([gridTrack(175), gridTrack(175)], undefined, undefined, {
      targetBpm: 174,
    });
    expect(entries[0]?.playbackRate).toBeCloseTo(174 / 175, 5);
    expect(entries[1]?.playbackRate).toBeCloseTo(174 / 175, 5);
    expect(entries[0]?.transitionToNext?.parameters.targetBpm).toBe(174);
  });

  it("stretches from the analyzed grid BPM, not published canonical", () => {
    const memory = gridTrack(176, 8, { bpm: 175, canonicalBpm: 176 });
    const hayling = gridTrack(174, 8);
    const chosen = chooseTransition(memory, hayling, { chainTargetBpm: 174 });
    expect(chosen.targetBpm).toBe(174);
    expect(chosen.outgoingRate).toBeCloseTo(174 / 175, 5);
    expect(chosen.incomingRate).toBe(1);
    const entries = buildEntries([memory, hayling, gridTrack(174)], undefined, undefined, {
      targetBpm: 174,
    });
    expect(entries[0]?.playbackRate).toBeCloseTo(174 / 175, 5);
    expect(entries[1]?.playbackRate).toBe(1);
    expect(entries[2]?.playbackRate).toBe(1);
    const rate = 174 / 175;
    const overlap = entries[0]!.transitionToNext!.durationMs;
    const source = entries[0]!.sourceEndMs - entries[0]!.sourceStartMs;
    expect(playableOutputMs(entries[0]!)).toBeCloseTo(source - overlap * rate + overlap, 5);
    expect(playableOutputMs(entries[0]!)).toBeLessThan(source / rate - 1);
    expect(planDurationMs(entries)).toBeGreaterThan(0);
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
    expect(chosen.transition.parameters.reason).toBe("outgoing-grid-rejected");
  });

  it("uses outgoing-grid-rejected when BPMs match but grids are rejected", () => {
    const outgoing = gridTrack(174, 5, { gridOk: false });
    const incoming = gridTrack(174, 5, { gridOk: false });
    const chosen = chooseTransition(outgoing, incoming);
    expect(chosen.transition.type).toBe("crossfade");
    expect(chosen.transition.parameters.reason).toBe("outgoing-grid-rejected");
    expect(chosen.transition.durationMs).toBe(30_000);
  });

  it("uses incoming-grid-rejected when only the incoming grid fails", () => {
    const outgoing = gridTrack(174, 5);
    const incoming = gridTrack(174, 5, { gridOk: false });
    const chosen = chooseTransition(outgoing, incoming);
    expect(chosen.transition.parameters.reason).toBe("incoming-grid-rejected");
  });

  it("uses missing-bpm when canonical tempo is absent", () => {
    const outgoing = gridTrack(174, 5, { bpm: null, canonicalBpm: null });
    outgoing.bpm = null;
    const incoming = gridTrack(174, 5);
    const chosen = chooseTransition(outgoing, incoming);
    expect(chosen.transition.parameters.reason).toBe("missing-bpm");
  });

  it("uses a phrase mix for a drop-headed incoming regardless of suggestedEnergy", () => {
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
      manualMixInMs: 16_000,
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
    expect(chooseTransition(outgoing, incoming).transition.type).toBe("phrase_mix");
    expect(chooseTransition(outgoing, incoming).transition.parameters.reason).toBe(
      "continuity-window",
    );
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

  it("uses a phrase mix when both tail and head are hot", () => {
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
    expect(chooseTransition(outgoing, incoming).transition.type).toBe("phrase_mix");
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

  it("matches levels to the set median LUFS and clamps", () => {
    const loud = gridTrack(174, 5, { integratedLufs: -8 });
    const mid = gridTrack(174, 5, { integratedLufs: -12 });
    const quiet = gridTrack(174, 5, { integratedLufs: -16 });
    const entries = buildEntries([loud, mid, quiet]);
    expect(entries.map((entry) => entry.gainDb)).toEqual([-4, 0, 3]);
  });

  it("does not LUFS-boost a track whose true peak is already over 0 dBTP", () => {
    const hotQuiet = gridTrack(174, 5, { integratedLufs: -16, truePeakDb: 3 });
    const mid = gridTrack(174, 5, { integratedLufs: -12, truePeakDb: -1 });
    const entries = buildEntries([hotQuiet, mid]);
    expect(entries[0]?.gainDb).toBe(-3);
    expect(entries[0]?.transitionToNext?.parameters.levelMatchWarning).toBe("true-peak-headroom");
    expect(levelMatchGainDb(-16, -12, 3)).toEqual({ gainDb: -3, warning: "true-peak-headroom" });
    expect(levelMatchGainDb(-16, -12, 0.8)).toEqual({
      gainDb: -0.8,
      warning: "true-peak-headroom",
    });
    expect(levelMatchGainDb(-13, -12, -2)).toEqual({ gainDb: 1, warning: null });
  });

  it("leaves gain at 0 and warns when LUFS is missing", () => {
    const known = gridTrack(174, 5, { integratedLufs: -12 });
    const unknown = gridTrack(174, 5, { integratedLufs: null });
    const entries = buildEntries([known, unknown]);
    expect(entries[1]?.gainDb).toBe(0);
    expect(entries[0]?.transitionToNext?.parameters.levelMatchWarning).toBeUndefined();
    const onlyUnknown = buildEntries([unknown, known]);
    expect(onlyUnknown[0]?.gainDb).toBe(0);
    expect(onlyUnknown[0]?.transitionToNext?.parameters.levelMatchWarning).toBe("missing-lufs");
  });

  it("preserves a manual gainDb on re-plan", () => {
    const a = gridTrack(174, 5, { integratedLufs: -8 });
    const b = gridTrack(174, 5, { integratedLufs: -16 });
    const first = buildEntries([a, b]);
    expect(first[0]?.gainDb).toBe(-4);
    const prior = new Map([
      [a.id, { ...first[0]!, gainDb: -1.5 }],
      [b.id, first[1]!],
    ]);
    const again = buildEntries([a, b], undefined, prior);
    expect(again[0]?.gainDb).toBe(-1.5);
    expect(again[1]?.gainDb).toBe(first[1]?.gainDb);
  });

  it("preserves a manual playbackRate on re-plan", () => {
    const a = gridTrack(174);
    const b = gridTrack(176);
    const first = buildEntries([a, b]);
    expect(first[1]?.playbackRate).not.toBe(1);
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

  it("builds windows from outro/intro and keeps the planned mix-in", () => {
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
      sections: [section("intro", 16_000, 32_000, 0.3), section("drop", 32_000, 200_000, 0.9)],
    });
    incoming.durationMs = 240_000;
    const entries = buildEntries([outgoing, incoming]);
    const overlap = entries[0]!.transitionToNext!.durationMs;
    expect(entries[0]!.sourceEndMs).toBe(Math.min(200_000 + overlap, 240_000));
    expect(entries[1]!.sourceStartMs).toBe(16_000);
    expect(entries[0]!.sourceStartMs).toBe(150_000);
    expect(entries[0]!.transitionToNext?.parameters.mixOutMs).toBe(200_000);
    expect(entries[0]!.transitionToNext?.parameters.mixInMs).toBe(16_000);
  });

  function phraseGrid(
    bpm: number,
    camelot: string | null,
    extra: Partial<TimelineAnalysis> = {},
  ): TimelineTrack {
    const bar = (4 * 60_000) / bpm;
    const section = (
      type: TrackSection["type"],
      startBar: number,
      endBar: number,
      sectionEnergy: number,
    ): TrackSection => ({
      type,
      startMs: Math.round(startBar * bar),
      endMs: Math.round(endBar * bar),
      startBar,
      endBar,
      confidence: 0.8,
      sectionEnergy,
    });
    const endBar = 80;
    return {
      id: crypto.randomUUID(),
      durationMs: Math.round(endBar * bar),
      energy: 6,
      bpm,
      camelotKey: camelot,
      analysis: {
        gridOk: true,
        bpm,
        canonicalBpm: bpm,
        bpmHint: null,
        bpmHintConfidence: null,
        suggestedEnergy: 6,
        introStartMs: 0,
        outroStartMs: Math.round(72 * bar),
        outroEndMs: Math.round(endBar * bar),
        introLenMs: Math.round(16 * bar),
        outroLenMs: Math.round(8 * bar),
        sections: [
          section("intro", 0, 16, 0.2),
          section("build", 16, 48, 0.25),
          section("drop", 48, 80, 0.9),
        ],
        downbeatTimesMs: Array.from({ length: endBar * 4 + 1 }, (_, i) =>
          Math.round((i * bar) / 4),
        ),
        downbeatConfidence: 1,
        audioStartMs: 0,
        audioEndMs: Math.round(endBar * bar),
        mixInMs: 0,
        mixOutMs: Math.round(48 * bar),
        headEnergy: 0.2,
        tailEnergy: 0.9,
        integratedLufs: null,
        keyConfidence: null,
        ...extra,
      },
    };
  }

  it("stamps lift intent on a quiet complementary join and prefers 16 bars", () => {
    const bar = (4 * 60_000) / 174;
    const outgoing = phraseGrid(174, "8A", {
      sections: [
        {
          type: "drop",
          startMs: Math.round(16 * bar),
          endMs: Math.round(48 * bar),
          startBar: 16,
          endBar: 48,
          confidence: 0.8,
          sectionEnergy: 0.9,
        },
        {
          type: "outro",
          startMs: Math.round(48 * bar),
          endMs: Math.round(72 * bar),
          startBar: 48,
          endBar: 72,
          confidence: 0.8,
          sectionEnergy: 0.2,
        },
      ],
    });
    const incoming = phraseGrid(174, "9A");
    const chosen = chooseTransition(outgoing, incoming, { dropAnchored: true });
    expect(chosen.transition.parameters.intent).toBe("lift");
    expect(chosen.transition.parameters.barCount).toBe(16);
    expect(chosen.transition.parameters.lowHandoverBar).toBe(8);
    expect(chosen.window?.exitKind).toBe("quietTail");
  });

  it("stamps sustain on a sequential kit-on join", () => {
    const bar = (4 * 60_000) / 174;
    const outgoing = phraseGrid(174, "8A", {
      sections: [
        {
          type: "drop",
          startMs: Math.round(16 * bar),
          endMs: Math.round(48 * bar),
          startBar: 16,
          endBar: 48,
          confidence: 0.8,
          sectionEnergy: 0.9,
        },
        {
          type: "outro",
          startMs: Math.round(48 * bar),
          endMs: Math.round(72 * bar),
          startBar: 48,
          endBar: 72,
          confidence: 0.8,
          sectionEnergy: 0.2,
        },
      ],
    });
    const incoming = phraseGrid(174, "9A", {
      sections: [
        {
          type: "intro",
          startMs: 0,
          endMs: Math.round(16 * bar),
          startBar: 0,
          endBar: 16,
          confidence: 0.8,
          sectionEnergy: 0.2,
        },
        {
          type: "build",
          startMs: Math.round(16 * bar),
          endMs: Math.round(48 * bar),
          startBar: 16,
          endBar: 48,
          confidence: 0.8,
          sectionEnergy: 0.7,
        },
        {
          type: "drop",
          startMs: Math.round(48 * bar),
          endMs: Math.round(80 * bar),
          startBar: 48,
          endBar: 80,
          confidence: 0.8,
          sectionEnergy: 0.9,
        },
      ],
    });
    const chosen = chooseTransition(outgoing, incoming, { dropAnchored: true });
    expect(["landing", "sequential"]).toContain(chosen.transition.parameters.phraseShape);
    expect(chosen.transition.parameters.intent).toBe("sustain");
    expect(chosen.transition.parameters.barCount).toBeGreaterThanOrEqual(16);
  });

  it("keeps a drop landing as sustain", () => {
    const outgoing = phraseGrid(174, "8A", {
      sections: [
        {
          type: "drop",
          startMs: Math.round(16 * ((4 * 60_000) / 174)),
          endMs: Math.round(80 * ((4 * 60_000) / 174)),
          startBar: 16,
          endBar: 80,
          confidence: 0.8,
          sectionEnergy: 0.9,
        },
      ],
    });
    const incoming = phraseGrid(174, "9A");
    const chosen = chooseTransition(outgoing, incoming, { dropAnchored: true });
    expect(chosen.window?.exitKind).toBe("dropLanding");
    expect(chosen.transition.parameters.phraseShape).toBe("landing");
    expect(chosen.transition.parameters.barCount).toBeGreaterThanOrEqual(16);
    expect(chosen.transition.parameters.intent).toBe("sustain");
  });

  it("does not shorten a DJ key-clash join to 8 bars", () => {
    const outgoing = phraseGrid(174, "8A", {
      sections: [
        {
          type: "drop",
          startMs: Math.round(16 * ((4 * 60_000) / 174)),
          endMs: Math.round(80 * ((4 * 60_000) / 174)),
          startBar: 16,
          endBar: 80,
          confidence: 0.8,
          sectionEnergy: 0.9,
        },
      ],
    });
    const incoming = phraseGrid(174, "11A");
    const chosen = chooseTransition(outgoing, incoming);
    expect(chosen.transition.parameters.keyClash).toBe(true);
    expect(chosen.transition.parameters.barCount).toBeGreaterThanOrEqual(16);
  });

  it("does not shorten a relative or adjacent-same-mode join", () => {
    const outgoing = phraseGrid(174, "5A");
    const relative = chooseTransition(outgoing, phraseGrid(174, "5B"));
    expect(relative.transition.parameters.keyClash).toBeUndefined();
    expect(relative.transition.parameters.barCount).not.toBe(8);
    const adjacent = chooseTransition(outgoing, phraseGrid(174, "6A"));
    expect(adjacent.transition.parameters.keyClash).toBeUndefined();
  });

  it("does not move a drop-anchored incoming start to satisfy the 90 s minimum", () => {
    const bar = (4 * 60_000) / 174;
    const outgoing = phraseGrid(174, "8A", {
      sections: [
        {
          type: "drop",
          startMs: Math.round(16 * bar),
          endMs: Math.round(80 * bar),
          startBar: 16,
          endBar: 80,
          confidence: 0.8,
          sectionEnergy: 0.9,
        },
      ],
    });
    const incoming = phraseGrid(174, "9A");
    incoming.durationMs = 120_000;
    incoming.analysis!.audioEndMs = 120_000;
    incoming.analysis!.sections = [
      {
        type: "intro",
        startMs: 0,
        endMs: 80_000,
        startBar: 0,
        endBar: 58,
        confidence: 0.8,
        sectionEnergy: 0.2,
      },
      {
        type: "drop",
        startMs: 100_000,
        endMs: 120_000,
        startBar: 72,
        endBar: 87,
        confidence: 0.8,
        sectionEnergy: 0.9,
      },
    ];
    const entries = buildEntries([outgoing, incoming]);
    expect(entries[1]!.sourceStartMs).toBeGreaterThan(40_000);
    expect(entries[1]!.sourceStartMs).toBeCloseTo(
      entries[0]!.transitionToNext!.parameters.mixInMs as number,
      0,
    );
  });

  it("preserves an explicit complementary shape on rebuild", () => {
    const a = phraseGrid(174, "8A");
    const b = phraseGrid(174, "9A");
    const first = buildEntries([a, b]);
    const prior = new Map([
      [
        a.id,
        {
          ...first[0]!,
          transitionToNext: {
            ...first[0]!.transitionToNext!,
            parameters: { ...first[0]!.transitionToNext!.parameters, phraseShape: "complementary" },
          },
        },
      ],
      [b.id, first[1]!],
    ]);
    const again = buildEntries([a, b], undefined, prior);
    expect(again[0]!.transitionToNext!.parameters.phraseShape).toBe("complementary");
  });

  it("uses the same mix-in and rates for a standalone proposal and a set-plan join", () => {
    const outgoing = phraseGrid(174, "8A", {
      sections: [
        {
          type: "drop",
          startMs: Math.round(16 * ((4 * 60_000) / 174)),
          endMs: Math.round(80 * ((4 * 60_000) / 174)),
          startBar: 16,
          endBar: 80,
          confidence: 0.8,
          sectionEnergy: 0.9,
        },
      ],
    });
    const incoming = phraseGrid(176, "9A");
    const chosen = chooseTransition(outgoing, incoming);
    const planned = planTransition(
      {
        track: {
          id: outgoing.id,
          filePath: "out.wav",
          fileFingerprint: "out",
          artist: "A",
          title: "Out",
          album: null,
          durationMs: outgoing.durationMs,
          sampleRateHz: 44100,
          channels: 2,
          bpm: outgoing.bpm,
          bpmSource: "manual",
          musicalKey: "Am",
          camelotKey: outgoing.camelotKey,
          keySource: "manual",
          energy: 6,
          rating: 4,
          subgenres: [],
          moods: [],
          tags: [],
          notes: null,
          analysisStatus: "complete",
          fileMissing: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        analysis: {
          trackId: outgoing.id,
          analyzerName: "dnb-crate-dsp",
          analyzerVersion: "3.2.0",
          bpm: 174,
          bpmConfidence: 0.9,
          bpmRaw: 174,
          beatTimesMs: outgoing.analysis!.downbeatTimesMs,
          downbeatTimesMs: outgoing.analysis!.downbeatTimesMs,
          gridRejected: false,
          gridRejectionReason: null,
          musicalKey: "Am",
          keyConfidence: 0.8,
          keyMode: "minor",
          camelotKey: "8A",
          tempoStability: 0.8,
          downbeatConfidence: 1,
          integratedLufs: null,
          truePeakDb: null,
          lowBandEnergy: null,
          midBandEnergy: null,
          highBandEnergy: null,
          waveformSummary: null,
          beatAnchorMs: null,
          descriptors: testSonicDescriptors({
            suggestedEnergy: 6,
            audioStartMs: 0,
            audioEndMs: outgoing.durationMs,
          }),
          engineRuntimeMs: 1,
          analyzedAt: new Date().toISOString(),
          suggestedCues: [],
          sections: outgoing.analysis!.sections,
        },
        cues: [],
      },
      {
        track: {
          id: incoming.id,
          filePath: "in.wav",
          fileFingerprint: "in",
          artist: "B",
          title: "In",
          album: null,
          durationMs: incoming.durationMs,
          sampleRateHz: 44100,
          channels: 2,
          bpm: incoming.bpm,
          bpmSource: "manual",
          musicalKey: "Em",
          camelotKey: incoming.camelotKey,
          keySource: "manual",
          energy: 6,
          rating: 4,
          subgenres: [],
          moods: [],
          tags: [],
          notes: null,
          analysisStatus: "complete",
          fileMissing: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        analysis: {
          trackId: incoming.id,
          analyzerName: "dnb-crate-dsp",
          analyzerVersion: "3.2.0",
          bpm: 176,
          bpmConfidence: 0.9,
          bpmRaw: 176,
          beatTimesMs: incoming.analysis!.downbeatTimesMs,
          downbeatTimesMs: incoming.analysis!.downbeatTimesMs,
          gridRejected: false,
          gridRejectionReason: null,
          musicalKey: "Em",
          keyConfidence: 0.8,
          keyMode: "minor",
          camelotKey: "9A",
          tempoStability: 0.8,
          downbeatConfidence: 1,
          integratedLufs: null,
          truePeakDb: null,
          lowBandEnergy: null,
          midBandEnergy: null,
          highBandEnergy: null,
          waveformSummary: null,
          beatAnchorMs: null,
          descriptors: testSonicDescriptors({
            suggestedEnergy: 6,
            audioStartMs: 0,
            audioEndMs: incoming.durationMs,
          }),
          engineRuntimeMs: 1,
          analyzedAt: new Date().toISOString(),
          suggestedCues: [],
          sections: incoming.analysis!.sections,
        },
        cues: [],
      },
      { outgoingTrackId: outgoing.id, incomingTrackId: incoming.id, preferredType: "phrase_mix" },
    );
    const proposal = planned.proposals[0]!;
    expect(proposal.incomingCuePositionMs).toBe(chosen.window!.mixInMs);
    expect(proposal.outgoingPlaybackRate).toBeCloseTo(chosen.outgoingRate, 8);
    expect(proposal.incomingPlaybackRate).toBeCloseTo(chosen.incomingRate, 8);
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
          {
            type: "intro" as const,
            startMs: 0,
            endMs: 20_000,
            startBar: 0,
            endBar: 8,
            confidence: 0.6,
            sectionEnergy: 0.4,
          },
          {
            type: "drop" as const,
            startMs: 20_000,
            endMs: 80_000,
            startBar: 8,
            endBar: 32,
            confidence: 0.8,
            sectionEnergy: 0.9,
          },
          {
            type: "outro" as const,
            startMs: 140_000,
            endMs: 180_000,
            startBar: 56,
            endBar: 72,
            confidence: 0.62,
            sectionEnergy: 0.3,
          },
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
          {
            type: "intro" as const,
            startMs: 0,
            endMs: 16_000,
            startBar: 0,
            endBar: 8,
            confidence: 0.55,
            sectionEnergy: 0.3,
          },
          {
            type: "drop" as const,
            startMs: 16_000,
            endMs: 80_000,
            startBar: 8,
            endBar: 32,
            confidence: 0.8,
            sectionEnergy: 0.9,
          },
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
    const created = createPlan(catalog, {
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
    expect(
      updated.plan.entries[0]!.sourceEndMs - updated.plan.entries[0]!.sourceStartMs,
    ).toBeGreaterThanOrEqual(90_000);
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
    const low = seedTrack(catalog, {
      title: "Low",
      artist: "A",
      bpm: 174,
      camelot: "8A",
      energy: 5,
    });
    const high = seedTrack(catalog, {
      title: "High",
      artist: "B",
      bpm: 174,
      camelot: "9A",
      energy: 5,
    });
    stubDescriptors(catalog, low, { energy: 0.4 });
    stubDescriptors(catalog, high, { energy: 0.85 });
    const created = createPlan(catalog, {
      name: "Peak only",
      targetDurationMs: 300_000,
      descriptors: { energy: { min: 0.7 } },
      seed: 1,
    });
    const ids = created.plan.entries.map((entry) => entry.trackId);
    expect(ids).toContain(high);
    expect(ids).not.toContain(low);
    expect(
      created.explanation.rejected.some((row) => row.reason === "DESCRIPTOR_OUT_OF_RANGE"),
    ).toBe(true);
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
    const created = createPlan(catalog, {
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
    const withManual = createPlan(catalog, {
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
    const created = createPlan(catalog, {
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
    const a = seedTrack(catalog, {
      title: "Copy A",
      artist: "A",
      bpm: 174,
      camelot: "8A",
      energy: 6,
    });
    const b = seedTrack(catalog, {
      title: "Copy B",
      artist: "A",
      bpm: 174,
      camelot: "8A",
      energy: 6,
    });
    catalog.db
      .prepare("UPDATE tracks SET recording_key = ? WHERE id IN (?, ?)")
      .run("mbid:same-recording", a, b);
    const created = createPlan(catalog, {
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
    const created = createPlan(catalog, {
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
    const created = createPlan(catalog, {
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
    const grid = seedTrack(catalog, {
      title: "Grid",
      artist: "A",
      bpm: 174,
      camelot: "8A",
      energy: 6,
    });
    const hint = seedTrack(catalog, {
      title: "Hint",
      artist: "B",
      bpm: null,
      camelot: "9A",
      energy: 6,
    });
    stubDescriptors(
      catalog,
      hint,
      { energy: 0.6 },
      {
        gridRejected: true,
        bpm: null,
        bpmRaw: 174,
        bpmConfidence: 0.55,
      },
    );
    const created = createPlan(catalog, {
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

  it("prefers the closer LUFS neighbour when the rest is equal", () => {
    const catalog = runtime();
    const start = seedTrack(catalog, {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Src",
      artist: "A",
      bpm: 174,
      camelot: "8A",
      energy: 6,
    });
    const close = seedTrack(catalog, {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Close",
      artist: "B",
      bpm: 174,
      camelot: "8A",
      energy: 6,
    });
    const far = seedTrack(catalog, {
      id: "33333333-3333-4333-8333-333333333333",
      title: "Far",
      artist: "C",
      bpm: 174,
      camelot: "8A",
      energy: 6,
    });
    stubDescriptors(catalog, start, { energy: 0.7 }, { integratedLufs: -8 });
    stubDescriptors(catalog, close, { energy: 0.7 }, { integratedLufs: -7 });
    stubDescriptors(catalog, far, { energy: 0.7 }, { integratedLufs: -13 });
    const created = createPlan(catalog, {
      name: "Level",
      targetDurationMs: 300_000,
      startTrackId: start,
      seed: 1,
      explorationWeight: 0,
    });
    const second = created.plan.entries[1]?.trackId;
    expect(second).toBe(close);
    expect(
      created.explanation.selected.some(
        (row) => row.score.components.joinLevel !== 0 || row.trackId === close,
      ),
    ).toBe(true);
  });

  it("ranks and plans from the selected structure engine", () => {
    const catalog = runtime();
    const start = seedTrack(catalog, {
      id: "44444444-4444-4444-8444-444444444444",
      title: "Src",
      artist: "A",
      bpm: 174,
      camelot: "8A",
      energy: 6,
    });
    const other = seedTrack(catalog, {
      id: "55555555-5555-4555-8555-555555555555",
      title: "Other",
      artist: "C",
      bpm: 174,
      camelot: "8A",
      energy: 6,
    });
    const match = seedTrack(catalog, {
      id: "66666666-6666-4666-8666-666666666666",
      title: "Match",
      artist: "B",
      bpm: 174,
      camelot: "8A",
      energy: 6,
    });
    const section = (
      type: TrackSection["type"],
      startMs: number,
      endMs: number,
      startBar = 0,
      endBar = 0,
    ): TrackSection => ({
      type,
      startMs,
      endMs,
      startBar,
      endBar,
      confidence: 0.8,
      sectionEnergy: 0.4,
    });
    const upsert = (trackId: string, engine: string, sections: TrackSection[]) => {
      catalog.analyses.upsert({
        trackId,
        analyzerName: engine,
        analyzerVersion: "3.0.0",
        bpm: 174,
        bpmConfidence: 0.8,
        bpmRaw: 174,
        referenceBpm: null,
        beatTimesMs: [],
        downbeatTimesMs: [],
        gridRejected: false,
        gridRejectionReason: null,
        gridSource: "analyzed",
        musicalKey: "xmin",
        keyConfidence: 0.8,
        keyMode: "minor",
        camelotKey: "8A",
        tempoStability: null,
        downbeatConfidence: null,
        integratedLufs: null,
        truePeakDb: null,
        lowBandEnergy: null,
        midBandEnergy: null,
        highBandEnergy: null,
        waveformSummary: null,
        beatAnchorMs: null,
        descriptors: testSonicDescriptors({ energy: 0.6 }),
        engineRuntimeMs: 1,
        analyzedAt: new Date().toISOString(),
        suggestedCues: [],
        sections,
      });
    };
    upsert(start, DSP_ANALYZER_NAME, [
      section("intro", 0, 2_000),
      section("drop", 40_000, 60_000),
      section("outro", 146_000, 148_000),
    ]);
    upsert(start, "legacy-structure", [
      section("intro", 0, 4_000),
      section("drop", 80_000, 100_000),
      section("outro", 146_000, 150_000),
    ]);
    upsert(match, DSP_ANALYZER_NAME, [
      section("intro", 0, 8_000, 0, 16),
      section("drop", 4_000, 20_000, 8, 40),
    ]);
    upsert(match, "legacy-structure", [
      section("intro", 0, 4_000, 0, 8),
      section("drop", 8_000, 24_000, 16, 48),
    ]);
    upsert(other, DSP_ANALYZER_NAME, [
      section("intro", 0, 8_000, 0, 16),
      section("drop", 4_000, 20_000, 8, 40),
    ]);
    catalog.service.selectTrackEvidence({
      trackId: start,
      rhythmEngine: DSP_ANALYZER_NAME,
      structureEngine: "legacy-structure",
      reason: "test",
    });
    catalog.service.selectTrackEvidence({
      trackId: match,
      rhythmEngine: DSP_ANALYZER_NAME,
      structureEngine: "legacy-structure",
      reason: "test",
    });
    const ranked = catalog.service.findCompatibleTracks({ sourceTrackId: start });
    expect(ranked.candidates[0]?.track.id).toBe(match);
    expect(ranked.candidates[0]?.score.components.structure).toBeGreaterThan(
      ranked.candidates.find((row) => row.track.id === other)?.score.components.structure ?? 0,
    );
    expect(
      catalog.service.getTrackAnalysis(match).sections.find((row) => row.type === "drop")?.startMs,
    ).toBe(8_000);
    expect(
      catalog.service.getTrackAnalysis(start).sections.find((row) => row.type === "outro"),
    ).toMatchObject({ startMs: 146_000, endMs: 150_000 });
    const planned = catalog.service.planTransition({
      outgoingTrackId: start,
      incomingTrackId: match,
    });
    expect(planned.proposals.length).toBeGreaterThan(0);
    expect(catalog.service.getTrackAnalysis(start).bpm).toBe(174);
  });

  it("does not write an analyzed key below the confidence gate", () => {
    const catalog = runtime();
    const id = crypto.randomUUID();
    catalog.repository.upsertFromScan({
      id,
      filePath: path.join("C:", "virtual", "gated.wav"),
      fileFingerprint: "gated",
      artist: "X",
      title: "Gated",
      album: null,
      durationMs: 150_000,
      sampleRateHz: 44100,
      channels: 2,
      bpm: null,
      bpmSource: null,
      musicalKey: null,
      camelotKey: null,
      keySource: null,
    });
    catalog.repository.applyAnalyzedMetadata(id, {
      bpm: 174,
      musicalKey: "Cm",
      keyConfidence: 0.05,
      gridRejected: false,
    });
    expect(catalog.repository.findById(id)?.musicalKey).toBeNull();
    catalog.repository.applyAnalyzedMetadata(id, {
      bpm: 174,
      musicalKey: "Cm",
      keyConfidence: 0.8,
      gridRejected: false,
    });
    expect(catalog.repository.findById(id)?.musicalKey).toBe("Cm");
    expect(catalog.repository.findById(id)?.keySource).toBe("analyzed");
  });

  it("reports harmonicCoverage for keyed joins", () => {
    const catalog = runtime();
    const start = seedTrack(catalog, {
      title: "A",
      artist: "X",
      bpm: 174,
      camelot: "8A",
      energy: 6,
    });
    const next = seedTrack(catalog, {
      title: "B",
      artist: "Y",
      bpm: 174,
      camelot: "8A",
      energy: 6,
    });
    stubDescriptors(catalog, start, { energy: 0.7 });
    stubDescriptors(catalog, next, { energy: 0.7 });
    const created = createPlan(catalog, {
      name: "Coverage",
      targetDurationMs: 300_000,
      startTrackId: start,
      endTrackId: next,
      seed: 1,
    });
    expect(created.explanation.harmonicCoverage?.totalJoins).toBeGreaterThanOrEqual(1);
    expect(created.explanation.harmonicCoverage?.knownJoins).toBeGreaterThanOrEqual(1);
  });

  it("relaxes descriptor filters from the original brief, not cumulatively", () => {
    const original = { energy: { min: 0.92, max: 1 } };
    const step1 = relaxDescriptorFilters(original, 1);
    const step2 = relaxDescriptorFilters(original, 2);
    const step3 = relaxDescriptorFilters(original, 3);
    expect(step1?.energy?.min).toBeCloseTo(0.84, 5);
    expect(step2?.energy?.min).toBeCloseTo(0.76, 5);
    expect(step3?.energy?.min).toBeCloseTo(0.68, 5);
    expect(step3?.energy?.max).toBeCloseTo(1.24, 5);
    const wronglyCumulative = relaxDescriptorFilters(step2, 3);
    expect(wronglyCumulative?.energy?.min).toBeLessThan(step3!.energy!.min! - 1e-9);
  });

  it("does not promote praised pairs on a fresh plan", () => {
    const catalog = runtime();
    const start = seedTrack(catalog, {
      title: "FeedbackStart",
      artist: "A",
      bpm: 174,
      camelot: "8A",
      energy: 6,
    });
    const liked = seedTrack(catalog, {
      title: "LikedNext",
      artist: "B",
      bpm: 174,
      camelot: "8A",
      energy: 6,
    });
    seedTrack(catalog, {
      title: "OtherNext",
      artist: "C",
      bpm: 174,
      camelot: "8A",
      energy: 6,
    });
    catalog.service.rateTransition({
      outgoingTrackId: start,
      incomingTrackId: liked,
      type: "phrase_mix",
      overall: 1,
    });
    const fresh = createPlan(catalog, {
      name: "Fresh feedback",
      targetDurationMs: 280_000,
      startTrackId: start,
      requiredTrackIds: [liked],
      seed: 1,
    });
    expect(fresh.explanation.selected.every((entry) => entry.score.components.feedback <= 0)).toBe(
      true,
    );
  });

  it("drops a non-required tail when the hour overshoots and refuses an overshoot extra", () => {
    const catalog = runtime();
    for (let i = 0; i < 16; i += 1) {
      const id = seedTrack(catalog, {
        title: `Long ${i}`,
        artist: `Artist ${i}`,
        bpm: 174,
        camelot: "8A",
        energy: 6,
        durationMs: 280_000,
      });
      stubDescriptors(catalog, id, { energy: 0.7 });
    }
    const oversize = createPlan(catalog, {
      name: "Oversize drop",
      targetDurationMs: 650_000,
      seed: 1,
    });
    const oversizeMs = oversize.plan.entries.reduce(
      (max, entry) =>
        Math.max(max, entry.timelineStartMs + (entry.sourceEndMs - entry.sourceStartMs)),
      0,
    );
    expect(oversizeMs).toBeLessThanOrEqual(650_000 + 90_000);
    expect(oversize.plan.entries.length).toBeLessThanOrEqual(2);

    const shortCatalog = runtime();
    const start = seedTrack(shortCatalog, {
      title: "ShortStart",
      artist: "S",
      bpm: 174,
      camelot: "8A",
      energy: 6,
      durationMs: 150_000,
    });
    const ending = seedTrack(shortCatalog, {
      title: "ShortEnd",
      artist: "E",
      bpm: 174,
      camelot: "8A",
      energy: 6,
      durationMs: 150_000,
    });
    stubDescriptors(shortCatalog, start, { energy: 0.7 });
    stubDescriptors(shortCatalog, ending, { energy: 0.7 });
    for (let i = 0; i < 14; i += 1) {
      const id = seedTrack(shortCatalog, {
        title: `Fat ${i}`,
        artist: `Fat ${i}`,
        bpm: 174,
        camelot: "8A",
        energy: 6,
        durationMs: 400_000,
      });
      stubDescriptors(shortCatalog, id, { energy: 0.7 });
    }
    const refused = createPlan(shortCatalog, {
      name: "Refuse fat extra",
      targetDurationMs: 500_000,
      startTrackId: start,
      endTrackId: ending,
      seed: 1,
    });
    expect(refused.plan.entries.map((entry) => entry.trackId)).toEqual([start, ending]);
    expect(refused.partial).toBe(false);
  });

  it("keeps Peak and Liquid example briefs deterministic on a fixed fixture", () => {
    const peakBrief = JSON.parse(
      readFileSync(path.join(process.cwd(), "docs/examples/peak-hour.example.brief.json"), "utf8"),
    ) as CreateSetPlanInput;
    const liquidBrief = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "docs/examples/liquid-hour.example.brief.json"),
        "utf8",
      ),
    ) as CreateSetPlanInput;
    const catalog = runtime();
    for (let i = 0; i < 48; i += 1) {
      const id = seedTrack(catalog, {
        title: `Fixture ${i}`,
        artist: `Act ${i % 12}`,
        bpm: 174,
        camelot: `${(i % 12) + 1}A`,
        energy: 4 + (i % 6),
        durationMs: 180_000,
        genres: i % 11 === 0 ? ["idm"] : ["drum and bass"],
      });
      stubDescriptors(catalog, id, {
        energy: 0.25 + (i % 10) * 0.07,
        danceability: 0.4 + (i % 8) * 0.06,
        melodicness: 0.2 + (i % 9) * 0.08,
      });
    }
    const peakA = createPlan(catalog, { ...peakBrief, targetDurationMs: 900_000 });
    const peakB = createPlan(catalog, { ...peakBrief, targetDurationMs: 900_000 });
    const liquidA = createPlan(catalog, { ...liquidBrief, targetDurationMs: 900_000 });
    const liquidB = createPlan(catalog, { ...liquidBrief, targetDurationMs: 900_000 });
    expect(peakA.plan.entries.map((entry) => entry.trackId)).toEqual(
      peakB.plan.entries.map((entry) => entry.trackId),
    );
    expect(liquidA.plan.entries.map((entry) => entry.trackId)).toEqual(
      liquidB.plan.entries.map((entry) => entry.trackId),
    );
    expect(peakA.explanation.selected[0]?.buckets).toMatchObject({
      moodFit: expect.any(Number) as unknown,
      joinQuality: expect.any(Number) as unknown,
      keyCoverage: expect.any(Number) as unknown,
      timeFit: expect.any(Number) as unknown,
      lookahead: expect.any(Number) as unknown,
      feedback: expect.any(Number) as unknown,
    });
  });
});
