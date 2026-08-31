import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCatalogRuntime } from "../src/index.ts";
import type { AppConfig } from "@dnb-crate/domain";

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
