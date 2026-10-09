import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCatalogRuntime } from "../src/index.ts";
import { buildPlanningPool } from "../src/planning/pool.ts";
import { reportSetPlanQuality, type TrackQualityEvidence } from "../src/planning/quality.ts";
import { validateSetPlan } from "../src/planning/validate.ts";
import type { TimelineAnalysis } from "../src/planning/timeline.ts";
import {
  DSP_ANALYZER_NAME,
  type AppConfig,
  type SetPlanV1,
  type Track,
  type TrackSection,
} from "@dnb-crate/domain";

/** Hardening tests for the failure signatures confirmed by the 2026-10
 * listening sessions: unstable grids in the pool, edition-variant duplicates,
 * entries whose body cannot host both join regions, and stale alignment pins
 * surviving window edits. */

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
    `dnb-hardening-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const created = createCatalogRuntime(testConfig(root));
  cleanups.push(() => created.close());
  return created;
}

function seedTrack(
  catalog: ReturnType<typeof runtime>,
  spec: { title: string; artist: string; camelot?: string; durationMs?: number },
): string {
  const id = crypto.randomUUID();
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
    bpm: 174,
    bpmSource: "manual",
    musicalKey: "xmin",
    camelotKey: spec.camelot ?? "8A",
    keySource: "manual",
  });
  catalog.service.updateTrackMetadata(id, {
    energy: 5,
    rating: 4,
    moods: ["liquid"],
    subgenres: ["liquid"],
  });
  return id;
}

function stubAnalysis(
  catalog: ReturnType<typeof runtime>,
  trackId: string,
  tempoStability: number | null,
): void {
  catalog.analyses.upsert({
    trackId,
    analyzerName: DSP_ANALYZER_NAME,
    analyzerVersion: "3.0.0",
    bpm: 174,
    bpmConfidence: 0.9,
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
    tempoStability,
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
      shortTermRmsDbfsMean: null,
      shortTermRmsDbfsMax: null,
      truePeakDb: null,
      subBassRatio: 0.5,
      brightness: 0.1,
      onsetDensity: null,
      dynamicRange: null,
      dropIntensity: null,
      suggestedEnergy: 6,
      energy: null,
      danceability: null,
      acousticness: null,
      melodicness: null,
      valence: null,
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

function plainTrack(id: string, title: string, artist?: string): Track {
  return {
    id,
    filePath: `${title}.wav`,
    fileFingerprint: title,
    artist: artist ?? title,
    title,
    album: null,
    durationMs: 180_000,
    sampleRateHz: 44100,
    channels: 2,
    bpm: 174,
    bpmSource: "manual",
    musicalKey: "Am",
    camelotKey: "8A",
    keySource: "manual",
    energy: 5,
    rating: 4,
    subgenres: [],
    moods: [],
    tags: [],
    notes: null,
    analysisStatus: "complete",
    fileMissing: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function timelineAnalysis(stability: number | null): TimelineAnalysis {
  const sections: TrackSection[] = [];
  return {
    gridOk: true,
    bpm: 174,
    canonicalBpm: 174,
    bpmHint: null,
    bpmHintConfidence: null,
    suggestedEnergy: 6,
    introStartMs: null,
    outroStartMs: null,
    outroEndMs: null,
    introLenMs: null,
    outroLenMs: null,
    sections,
    downbeatTimesMs: [],
    downbeatConfidence: null,
    headEnergy: null,
    tailEnergy: null,
    integratedLufs: null,
    keyConfidence: null,
    audioStartMs: null,
    audioEndMs: null,
    mixInMs: null,
    mixOutMs: null,
    tempoStability: stability,
  };
}

describe("pool rejects unstable grids (2026-10 sessions)", () => {
  it("drops tracks below the stability floor and keeps stable ones", () => {
    const stable = Array.from({ length: 13 }, (_, i) => plainTrack(`s${i}`, `Stable ${i}`));
    const wobbly = plainTrack("wob", "Wobbly Grid");
    const analyses = new Map<string, TimelineAnalysis>();
    for (const track of stable) analyses.set(track.id, timelineAnalysis(0.9));
    analyses.set(wobbly.id, timelineAnalysis(0.18));
    const pool = buildPlanningPool(
      [...stable, wobbly],
      { name: "brief", targetDurationMinutes: 30 },
      {
        analyses,
        requiredIds: [],
        targetDurationMs: 30 * 60_000,
      },
    );
    expect(pool.pool.some((track) => track.id === "wob")).toBe(false);
    expect(
      pool.rejected.some((row) => row.trackId === "wob" && row.reason === "UNSTABLE_GRID"),
    ).toBe(true);
    expect(pool.pool).toHaveLength(stable.length);
  });

  it("treats a missing stability reading as unknown rather than unstable", () => {
    const unknown = plainTrack("unk", "Unknown Grid");
    const pool = buildPlanningPool(
      [unknown],
      { name: "brief", targetDurationMinutes: 1 },
      {
        analyses: new Map([[unknown.id, timelineAnalysis(null)]]),
        requiredIds: [],
        targetDurationMs: 60_000,
      },
    );
    expect(pool.pool.some((track) => track.id === "unk")).toBe(true);
  });
});

describe("plan quality flags bodies thinner than their join regions", () => {
  const join = (durationMs: number) => ({
    id: crypto.randomUUID(),
    type: "phrase_mix" as const,
    durationMs,
    outgoingCuePointId: null,
    incomingCuePointId: null,
    parameters: {
      barCount: 16,
      reason: "matched-grid-phrase",
      targetBpm: 174,
      phraseShape: "sequential",
      sequentialHandoff: "supported",
      intent: "sustain",
    },
  });

  function threeTrackPlan(middleBodyMs: number, joinMs: number): SetPlanV1 {
    return {
      schemaVersion: 1,
      id: "plan",
      name: "body fixture",
      targetDurationMs: 260_000,
      targetBpm: null,
      requestedArc: [{ atFraction: 0, targetEnergy: 5 }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      entries: [
        {
          id: "e0",
          trackId: "a",
          order: 0,
          sourceStartMs: 0,
          sourceEndMs: 120_000,
          timelineStartMs: 0,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: join(joinMs),
        },
        {
          id: "e1",
          trackId: "b",
          order: 1,
          sourceStartMs: 10_000,
          sourceEndMs: 10_000 + middleBodyMs,
          timelineStartMs: 90_000,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: join(joinMs),
        },
        {
          id: "e2",
          trackId: "c",
          order: 2,
          sourceStartMs: 0,
          sourceEndMs: 120_000,
          timelineStartMs: 180_000,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: null,
        },
      ],
    };
  }

  function quality(plan: SetPlanV1) {
    const tracksById = new Map<string, Track>([
      ["a", plainTrack("a", "A")],
      ["b", plainTrack("b", "B")],
      ["c", plainTrack("c", "C")],
    ]);
    const evidenceByTrackId = new Map<string, TrackQualityEvidence>();
    for (const track of tracksById.values()) {
      evidenceByTrackId.set(track.id, {
        musicalKey: track.musicalKey,
        camelotKey: track.camelotKey,
        keySource: track.keySource,
        keyConfidence: 1,
        keyAnalyzerName: "keyfinder",
        nativeBpm: track.bpm,
        gridOk: true,
        gridEngine: "dnb-crate-dsp",
      });
    }
    return reportSetPlanQuality({
      plan,
      tracksById,
      evidenceByTrackId,
      validation: validateSetPlan(plan, tracksById),
    });
  }

  it("warns and fails checks when head+tail joins consume the body", () => {
    const q = quality(threeTrackPlan(100_000, 60_000));
    expect(q.entryBodyWarnings).toHaveLength(1);
    expect(q.entryBodyWarnings[0]!.order).toBe(1);
    expect(q.entryBodyWarnings[0]!.bodyMs).toBe(100_000);
    expect(q.entryBodyWarnings[0]!.joinRegionsMs).toBe(120_000);
    expect(q.partialReasons).toContain("ENTRY_BODY");
    expect(q.qualityChecksPassed).toBe(false);
  });

  it("stays quiet when every body hosts its join regions", () => {
    const q = quality(threeTrackPlan(120_000, 22_069));
    expect(q.entryBodyWarnings).toHaveLength(0);
    expect(q.partialReasons).not.toContain("ENTRY_BODY");
  });
});

describe("edition variants cannot both be planned", () => {
  it("validation rejects two editions of the same production", () => {
    const tracksById = new Map<string, Track>([
      [
        "radio",
        {
          ...plainTrack("radio", "Heartbeat Loud", "Andy C"),
          recordingKey: "sig:a|heartbeat loud|90",
        },
      ],
      [
        "extended",
        {
          ...plainTrack("extended", "Heartbeat Loud - Extended Version", "Andy C"),
          recordingKey: "sig:a|heartbeat loud - extended version|110",
          durationMs: 220_000,
        },
      ],
    ]);
    const plan: SetPlanV1 = {
      schemaVersion: 1,
      id: "plan",
      name: "variants",
      targetDurationMs: 300_000,
      targetBpm: null,
      requestedArc: [{ atFraction: 0, targetEnergy: 5 }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      entries: [
        {
          id: "e0",
          trackId: "radio",
          order: 0,
          sourceStartMs: 0,
          sourceEndMs: 120_000,
          timelineStartMs: 0,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: {
            id: "t0",
            type: "phrase_mix",
            durationMs: 22_069,
            outgoingCuePointId: null,
            incomingCuePointId: null,
            parameters: { barCount: 16, reason: "matched-grid-phrase" },
          },
        },
        {
          id: "e1",
          trackId: "extended",
          order: 1,
          sourceStartMs: 0,
          sourceEndMs: 120_000,
          timelineStartMs: 100_000,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: null,
        },
      ],
    };
    const result = validateSetPlan(plan, tracksById);
    expect(result.errors.some((issue) => issue.code === "DUPLICATE_RECORDING_FAMILY")).toBe(true);
  });

  it("the planner never plans both editions of one production", () => {
    const catalog = runtime();
    const radio = seedTrack(catalog, {
      title: "Heartbeat Loud",
      artist: "Andy C",
      durationMs: 180_000,
    });
    const extended = seedTrack(catalog, {
      title: "Heartbeat Loud - Extended Version",
      artist: "Andy C",
      durationMs: 220_000,
    });
    stubAnalysis(catalog, radio, 0.95);
    stubAnalysis(catalog, extended, 0.95);
    for (let i = 0; i < 14; i += 1) {
      const id = seedTrack(catalog, {
        title: `Filler ${i}`,
        artist: `Filler Artist ${i}`,
        camelot: i % 2 === 0 ? "8A" : "9A",
      });
      stubAnalysis(catalog, id, 0.95);
    }
    // Long enough that every track competes for a slot across several seeds.
    for (const seed of [1, 7, 13]) {
      const created = catalog.service.createSetPlan({
        name: `variants ${seed}`,
        targetDurationMs: 1_200_000,
        seed,
        qualityPolicy: "off",
      });
      const planned = new Set(created.plan.entries.map((entry) => entry.trackId));
      expect(planned.has(radio) && planned.has(extended)).toBe(false);
    }
  });
});

describe("energy-death continuity gates strict quality (2026-10 sessions)", () => {
  const join = (valley: number | null, coexist: number | null) => ({
    id: crypto.randomUUID(),
    type: "phrase_mix" as const,
    durationMs: 22_069,
    outgoingCuePointId: null,
    incomingCuePointId: null,
    parameters: {
      barCount: 16,
      reason: "matched-grid-phrase",
      targetBpm: 174,
      phraseShape: "landing",
      sequentialHandoff: "supported",
      intent: "sustain",
      ...(valley != null ? { continuityValleyBars: valley } : {}),
      ...(coexist != null ? { continuityCoexistenceBars: coexist } : {}),
      ...(valley != null ? { continuityEvidence: "relative-bar-energy-proxy" } : {}),
    },
  });

  function twoEntryPlan(
    valley: number | null,
    coexist: number | null,
    policy: "strict" | "off",
  ): SetPlanV1 {
    return {
      schemaVersion: 1,
      id: "plan",
      name: "continuity fixture",
      targetDurationMs: 260_000,
      targetBpm: null,
      requestedArc: [{ atFraction: 0, targetEnergy: 5 }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      qualityPolicy: policy,
      entries: [
        {
          id: "e0",
          trackId: "a",
          order: 0,
          sourceStartMs: 0,
          sourceEndMs: 120_000,
          timelineStartMs: 0,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: join(valley, coexist),
        },
        {
          id: "e1",
          trackId: "b",
          order: 1,
          sourceStartMs: 0,
          sourceEndMs: 120_000,
          timelineStartMs: 100_000,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: null,
        },
      ],
    };
  }

  function qualityOf(plan: SetPlanV1) {
    const tracksById = new Map<string, Track>([
      ["a", plainTrack("a", "A")],
      ["b", plainTrack("b", "B")],
    ]);
    const evidenceByTrackId = new Map<string, TrackQualityEvidence>();
    for (const track of tracksById.values()) {
      evidenceByTrackId.set(track.id, {
        musicalKey: track.musicalKey,
        camelotKey: track.camelotKey,
        keySource: track.keySource,
        keyConfidence: 1,
        keyAnalyzerName: "keyfinder",
        nativeBpm: track.bpm,
        gridOk: true,
        gridEngine: "dnb-crate-dsp",
      });
    }
    return reportSetPlanQuality({
      plan,
      tracksById,
      evidenceByTrackId,
      validation: validateSetPlan(plan, tracksById),
    });
  }

  it.each([
    ["Colour Me In -> Cola (night drive)", 8.1, 8],
    ["I Need -> Push The Tempo (night drive)", 12.81, 5],
    ["Zephyr exits (high gear drafts)", 6.58, 1],
    ["second-drop Searching entry", 4.15, 3],
  ])("flags the audited failure %s", (_label, valley, coexist) => {
    const q = qualityOf(twoEntryPlan(valley, coexist, "strict"));
    expect(q.joins[0]!.energyContinuityIssue).toBe(true);
    expect(q.partialReasons).toContain("JOIN_CONTINUITY");
    expect(q.qualityChecksPassed).toBe(false);
    expect(q.readyForAudition).toBe(false);
  });

  it.each([
    ["Stronger -> So Many Colours (night drive)", 2.9, 18],
    ["Gifted Lover -> Somewhere Between (evening liquid)", 1.78, 10],
    ["Into Your Arms -> Say My Name (high gear)", 1.74, 6],
    ["Heartbeat Loud -> Atmosphere (high gear)", 2.12, 15],
  ])("passes the owner-approved join %s", (_label, valley, coexist) => {
    const q = qualityOf(twoEntryPlan(valley, coexist, "strict"));
    expect(q.joins[0]!.energyContinuityIssue).toBe(false);
    expect(q.partialReasons).not.toContain("JOIN_CONTINUITY");
  });

  it("never flags without measured continuity, and drafts bypass the gate", () => {
    expect(qualityOf(twoEntryPlan(null, null, "strict")).joins[0]!.energyContinuityIssue).toBe(
      false,
    );
    const draft = qualityOf(twoEntryPlan(12.81, 5, "off"));
    expect(draft.joins[0]!.energyContinuityIssue).toBe(true);
    expect(draft.partialReasons).not.toContain("JOIN_CONTINUITY");
  });
});

describe("window edits invalidate recorded alignment pins", () => {
  function pinnedPlan(catalog: ReturnType<typeof runtime>): string {
    for (let i = 0; i < 14; i += 1) {
      const id = seedTrack(catalog, {
        title: `Pin ${i}`,
        artist: `Pin Artist ${i}`,
        camelot: i % 2 === 0 ? "8A" : "9A",
      });
      stubAnalysis(catalog, id, 0.95);
    }
    const created = catalog.service.createSetPlan({
      name: "pins",
      targetDurationMs: 600_000,
      seed: 3,
      qualityPolicy: "off",
    });
    const first = created.plan.entries[0]!;
    catalog.service.updateSetPlan({
      setPlanId: created.plan.id,
      setTransition: {
        entryId: first.id,
        type: "phrase_mix",
        durationMs: first.transitionToNext!.durationMs,
        parameters: {
          ...first.transitionToNext!.parameters,
          incomingTrackId: created.plan.entries[1]!.trackId,
          downbeatOffsetMs: -40,
          alignmentPeriodMs: 1379.31,
          alignmentMode: "bar",
          onsetLockBeats: 3,
          recipeVersion: 1,
        },
      },
    });
    return created.plan.id;
  }

  it("keeps pins on a no-op trim and drops them when the window moves", () => {
    const catalog = runtime();
    const planId = pinnedPlan(catalog);
    const entry = catalog.service.requirePlan(planId).plan.entries[0]!;

    const noop = catalog.service.updateSetPlan({
      setPlanId: planId,
      setTrim: {
        entryId: entry.id,
        sourceStartMs: entry.sourceStartMs,
        sourceEndMs: entry.sourceEndMs,
      },
    });
    const afterNoop = noop.plan.entries[0]!.transitionToNext!.parameters;
    expect(afterNoop.downbeatOffsetMs).toBe(-40);
    expect(afterNoop.recipeVersion).toBe(1);

    const moved = catalog.service.updateSetPlan({
      setPlanId: planId,
      setTrim: {
        entryId: entry.id,
        sourceStartMs: entry.sourceStartMs + 5_000,
        sourceEndMs: entry.sourceEndMs,
      },
    });
    const afterMove = moved.plan.entries[0]!.transitionToNext!.parameters;
    expect(afterMove.downbeatOffsetMs).toBeUndefined();
    expect(afterMove.alignmentPeriodMs).toBeUndefined();
    expect(afterMove.alignmentMode).toBeUndefined();
    expect(afterMove.onsetLockBeats).toBeUndefined();
    expect(afterMove.alignmentInvalidated).toBe("window-edited");
  });
});
