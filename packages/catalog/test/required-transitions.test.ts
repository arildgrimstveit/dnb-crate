import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCatalogRuntime } from "../src/index.ts";
import { compilePlanningConstraints } from "../src/planning/constraints.ts";
import {
  DSP_ANALYZER_NAME,
  reusableRecipeFingerprint,
  reusableRecipeFromJoin,
  type AppConfig,
  type SonicDescriptors,
} from "@dnb-crate/domain";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function runtime() {
  const root = path.join(
    os.tmpdir(),
    `dnb-req-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const created = createCatalogRuntime({
    databasePath: path.join(root, "catalog.sqlite"),
    libraryRoots: [path.join(root, "library")],
    outputRoot: path.join(root, "output"),
    logLevel: "error",
    supportedExtensions: [".wav", ".flac", ".mp3", ".m4a", ".aiff", ".aif"],
  } satisfies AppConfig);
  cleanups.push(() => created.close());
  return created;
}

function seedTrack(
  catalog: ReturnType<typeof runtime>,
  spec: {
    title: string;
    artist: string;
    camelot: string;
    durationMs?: number;
    energy?: number;
    rating?: number;
    moods?: string[];
  },
): string {
  const id = crypto.randomUUID();
  catalog.repository.upsertFromScan({
    id,
    filePath: path.join("C:", "virtual", `${spec.title}.wav`),
    fileFingerprint: spec.title,
    artist: spec.artist,
    title: spec.title,
    album: null,
    durationMs: spec.durationMs ?? 180_000,
    sampleRateHz: 44100,
    channels: 2,
    bpm: 174,
    bpmSource: "manual",
    musicalKey: spec.camelot.endsWith("A") ? "Am" : "C",
    camelotKey: spec.camelot,
    keySource: "manual",
  });
  catalog.service.updateTrackMetadata(id, {
    energy: spec.energy ?? 6,
    rating: spec.rating ?? 4,
    moods: spec.moods ?? ["liquid"],
    subgenres: ["liquid"],
  });
  catalog.analyses.upsert({
    trackId: id,
    analyzerName: DSP_ANALYZER_NAME,
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
      subBassRatio: 0.5,
      brightness: 0.1,
      onsetDensity: null,
      dynamicRange: null,
      dropIntensity: null,
      suggestedEnergy: spec.energy ?? 6,
      energy: (spec.energy ?? 6) / 10,
      danceability: 0.5,
      acousticness: 0.2,
      melodicness: 0.5,
      valence: 0.5,
      waveformSummary: [],
      lowBandEnergy: null,
      midBandEnergy: null,
      highBandEnergy: null,
      chromaVector: null,
      tempoEvidence: null,
    } satisfies SonicDescriptors,
    engineRuntimeMs: 1,
    analyzedAt: new Date().toISOString(),
    suggestedCues: [],
    sections: [],
  });
  return id;
}

describe("required transitions and strict quality", () => {
  it("rejects two predecessors and conflicting duplicate declarations", () => {
    const row = {
      outgoingTrackId: "a",
      incomingTrackId: "c",
      strength: "required" as const,
      reuse: "pair" as const,
    };
    expect(() => compilePlanningConstraints([row, { ...row, outgoingTrackId: "b" }])).toThrow(
      "predecessors",
    );
    expect(() => compilePlanningConstraints([row, { ...row, strength: "preferred" }])).toThrow(
      "Conflicting",
    );
    expect(
      compilePlanningConstraints([{ ...row, strength: "preferred" }]).lockedTrackIds.size,
    ).toBe(0);
  });

  it("does not reinsert explicitly excluded pinned tracks", () => {
    const catalog = runtime();
    const a = seedTrack(catalog, { title: "A", artist: "A", camelot: "8A" });
    const b = seedTrack(catalog, { title: "B", artist: "B", camelot: "8A" });
    expect(() =>
      catalog.service.createSetPlan({
        name: "conflict",
        excludedTrackIds: [b],
        requiredTransitions: [
          { outgoingTrackId: a, incomingTrackId: b, strength: "required", reuse: "pair" },
        ],
      }),
    ).toThrow("excluded or missing");
  });
  it("keeps an unconstrained seed free of a weaker neighbour", () => {
    const catalog = runtime();
    const start = seedTrack(catalog, { title: "Start", artist: "A", camelot: "8A" });
    const waiting = seedTrack(catalog, { title: "Next", artist: "B", camelot: "9A" });
    seedTrack(catalog, { title: "Same Key", artist: "C", camelot: "8A" });
    seedTrack(catalog, { title: "Filler", artist: "D", camelot: "8A" });
    const created = catalog.service.createSetPlan({
      name: "free",
      targetDurationMs: 400_000,
      startTrackId: start,
      seed: 1,
    });
    expect(created.plan.entries[0]?.trackId).toBe(start);
    expect(created.plan.entries[1]?.trackId).not.toBe(waiting);
    expect(created.quality.qualityPolicy).toBe("strict");
  });

  it("places a required pair and applies a pinned recipe", () => {
    const catalog = runtime();
    const start = seedTrack(catalog, { title: "Start", artist: "A", camelot: "8A" });
    const waiting = seedTrack(catalog, { title: "Next", artist: "B", camelot: "9A" });
    seedTrack(catalog, { title: "Same Key", artist: "C", camelot: "8A" });
    seedTrack(catalog, { title: "Filler", artist: "D", camelot: "7A" });
    const body = reusableRecipeFromJoin({
      outgoingTrackId: start,
      incomingTrackId: waiting,
      outgoingSourceFingerprint: "Start",
      incomingSourceFingerprint: "Next",
      outgoingSourceStartMs: 0,
      outgoingSourceEndMs: 90_000,
      incomingSourceStartMs: 0,
      incomingSourceEndMs: 90_000,
      outgoingRate: 1,
      incomingRate: 1,
      outgoingGainDb: 0,
      incomingGainDb: 0,
      transition: {
        id: crypto.randomUUID(),
        type: "phrase_mix",
        durationMs: 22_069,
        outgoingCuePointId: null,
        incomingCuePointId: null,
        parameters: {
          barCount: 32,
          phraseShape: "landing",
          intent: "sustain",
          sequentialHandoff: "supported",
          mixInMs: 1000,
          mixOutMs: 67_931,
          targetBpm: 174,
          rateRegionsVersion: 2,
        },
      },
      engine: { rendererVersion: "6.13.0", tempoEngine: "rubberband-r3", stretchScope: "overlap" },
    });
    const imported = catalog.service.importApprovedRecipe({
      status: "protected_reference",
      pairKey: `${start}:${waiting}`,
      reusableFingerprint: reusableRecipeFingerprint(body),
      payload: body,
      heardRenderFingerprint: "heard",
      renderJobId: null,
      transitionId: null,
      setPlanId: null,
      outgoingTitle: "Start",
      incomingTitle: "Next",
      note: "pinned 32-bar landing",
    });
    expect(imported.inserted).toBe(true);
    const created = catalog.service.createSetPlan({
      name: "required next",
      targetDurationMs: 250_000,
      startTrackId: start,
      seed: 1,
      requiredTransitions: [
        {
          outgoingTrackId: start,
          incomingTrackId: waiting,
          recipeId: imported.recipe.id,
          strength: "required",
          reuse: "recipe",
        },
      ],
    });
    expect(created.plan.entries[0]?.trackId).toBe(start);
    expect(created.plan.entries[1]?.trackId).toBe(waiting);
    const join = created.quality.joins[0];
    expect(join?.recipeStatus).toBe("applied");
    expect(join?.constraintSatisfaction).toBe("satisfied");
    expect(
      String(created.plan.entries[0]?.transitionToNext?.parameters.selectionReason ?? ""),
    ).toContain("approved");
    const entry = created.plan.entries[0]!;
    const edited = catalog.service.updateSetPlan({
      setPlanId: created.plan.id,
      setTransition: {
        entryId: entry.id,
        type: "phrase_mix",
        durationMs: entry.transitionToNext!.durationMs,
        parameters: { ...entry.transitionToNext!.parameters, midDipDb: -19 },
      },
    });
    expect(edited.quality.joins[0]?.recipeStatus).toBe("stale");
    expect(edited.quality.readyForAudition).toBe(false);
    expect(edited.partial).toBe(true);
    expect(() => catalog.service.startSetRender({ setPlanId: created.plan.id })).toThrow(
      "not ready",
    );
    expect(catalog.service.reportSetPlanQuality(created.plan.id).readyForAudition).toBe(false);
  });

  it("rejects cyclic required transitions", () => {
    const catalog = runtime();
    const a = seedTrack(catalog, { title: "A", artist: "A", camelot: "8A" });
    const b = seedTrack(catalog, { title: "B", artist: "B", camelot: "8A" });
    expect(() =>
      catalog.service.createSetPlan({
        name: "cycle",
        targetDurationMs: 250_000,
        startTrackId: a,
        requiredTransitions: [
          { outgoingTrackId: a, incomingTrackId: b, strength: "required", reuse: "pair" },
          { outgoingTrackId: b, incomingTrackId: a, strength: "required", reuse: "pair" },
        ],
      }),
    ).toThrow(/cycle/i);
  });

  it("skips short files that cannot host version-2 head and tail regions", () => {
    const catalog = runtime();
    const start = seedTrack(catalog, {
      title: "Open",
      artist: "A",
      camelot: "8A",
      durationMs: 180_000,
    });
    seedTrack(catalog, { title: "Tiny", artist: "B", camelot: "8A", durationMs: 40_000 });
    seedTrack(catalog, { title: "Filler", artist: "C", camelot: "8A", durationMs: 180_000 });
    const created = catalog.service.createSetPlan({
      name: "short-skip",
      targetDurationMs: 250_000,
      startTrackId: start,
      seed: 1,
    });
    const ids = created.plan.entries.map((entry) => entry.trackId);
    expect(ids[0]).toBe(start);
    expect(ids).not.toContain(
      catalog.repository.listAll().find((track) => track.title === "Tiny")?.id,
    );
  });

  it("uses a chain-aware retry when local repair cannot bridge a distant required pair", () => {
    const catalog = runtime();
    const start = seedTrack(catalog, {
      title: "Open",
      artist: "A",
      camelot: "8A",
      energy: 9,
      rating: 5,
    });
    for (let i = 0; i < 8; i += 1) {
      seedTrack(catalog, {
        title: `Stay ${i}`,
        artist: `Stay ${i}`,
        camelot: "8A",
        energy: 9,
        rating: 5,
      });
    }
    for (const [title, key] of [
      ["Nine", "9A"],
      ["Ten", "10A"],
      ["Eleven", "11A"],
      ["Twelve", "12A"],
    ] as const) {
      seedTrack(catalog, { title, artist: title, camelot: key, energy: 2, rating: 1, moods: [] });
    }
    const farA = seedTrack(catalog, { title: "Far A", artist: "Far A", camelot: "1A" });
    const farB = seedTrack(catalog, { title: "Far B", artist: "Far B", camelot: "1A" });
    const created = catalog.service.createSetPlan({
      name: "chain-retry",
      targetDurationMs: 500_000,
      startTrackId: start,
      seed: 1,
      preferredMoods: ["liquid"],
      requiredTransitions: [
        { outgoingTrackId: farA, incomingTrackId: farB, strength: "required", reuse: "pair" },
      ],
    });
    const ids = created.plan.entries.map((entry) => entry.trackId);
    expect(created.explanation.chainRetry).toBeDefined();
    expect(created.explanation.chainRetry?.priorRepairSearch?.status).toBe("harmonic-gap");
    expect(ids.includes(farA) && ids[ids.indexOf(farA) + 1] === farB).toBe(true);
  });

  it("stops instead of relaxing artist spacing under strict quality", () => {
    const catalog = runtime();
    const start = seedTrack(catalog, { title: "Open", artist: "Same", camelot: "8A" });
    const same = seedTrack(catalog, { title: "Again", artist: "Same", camelot: "8A" });
    const ending = seedTrack(catalog, { title: "End", artist: "Other", camelot: "8A" });
    const created = catalog.service.createSetPlan({
      name: "spacing",
      targetDurationMs: 400_000,
      startTrackId: start,
      endTrackId: ending,
      artistRepeatSpacing: 1,
      seed: 1,
    });
    const ids = created.plan.entries.map((entry) => entry.trackId);
    expect(ids[0]).toBe(start);
    expect(ids.at(-1)).toBe(ending);
    expect(ids.includes(same) && ids[1] === same).toBe(false);
    expect(created.quality.partialReasons).toBeDefined();
  });
});
