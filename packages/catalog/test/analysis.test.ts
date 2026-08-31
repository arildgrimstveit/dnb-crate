import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildClickTrackPcm, encodeMonoWav } from "@dnb-crate/audio-analysis";
import type { AppConfig, SetPlanV1 } from "@dnb-crate/domain";

import { createCatalogRuntime, writeSineWav } from "../src/index.ts";

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

describe("track analysis and aligned transitions", () => {
  it("analyzes a 174 BPM click track and keeps manual BPM over the analyzer", async () => {
    const root = path.join(
      os.tmpdir(),
      `dnb-an-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, { useFakeFfmpeg: true });
    cleanups.push(() => catalog.close());
    const pcm = buildClickTrackPcm({ bpm: 174, durationMs: 12_000 });
    await writeFile(path.join(library, "click.wav"), encodeMonoWav(pcm));
    await catalog.service.scanLibrary();
    const track = catalog.service.searchTracks({ query: "click", limit: 1 }).tracks[0]!;
    catalog.service.updateTrackMetadata(track.id, { bpm: 170, energy: 8 });
    const started = catalog.service.startTrackAnalysis({ trackIds: [track.id] });
    const done = await catalog.service.waitForAnalysisJob(started.job.id, 20_000);
    expect(done.status).toBe("succeeded");
    const analysis = catalog.service.getTrackAnalysis(track.id);
    expect(analysis.gridRejected).toBe(false);
    expect(Math.abs((analysis.bpm ?? 0) - 174)).toBeLessThan(0.5);
    expect(analysis.canonicalBpm).toBe(170);
    expect(analysis.canonicalBpmSource).toBe("manual");
    expect(analysis.suggestedCues.length).toBeGreaterThan(0);
  });

  it("ranks bass_swap when energy rises and blocks aligned render on a rejected grid", async () => {
    const root = path.join(
      os.tmpdir(),
      `dnb-tr-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, { useFakeFfmpeg: true });
    cleanups.push(() => catalog.close());
    await writeSineWav(path.join(library, "alpha.wav"), {
      title: "Alpha",
      artist: "A",
      durationMs: 8000,
    });
    await writeSineWav(path.join(library, "bravo.wav"), {
      title: "Bravo",
      artist: "B",
      durationMs: 8000,
    });
    await catalog.service.scanLibrary();
    const tracks = catalog.service.searchTracks({ limit: 10 }).tracks;
    const alpha = tracks.find((item) => item.title === "Alpha")!;
    const bravo = tracks.find((item) => item.title === "Bravo")!;
    catalog.service.updateTrackMetadata(alpha.id, { energy: 4, bpm: 174 });
    catalog.service.updateTrackMetadata(bravo.id, { energy: 9, bpm: 174 });
    const started = catalog.service.startTrackAnalysis({
      trackIds: [alpha.id, bravo.id],
    });
    await catalog.service.waitForAnalysisJob(started.job.id, 20_000);
    const planned = catalog.service.planTransition({
      outgoingTrackId: alpha.id,
      incomingTrackId: bravo.id,
      preferredType: "any",
      barCount: 16,
    });
    expect(planned.proposals[0]?.type).toBe("bass_swap");
    const validated = catalog.service.validateTransition({
      outgoingTrackId: alpha.id,
      incomingTrackId: bravo.id,
      type: "phrase_mix",
      barCount: 16,
    });
    expect(validated.valid).toBe(false);

    const transitionId = crypto.randomUUID();
    const plan: SetPlanV1 = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      name: "Aligned block",
      targetDurationMs: 15_000,
      targetBpm: 174,
      requestedArc: [
        { atFraction: 0, targetEnergy: 3 },
        { atFraction: 1, targetEnergy: 9 },
      ],
      entries: [
        {
          id: crypto.randomUUID(),
          trackId: alpha.id,
          order: 0,
          sourceStartMs: 0,
          sourceEndMs: 8000,
          timelineStartMs: 0,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: {
            id: transitionId,
            type: "phrase_mix",
            durationMs: 2000,
            outgoingCuePointId: null,
            incomingCuePointId: null,
            parameters: {},
          },
        },
        {
          id: crypto.randomUUID(),
          trackId: bravo.id,
          order: 1,
          sourceStartMs: 0,
          sourceEndMs: 8000,
          timelineStartMs: 6000,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: null,
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    catalog.setPlans.save(plan, 1, { seed: 1, selected: [], rejected: [] });
    await expect(catalog.service.startSetRender({ setPlanId: plan.id })).rejects.toMatchObject({
      code: "INVALID_SET_PLAN",
    });
    const crossfade = catalog.service.updateSetPlan({
      setPlanId: plan.id,
      setTransition: { entryId: plan.entries[0]!.id, type: "crossfade", durationMs: 1000 },
    });
    expect(crossfade.plan.entries[0]?.transitionToNext?.type).toBe("crossfade");
    const startedRender = await catalog.service.startSetRender({ setPlanId: plan.id });
    const done = await catalog.service.waitForRenderJob(startedRender.job.id, 15_000);
    expect(done.status).toBe("succeeded");
  });
});
