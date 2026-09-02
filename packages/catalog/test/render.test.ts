import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig, SetPlanV1 } from "@dnb-crate/domain";
import { DSP_ANALYZER_NAME, DSP_ANALYZER_VERSION, RENDERER_VERSION } from "@dnb-crate/domain";
import { createFakeFfmpegRunner, ProcessRunError } from "@dnb-crate/audio-renderer";

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

async function seededLibrary() {
  const root = path.join(
    os.tmpdir(),
    `dnb-render-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const library = path.join(root, "library");
  const catalog = createCatalogRuntime(testConfig(root), undefined, { useFakeFfmpeg: true });
  cleanups.push(() => catalog.close());
  const aPath = path.join(library, "alpha.wav");
  const bPath = path.join(library, "bravo.wav");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(library, { recursive: true });
  await writeSineWav(aPath, { title: "Alpha", artist: "A", durationMs: 8000 });
  await writeSineWav(bPath, { title: "Bravo", artist: "B", durationMs: 8000 });
  await catalog.service.scanLibrary();
  const tracks = catalog.service.searchTracks({ limit: 50 }).tracks;
  const alpha = tracks.find((track) => track.title === "Alpha")!;
  const bravo = tracks.find((track) => track.title === "Bravo")!;
  const plan = saveTwoTrackPlan(catalog, alpha.id, bravo.id);
  return { catalog, plan, aPath, bPath, alpha, bravo };
}

function saveTwoTrackPlan(
  catalog: ReturnType<typeof createCatalogRuntime>,
  startId: string,
  endId: string,
): SetPlanV1 {
  const start = catalog.repository.findById(startId)!;
  const end = catalog.repository.findById(endId)!;
  const transitionId = crypto.randomUUID();
  const plan: SetPlanV1 = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: "Fixture mix",
    targetDurationMs: 15_000,
    targetBpm: 174,
    requestedArc: [
      { atFraction: 0, targetEnergy: 3 },
      { atFraction: 1, targetEnergy: 6 },
    ],
    entries: [
      {
        id: crypto.randomUUID(),
        trackId: start.id,
        order: 0,
        sourceStartMs: 0,
        sourceEndMs: start.durationMs,
        timelineStartMs: 0,
        playbackRate: 1,
        gainDb: 0,
        transitionToNext: {
          id: transitionId,
          type: "crossfade",
          durationMs: 1000,
          outgoingCuePointId: null,
          incomingCuePointId: null,
          parameters: { purpose: "stage3-test" },
        },
      },
      {
        id: crypto.randomUUID(),
        trackId: end.id,
        order: 1,
        sourceStartMs: 0,
        sourceEndMs: end.durationMs,
        timelineStartMs: start.durationMs - 1000,
        playbackRate: 1,
        gainDb: 0,
        transitionToNext: null,
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  catalog.setPlans.save(plan, 1, { seed: 1, selected: [], rejected: [] });
  return plan;
}

describe("render jobs", () => {
  it("queues a full render, completes, and keeps source bytes unchanged", async () => {
    const { catalog, plan, aPath } = await seededLibrary();
    const before = createHash("sha256")
      .update(await readFile(aPath))
      .digest("hex");
    const started = await catalog.service.startSetRender({ setPlanId: plan.id });
    expect(started.job.status === "queued" || started.job.status === "running").toBe(true);
    const done = await catalog.service.waitForRenderJob(started.job.id, 15_000);
    expect(done.status).toBe("succeeded");
    expect(done.outputRootRelativePath).toMatch(/^renders\//);
    expect(done.outputRootRelativePath).not.toMatch(/^[A-Za-z]:\\/);
    const manifest = catalog.service.getRenderManifest(done.id);
    expect(manifest.tracks).toHaveLength(2);
    expect(manifest.outputChecksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.invocation).not.toContain("alpha.wav");
    const after = createHash("sha256")
      .update(await readFile(aPath))
      .digest("hex");
    expect(after).toBe(before);
    const checked = await catalog.service.checkRender(done.id);
    expect(checked.ok).toBe(true);
    expect(checked.interiorSilence).toEqual([]);
    expect(checked.joins).toHaveLength(1);
  });

  it("rejects a changed fingerprint until rescan", async () => {
    const { catalog, plan, aPath } = await seededLibrary();
    await writeFile(aPath, Buffer.concat([await readFile(aPath), Buffer.from("x")]));
    await expect(catalog.service.startSetRender({ setPlanId: plan.id })).rejects.toMatchObject({
      code: "INVALID_SET_PLAN",
    });
    const validation = await catalog.service.validateSavedSetPlan(plan.id);
    expect(
      validation.renderReadiness?.issues.some((issue) => issue.code === "FINGERPRINT_MISMATCH"),
    ).toBe(true);
  });

  it("returns a cached preview for an identical second request", async () => {
    const { catalog, plan } = await seededLibrary();
    const transitionId = plan.entries[0]!.transitionToNext!.id;
    const first = await catalog.service.createTransitionPreview({
      setPlanId: plan.id,
      transitionId,
      windowMs: 30_000,
    });
    await catalog.service.waitForRenderJob(first.job.id, 15_000);
    const second = await catalog.service.createTransitionPreview({
      setPlanId: plan.id,
      transitionId,
      windowMs: 30_000,
    });
    expect(second.job.status).toBe("succeeded");
    expect(second.warnings.some((text) => /cached/i.test(text))).toBe(true);
    expect(second.job.outputRootRelativePath).toBe(
      catalog.service.getRenderStatus(first.job.id).outputRootRelativePath,
    );
  });

  it("cancels a running job by aborting the child process", async () => {
    const root = path.join(
      os.tmpdir(),
      `dnb-cancel-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const library = path.join(root, "library");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, {
      processRunner: createFakeFfmpegRunner({ hangUntilAbort: true }),
    });
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
    const tracks = catalog.service.searchTracks({ limit: 50 }).tracks;
    const plan = saveTwoTrackPlan(
      catalog,
      tracks.find((track) => track.title === "Alpha")!.id,
      tracks.find((track) => track.title === "Bravo")!.id,
    );
    const started = await catalog.service.startSetRender({ setPlanId: plan.id });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const cancelled = catalog.service.cancelRenderJob(started.job.id, true);
    expect(cancelled.cancelled).toBe(true);
    const done = await catalog.service.waitForRenderJob(started.job.id, 10_000);
    expect(done.status).toBe("cancelled");
  });

  it("fails start when FFmpeg is missing", async () => {
    const root = path.join(
      os.tmpdir(),
      `dnb-noff-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const library = path.join(root, "library");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, {
      processRunner: {
        run() {
          return Promise.reject(new ProcessRunError("spawn ffmpeg ENOENT", { code: "ENOENT" }));
        },
      },
    });
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
    const tracks = catalog.service.searchTracks({ limit: 50 }).tracks;
    const plan = saveTwoTrackPlan(
      catalog,
      tracks.find((track) => track.title === "Alpha")!.id,
      tracks.find((track) => track.title === "Bravo")!.id,
    );
    await expect(catalog.service.startSetRender({ setPlanId: plan.id })).rejects.toMatchObject({
      code: "FFMPEG_UNAVAILABLE",
    });
  });

  it("marks running jobs interrupted after a simulated restart", async () => {
    const { catalog, plan } = await seededLibrary();
    catalog.renderJobs.insertQueued({
      id: crypto.randomUUID(),
      kind: "full",
      setPlanId: plan.id,
    });
    const runningId = crypto.randomUUID();
    catalog.renderJobs.insertQueued({
      id: runningId,
      kind: "full",
      setPlanId: plan.id,
    });
    catalog.renderJobs.claimNextQueued();
    catalog.renderJobs.claimNextQueued();
    const interrupted = catalog.renderJobs.failRunningAsInterrupted();
    expect(interrupted).toBeGreaterThanOrEqual(1);
    expect(catalog.service.getRenderStatus(runningId).errorCode).toBe("RENDER_INTERRUPTED");
    expect(catalog.service.getRenderStatus(runningId).retryable).toBe(true);
  });

  it("writes alignmentMode on the manifest for an aligned pair", async () => {
    const { catalog, plan, alpha, bravo } = await seededLibrary();
    const now = new Date().toISOString();
    const barMs = (4 * 60_000) / 174;
    for (const trackId of [alpha.id, bravo.id]) {
      catalog.analyses.upsert({
        trackId,
        analyzerName: DSP_ANALYZER_NAME,
        analyzerVersion: DSP_ANALYZER_VERSION,
        bpm: 174,
        bpmConfidence: 0.9,
        bpmRaw: 174,
        beatTimesMs: [0, 345, 689, 1034],
        downbeatTimesMs: [0, barMs, barMs * 2],
        gridRejected: false,
        gridRejectionReason: null,
        musicalKey: "Fm",
        keyConfidence: 0.7,
        keyMode: "minor",
        camelotKey: "4A",
        tempoStability: 0.8,
        downbeatConfidence: 0.8,
        integratedLufs: null,
        truePeakDb: null,
        lowBandEnergy: null,
        midBandEnergy: null,
        highBandEnergy: null,
        waveformSummary: null,
        beatAnchorMs: null,
        descriptors: null,
        engineRuntimeMs: 1,
        analyzedAt: now,
        suggestedCues: [],
        sections: [],
      });
    }
    catalog.service.updateSetPlan({
      setPlanId: plan.id,
      setTransition: {
        entryId: plan.entries[0]!.id,
        type: "phrase_mix",
        durationMs: 1000,
        parameters: { barCount: 16, targetBpm: 174 },
      },
    });
    const started = await catalog.service.startSetRender({
      setPlanId: plan.id,
      allowLowConfidence: true,
    });
    const done = await catalog.service.waitForRenderJob(started.job.id, 15_000);
    expect(done.status).toBe("succeeded");
    const manifest = catalog.service.getRenderManifest(done.id);
    expect(manifest.tracks[1]?.alignmentMode).toBe("bar");
    expect(manifest.tracks[1]?.alignmentPeriodMs).toBeCloseTo(barMs, 5);
    expect(manifest.automation?.some((event) => event.target === "outgoing_mid")).toBe(true);
    expect(manifest.rendererVersion).toBe(RENDERER_VERSION);
  });
});
