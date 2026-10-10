import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig, SetPlanV1 } from "@dnb-crate/domain";
import {
  AUDIO_ENGINE_ID,
  DSP_ANALYZER_NAME,
  DSP_ANALYZER_VERSION,
  RENDERER_VERSION,
} from "@dnb-crate/domain";
import { createFakeFfmpegRunner, ProcessRunError, sha256Json } from "@dnb-crate/audio-renderer";

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

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
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
  return { catalog, plan, aPath, bPath, alpha, bravo, root };
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
          parameters: { purpose: "fixture" },
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
  catalog.setPlans.save(plan, 1, {
    seed: 1,
    selected: [],
    rejected: [],
    harmonicCoverage: { knownJoins: 0, totalJoins: 0 },
  });
  return plan;
}

describe("render jobs", () => {
  it("queues a full render, completes, and keeps source bytes unchanged", async () => {
    const { catalog, plan, aPath, root } = await seededLibrary();
    const before = createHash("sha256")
      .update(await readFile(aPath))
      .digest("hex");
    const started = await catalog.service.startSetRender({ setPlanId: plan.id });
    expect(started.job.status === "queued" || started.job.status === "running").toBe(true);
    const done = await catalog.service.waitForRenderJob(started.job.id, 15_000);
    expect(done.status).toBe("succeeded");
    expect(done.outputFormat).toBe("flac");
    expect(done.outputRootRelativePath).toMatch(/^renders\/[0-9a-f-]{36}\.flac$/);
    expect(done.outputRootRelativePath).not.toMatch(/^[A-Za-z]:\\/);
    expect(done.listenRootRelativePath).toBe("renders/fixture-mix.flac");
    expect(done.listenFileName).toBe("fixture-mix.flac");
    expect(done.listenRootRelativePath).not.toBe(done.outputRootRelativePath);
    const listenAbs = path.join(root, "output", "renders", "fixture-mix.flac");
    await expect(readFile(listenAbs)).resolves.toBeInstanceOf(Buffer);
    const manifest = catalog.service.getRenderManifest(done.id);
    expect(manifest.listenRootRelativePath).toBe("renders/fixture-mix.flac");
    expect(manifest.listenBitDepth).toBe(16);
    expect(manifest.tracks).toHaveLength(2);
    expect(manifest.outputFormat).toBe("flac");
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
    const review = {
      renderJobId: done.id,
      outputChecksum: manifest.outputChecksumSha256,
      accepted: true,
      quote: "An accepted fixture hour",
    };
    expect(() =>
      catalog.service.recordHourFeedback({ ...review, outputChecksum: "0".repeat(64) }),
    ).toThrow("checksum");
    const feedback = catalog.service.recordHourFeedback(review);
    expect(catalog.service.recordHourFeedback(review).id).toBe(feedback.id);
    expect(catalog.service.reportSetPlanQuality(plan.id).userAccepted).toBe(true);
    catalog.service.updateSetPlan({
      setPlanId: plan.id,
      setTrim: { entryId: plan.entries[0]!.id, sourceStartMs: 100, sourceEndMs: 8000 },
    });
    expect(catalog.service.reportSetPlanQuality(plan.id).userAccepted).toBe(false);
    expect(catalog.service.listHourFeedback(done.id)[0]?.accepted).toBe(true);
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

  it("rejects a queued render when an interior edit changes the bytes (F4a)", async () => {
    // Same-size interior edit: the head/tail fingerprint is unchanged, so a
    // rescan keeps the live row matching — only the frozen full-content
    // hash can reject the stale queued job.
    const { catalog, plan, aPath } = await seededLibrary();
    const first = await catalog.service.startSetRender({ setPlanId: plan.id });
    const done1 = await catalog.service.waitForRenderJob(first.job.id, 15_000);
    expect(done1.status).toBe("succeeded");
    const frozenRequest = catalog.renderJobs.findById(first.job.id)!.params.request!;
    const evidenceRows = Object.values(frozenRequest.evidence);
    expect(
      evidenceRows.some((row) => row && typeof row === "object" && "sourceContentSha256" in row),
    ).toBe(true);

    const bytes = await readFile(aPath);
    expect(bytes.length).toBeGreaterThan(256 * 1024);
    const edited = Buffer.from(bytes);
    const mid = Math.floor(edited.length / 2);
    edited[mid] = (edited[mid] ?? 0) ^ 0xff;
    await writeFile(aPath, edited);
    await catalog.service.scanLibrary();

    const staleId = crypto.randomUUID();
    catalog.renderJobs.insertQueued({
      id: staleId,
      kind: "full",
      setPlanId: plan.id,
      params: { request: frozenRequest },
    });
    const stale = await catalog.service.waitForRenderJob(staleId, 15_000);
    expect(stale.status).toBe("failed");
    expect(stale.errorCode).toBe("AUDIO_FILE_UNAVAILABLE");
    expect(stale.errorMessage).toMatch(/queued/);
  });

  it("rejects an interior edit that preserves size and mtime (R8)", async () => {
    // The queue-time hash cache is keyed by path+size+mtime+head/tail
    // fingerprint. This edit changes none of those, so the cache entry from
    // the first render stays valid-looking — only reading the actual bytes
    // at execution time can catch the change.
    const { catalog, plan, aPath } = await seededLibrary();
    // Pin mtime to whole milliseconds: stat reports 100ns fractions on
    // NTFS that utimes rounds off, so a stat→utimes round trip of the
    // original timestamp is not exact. A whole-ms value restores exactly,
    // which is what the stale cache hit requires.
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000);
    await utimes(aPath, pinned, pinned);
    const first = await catalog.service.startSetRender({ setPlanId: plan.id });
    const done1 = await catalog.service.waitForRenderJob(first.job.id, 15_000);
    expect(done1.status).toBe("succeeded");
    const frozenRequest = catalog.renderJobs.findById(first.job.id)!.params.request!;

    const bytes = await readFile(aPath);
    const edited = Buffer.from(bytes);
    const mid = Math.floor(edited.length / 2);
    edited[mid] = (edited[mid] ?? 0) ^ 0xff;
    await writeFile(aPath, edited);
    // Restore the pinned mtime so the cache key matches the pre-edit entry.
    await utimes(aPath, pinned, pinned);

    const staleId = crypto.randomUUID();
    catalog.renderJobs.insertQueued({
      id: staleId,
      kind: "full",
      setPlanId: plan.id,
      params: { request: frozenRequest },
    });
    const stale = await catalog.service.waitForRenderJob(staleId, 15_000);
    expect(stale.status).toBe("failed");
    expect(stale.errorCode).toBe("AUDIO_FILE_UNAVAILABLE");
    expect(stale.errorMessage).toMatch(/queued/);
  });

  it("still renders a queued job after identical bytes move (F4a)", async () => {
    const { catalog, plan, aPath } = await seededLibrary();
    const first = await catalog.service.startSetRender({ setPlanId: plan.id });
    await catalog.service.waitForRenderJob(first.job.id, 15_000);
    const frozenRequest = catalog.renderJobs.findById(first.job.id)!.params.request!;
    const { rename } = await import("node:fs/promises");
    await rename(aPath, aPath.replace("alpha.wav", "alpha-moved.wav"));
    await catalog.service.scanLibrary();

    const movedId = crypto.randomUUID();
    catalog.renderJobs.insertQueued({
      id: movedId,
      kind: "full",
      setPlanId: plan.id,
      params: { request: frozenRequest },
    });
    const moved = await catalog.service.waitForRenderJob(movedId, 15_000);
    expect(moved.status).toBe("succeeded");
  });

  it("keeps the legacy live-row policy for requests without a frozen hash (F4a)", async () => {
    const { catalog, plan, aPath } = await seededLibrary();
    const first = await catalog.service.startSetRender({ setPlanId: plan.id });
    await catalog.service.waitForRenderJob(first.job.id, 15_000);
    const legacyRequest = structuredClone(
      catalog.renderJobs.findById(first.job.id)!.params.request!,
    );
    for (const row of Object.values(legacyRequest.evidence)) {
      if (row && typeof row === "object" && "present" in row) {
        delete row.sourceContentSha256;
      }
    }
    // Same-size interior edit keeps the cheap fingerprint — the legacy
    // policy cannot see it and the job still renders (documented legacy
    // behavior; requests frozen after F4a carry the strong identity).
    const bytes = await readFile(aPath);
    const edited = Buffer.from(bytes);
    const mid = Math.floor(edited.length / 2);
    edited[mid] = (edited[mid] ?? 0) ^ 0xff;
    await writeFile(aPath, edited);

    const legacyId = crypto.randomUUID();
    catalog.renderJobs.insertQueued({
      id: legacyId,
      kind: "full",
      setPlanId: plan.id,
      params: { request: legacyRequest },
    });
    const legacy = await catalog.service.waitForRenderJob(legacyId, 15_000);
    expect(legacy.status).toBe("succeeded");
  });

  it("labels audio verification scope and per-mode unmeasured reasons accurately (R6)", async () => {
    const { catalog, plan } = await seededLibrary();
    const started = await catalog.service.startSetRender({ setPlanId: plan.id });
    const done = await catalog.service.waitForRenderJob(started.job.id, 15_000);
    expect(done.status).toBe("succeeded");

    const fast = await catalog.service.checkRender(done.id);
    // The scope block names what the verifier actually measures (R6).
    expect(fast.audioVerification).toEqual({
      mode: "fast",
      scope: "source-decks",
      probedJoins: [],
    });
    // A crossfade join has no aligned decks to probe: the reason says so
    // instead of the stale "not implemented" default.
    const join = fast.joins[0]!;
    expect(join.audioStatus).toBe("unmeasured");
    expect(join.audioUnmeasuredReason).toBe("source-deck probe not applicable: no aligned decks");
    expect(fast.warnings.join("\n")).toMatch(/source-deck audio unmeasured/);

    const off = await catalog.service.checkRender(done.id, undefined, {
      audioVerification: "off",
    });
    // With the mode disabled, that is the reason — for every join.
    expect(off.audioVerification).toEqual({
      mode: "off",
      scope: "source-decks",
      probedJoins: [],
    });
    expect(off.joins[0]!.audioUnmeasuredReason).toBe(
      "source-deck probe off (audioVerification=off)",
    );
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
    expect(second.job.listenRootRelativePath).toBeNull();
  });

  it.each(["local", "remote", "shutdown"])(
    "cancels a running job through %s and settles before SQLite closes",
    async (mode) => {
      const root = path.join(
        os.tmpdir(),
        `dnb-cancel-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      );
      const library = path.join(root, "library");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(library, { recursive: true });
      let aborted = false;
      const fake = createFakeFfmpegRunner({ hangUntilAbort: true });
      const catalog = createCatalogRuntime(testConfig(root), undefined, {
        processRunner: {
          run(request) {
            request.abortSignal?.addEventListener(
              "abort",
              () => {
                aborted = true;
              },
              { once: true },
            );
            return fake.run(request);
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
      const started = await catalog.service.startSetRender({ setPlanId: plan.id });
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (mode === "shutdown") {
        await catalog.close();
        expect(aborted).toBe(true);
        expect(catalog.db.open).toBe(false);
        const reader = createCatalogRuntime(testConfig(root), undefined, { passive: true });
        try {
          expect(reader.service.getRenderStatus(started.job.id).status).toBe("cancelled");
        } finally {
          await reader.close();
        }
        return;
      }
      if (mode === "remote") {
        const remote = createCatalogRuntime(testConfig(root), undefined, { passive: true });
        try {
          remote.service.cancelRenderJob(started.job.id, true);
          await expect.poll(() => aborted).toBe(true);
          expect(catalog.service.getRenderStatus(started.job.id).status).toBe("cancelled");
        } finally {
          await remote.close();
        }
        return;
      }
      const cancelled = catalog.service.cancelRenderJob(started.job.id, true);
      expect(cancelled.cancelled).toBe(true);
      const done = await catalog.service.waitForRenderJob(started.job.id, 10_000);
      expect(done.status).toBe("cancelled");
    },
  );

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
    const rating = catalog.service.rateTransition({
      renderJobId: done.id,
      transitionId: manifest.tracks[0]!.transitionId!,
      note: "Exact heard join",
    });
    expect(rating.recipeFingerprint).toMatch(/^v2:[a-f0-9]{64}$/);
    expect(rating.outgoingTrackId).toBe(manifest.tracks[0]!.trackId);
    expect(rating.overall).toBe("not_assessed");
    expect(() =>
      catalog.service.rateTransition({
        renderJobId: done.id,
        transitionId: manifest.tracks[0]!.transitionId!,
        outgoingTrackId: "wrong",
      }),
    ).toThrow("disagree");
    expect(manifest.joinEvidence).toHaveLength(1);
    expect(manifest.joinEvidence?.[0]?.outgoingBeatsMs.length).toBeGreaterThan(0);
    const checked = await catalog.service.checkRender(done.id);
    expect(checked.joins[0]?.evidenceSource).toBe("frozen-manifest");
    expect(checked.joins[0]?.residualKind).toBe("stored-grid-consistency");
    catalog.analyses.upsert({
      trackId: alpha.id,
      analyzerName: DSP_ANALYZER_NAME,
      analyzerVersion: DSP_ANALYZER_VERSION,
      bpm: 174,
      bpmConfidence: 0.9,
      bpmRaw: 174,
      beatTimesMs: [80, 425, 769, 1114],
      downbeatTimesMs: [80, barMs + 80],
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
    const again = await catalog.service.checkRender(done.id);
    expect(again.joins[0]?.storedGridResidualMs).toBe(checked.joins[0]?.storedGridResidualMs);
    expect(again.joins[0]?.evidenceSource).toBe("frozen-manifest");
  });

  it("projects stored grids from the placed start when the offset is baked in", async () => {
    // F1 (repository review 2026-10-08): the manifest stores PLACED source
    // coordinates. A planned aligned join persists the baked incoming window
    // (buildEntries) plus the alignment offset as transition metadata
    // (chooseTransition parameters) — the renderer skips re-application for
    // those recipe-version-1 transitions. Alpha's downbeat grid sits ~400 ms
    // late against bravo's at the join, so the persisted bravo window starts
    // at 400 with downbeatOffsetMs 400 recorded. The checker must read ~0
    // residual: re-applying the recorded offset double-counts it.
    const root = path.join(os.tmpdir(), `dnb-place-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, {
      useFakeFfmpeg: true,
    });
    cleanups.push(() => catalog.close());
    await writeSineWav(path.join(library, "alpha.wav"), {
      title: "Alpha",
      artist: "A",
      durationMs: 8000,
    });
    // The fake renderer always measures a 15 s master; bravo is 10 s so the
    // trimmed plan (7 s + 9 s - 1 s overlap) lands inside the 1 s tolerance.
    await writeSineWav(path.join(library, "bravo.wav"), {
      title: "Bravo",
      artist: "B",
      durationMs: 10_000,
    });
    await catalog.service.scanLibrary();
    const tracks = catalog.service.searchTracks({ limit: 50 }).tracks;
    const alpha = tracks.find((track) => track.title === "Alpha")!;
    const bravo = tracks.find((track) => track.title === "Bravo")!;
    const plan = saveTwoTrackPlan(catalog, alpha.id, bravo.id);
    const now = new Date().toISOString();
    const upsertGrid = (trackId: string, beatTimesMs: number[], downbeatTimesMs: number[]) => {
      catalog.analyses.upsert({
        trackId,
        analyzerName: DSP_ANALYZER_NAME,
        analyzerVersion: DSP_ANALYZER_VERSION,
        bpm: 174,
        bpmConfidence: 0.9,
        bpmRaw: 174,
        beatTimesMs,
        downbeatTimesMs,
        gridRejected: false,
        gridRejectionReason: null,
        musicalKey: "Fm",
        keyConfidence: 0.7,
        keyMode: "minor",
        camelotKey: "4A",
        tempoStability: 0.8,
        downbeatConfidence: 0.9,
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
    };
    // Consistent 174-ish grids (bar = 4 × 345 ms), alpha anchored 80 ms late.
    upsertGrid(
      alpha.id,
      Array.from({ length: 21 }, (_, i) => 80 + i * 345),
      Array.from({ length: 6 }, (_, i) => 80 + i * 4 * 345),
    );
    upsertGrid(
      bravo.id,
      Array.from({ length: 27 }, (_, i) => i * 345),
      Array.from({ length: 7 }, (_, i) => i * 4 * 345),
    );
    // Persist the join exactly as the planner would: alpha's overlap starts
    // at 6000 (window end 7000, overlap 1000), bravo's window baked +400 by
    // bakeWindowAlignment, offset recorded in the transition parameters.
    catalog.service.updateSetPlan({
      setPlanId: plan.id,
      setTrim: { entryId: plan.entries[0]!.id, sourceStartMs: 0, sourceEndMs: 7_000 },
    });
    catalog.service.updateSetPlan({
      setPlanId: plan.id,
      setTrim: { entryId: plan.entries[1]!.id, sourceStartMs: 400, sourceEndMs: 9_400 },
    });
    catalog.service.updateSetPlan({
      setPlanId: plan.id,
      setTransition: {
        entryId: plan.entries[0]!.id,
        type: "phrase_mix",
        durationMs: 1000,
        parameters: {
          barCount: 16,
          targetBpm: 174,
          downbeatOffsetMs: 400,
          mixOutMs: 6_000,
          mixInMs: 400,
        },
      },
    });
    const started = await catalog.service.startSetRender({
      setPlanId: plan.id,
      allowLowConfidence: true,
    });
    const done = await catalog.service.waitForRenderJob(started.job.id, 15_000);
    expect(done.status).toBe("succeeded");
    const manifest = catalog.service.getRenderManifest(done.id);
    // Join alignment metadata lives on the outgoing manifest track.
    expect(manifest.tracks[0]?.downbeatOffsetMs).toBe(400);
    // The placed incoming start carries the baked offset.
    expect(manifest.tracks[1]?.sourceStartMs).toBe(400);
    const checked = await catalog.service.checkRender(done.id);
    expect(checked.joins[0]?.evidenceSource).toBe("frozen-manifest");
    expect(checked.joins[0]?.storedGridResidualMs).not.toBeNull();
    expect(Math.abs(checked.joins[0]?.storedGridResidualMs ?? 99)).toBeLessThan(20);
    expect(checked.ok).toBe(true);
  });

  it("fails a misaligned stored grid instead of clearing it with an inconclusive audio scan", async () => {
    // F2 step 1: bravo's beats sit 90 ms off its own downbeats, so the
    // downbeat alignment places the decks "aligned" while the beat trains
    // disagree by ~90 ms. The mixed-PCM scan cannot attribute decks and must
    // NOT act as proof of corrected alignment — the stored-grid failure and
    // ok=false stand, with the audio honestly reported as unmeasured.
    const { catalog, plan, alpha, bravo } = await seededLibrary();
    const now = new Date().toISOString();
    const upsertGrid = (trackId: string, beatTimesMs: number[], downbeatTimesMs: number[]) => {
      catalog.analyses.upsert({
        trackId,
        analyzerName: DSP_ANALYZER_NAME,
        analyzerVersion: DSP_ANALYZER_VERSION,
        bpm: 174,
        bpmConfidence: 0.9,
        bpmRaw: 174,
        beatTimesMs,
        downbeatTimesMs,
        gridRejected: false,
        gridRejectionReason: null,
        musicalKey: "Fm",
        keyConfidence: 0.7,
        keyMode: "minor",
        camelotKey: "4A",
        tempoStability: 0.8,
        downbeatConfidence: 0.9,
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
    };
    upsertGrid(
      alpha.id,
      Array.from({ length: 21 }, (_, i) => i * 345),
      Array.from({ length: 6 }, (_, i) => i * 4 * 345),
    );
    // Beats 90 ms late relative to bravo's downbeat grid: aligning downbeats
    // leaves the beat trains ~90 ms apart — a wrong-grid defect.
    upsertGrid(
      bravo.id,
      Array.from({ length: 22 }, (_, i) => 90 + i * 345),
      Array.from({ length: 6 }, (_, i) => i * 4 * 345),
    );
    catalog.service.updateSetPlan({
      setPlanId: plan.id,
      setTrim: { entryId: plan.entries[0]!.id, sourceStartMs: 0, sourceEndMs: 7_000 },
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
    const checked = await catalog.service.checkRender(done.id);
    const join = checked.joins[0]!;
    expect(join.evidenceSource).toBe("frozen-manifest");
    expect(Math.abs(join.storedGridResidualMs ?? 0)).toBeGreaterThan(40);
    expect(join.audioStatus).toBe("unmeasured");
    expect(join.audioUnmeasuredReason).not.toBeNull();
    expect(checked.failures.some((text) => /stored-grid residual/.test(text))).toBe(true);
    expect(checked.ok).toBe(false);
    // Diagnostic scratch files must not survive the check (unique per
    // invocation; concurrent checks cannot collide on one name).
    const leftovers = (await readdir(path.dirname(checked.outputPath))).filter((name) =>
      name.includes(".phase4-"),
    );
    expect(leftovers).toEqual([]);
  });

  it("keeps a rendered plan ready when the configured root is an alias of the scanned files", async () => {
    // Windows smoke lane catch (October 2026): the scanner stores
    // realpath()'d track paths, but readiness compared them against bare
    // path.resolve(config.libraryRoots). Any root whose configured form
    // differs from its real path — an 8.3 short name (C:\Users\RUNNER~1),
    // a junction, a symlink — placed every track "outside the library
    // roots" and refused every render. Both sides must resolve the same
    // way.
    const root = path.join(
      os.tmpdir(),
      `dnb-alias-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const realLibrary = path.join(root, "real-library");
    const aliasLibrary = path.join(root, "alias-library");
    await mkdir(realLibrary, { recursive: true });
    await symlink(realLibrary, aliasLibrary, process.platform === "win32" ? "junction" : "dir");
    const catalog = createCatalogRuntime(
      {
        ...testConfig(root),
        libraryRoots: [aliasLibrary],
      },
      undefined,
      { useFakeFfmpeg: true },
    );
    cleanups.push(() => catalog.close());
    await writeSineWav(path.join(realLibrary, "alpha.wav"), {
      title: "Alpha",
      artist: "A",
      durationMs: 8000,
    });
    await writeSineWav(path.join(realLibrary, "bravo.wav"), {
      title: "Bravo",
      artist: "B",
      durationMs: 8000,
    });
    await catalog.service.scanLibrary();
    const tracks = catalog.service.searchTracks({ limit: 50 }).tracks;
    const alpha = tracks.find((track) => track.title === "Alpha")!;
    const bravo = tracks.find((track) => track.title === "Bravo")!;
    const plan = saveTwoTrackPlan(catalog, alpha.id, bravo.id);
    const started = await catalog.service.startSetRender({ setPlanId: plan.id });
    const done = await catalog.service.waitForRenderJob(started.job.id, 15_000);
    expect(done.status).toBe("succeeded");
  });

  it("renders a queued preview from the frozen plan after trims change", async () => {
    const root = path.join(os.tmpdir(), `dnb-freeze-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(library, { recursive: true });
    const fake = createFakeFfmpegRunner();
    const hang = createFakeFfmpegRunner({ hangUntilAbort: true });
    let blockFirst = true;
    const catalog = createCatalogRuntime(testConfig(root), undefined, {
      processRunner: {
        run(request) {
          if (blockFirst) {
            return hang.run(request);
          }
          return fake.run(request);
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
    const originalStart = plan.entries[0]!.sourceStartMs;
    const originalEnd = plan.entries[0]!.sourceEndMs;
    const blocking = await catalog.service.startSetRender({ setPlanId: plan.id });
    await expect
      .poll(() => catalog.service.getRenderStatus(blocking.job.id).status)
      .toBe("running");
    const preview = await catalog.service.createTransitionPreview({
      setPlanId: plan.id,
      transitionId: plan.entries[0]!.transitionToNext!.id,
      windowMs: 30_000,
    });
    expect(preview.job.status).toBe("queued");
    catalog.service.updateSetPlan({
      setPlanId: plan.id,
      setTrim: { entryId: plan.entries[0]!.id, sourceStartMs: 400, sourceEndMs: 8000 },
    });
    blockFirst = false;
    catalog.service.cancelRenderJob(blocking.job.id, true);
    const done = await catalog.service.waitForRenderJob(preview.job.id, 15_000);
    expect(done.status).toBe("succeeded");
    const manifest = catalog.service.getRenderManifest(done.id);
    expect(manifest.tracks[0]?.sourceStartMs).toBe(originalStart);
    expect(manifest.tracks[0]?.sourceEndMs).toBe(originalEnd);
    expect(catalog.service.getSetPlan(plan.id).entries[0]?.sourceStartMs).toBe(400);
  });

  it("fails a full hour-length render when probed duration misses the plan", async () => {
    const { catalog, plan } = await seededLibrary();
    const longPlan: SetPlanV1 = {
      ...plan,
      entries: [
        {
          ...plan.entries[0]!,
          sourceEndMs: 200_000,
        },
        {
          ...plan.entries[1]!,
          sourceEndMs: 200_000,
          timelineStartMs: 199_000,
        },
      ],
    };
    const jobId = crypto.randomUUID();
    catalog.renderJobs.insertQueued({
      id: jobId,
      kind: "full",
      setPlanId: plan.id,
      params: {
        request: {
          planContentHash: sha256Json(longPlan),
          plan: longPlan,
          evidence: {},
        },
      },
    });
    const done = await catalog.service.waitForRenderJob(jobId, 15_000);
    expect(done.status).toBe("failed");
    expect(done.errorMessage).toMatch(/tolerance 1000ms/);
    expect(done.outputRootRelativePath).toMatch(/^renders\//);
  });

  it("fails a short full render when probed duration misses the plan", async () => {
    const root = path.join(os.tmpdir(), `dnb-short-dur-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, {
      processRunner: createFakeFfmpegRunner({ probeDurationSec: 1 }),
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
    const done = await catalog.service.waitForRenderJob(started.job.id, 15_000);
    expect(done.status).toBe("failed");
    expect(done.errorMessage).toMatch(/tolerance 1000ms/);
    expect(done.outputRootRelativePath).toMatch(/^renders\//);
  });

  it("renders a queued full mix from the frozen plan after the live plan becomes unready", async () => {
    const root = path.join(os.tmpdir(), `dnb-full-freeze-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(library, { recursive: true });
    const fake = createFakeFfmpegRunner({ probeDurationSec: 15 });
    const hang = createFakeFfmpegRunner({ hangUntilAbort: true });
    let blockFirst = true;
    const catalog = createCatalogRuntime(testConfig(root), undefined, {
      processRunner: {
        run(request) {
          if (blockFirst) {
            return hang.run(request);
          }
          return fake.run(request);
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
    const originalStart = plan.entries[0]!.sourceStartMs;
    const blocking = await catalog.service.startSetRender({ setPlanId: plan.id });
    await expect
      .poll(() => catalog.service.getRenderStatus(blocking.job.id).status)
      .toBe("running");
    const stored = catalog.setPlans.findById(plan.id)!;
    catalog.setPlans.save(
      {
        ...stored.plan,
        qualityPolicy: "strict",
        targetDurationMs: 3_600_000,
        entries: stored.plan.entries.map((entry, index) =>
          index === 0 ? { ...entry, sourceStartMs: 400 } : entry,
        ),
      },
      stored.seed,
      stored.explanation,
    );
    expect(catalog.service.getSetPlan(plan.id).qualityPolicy).toBe("strict");
    expect(catalog.service.getSetPlan(plan.id).entries[0]?.sourceStartMs).toBe(400);
    expect(() => catalog.service.assertPlanReadyForRender(plan.id)).toThrow(/not ready/);
    blockFirst = false;
    catalog.service.cancelRenderJob(blocking.job.id, true);
    const frozenJob = catalog.renderJobs.findById(blocking.job.id);
    expect(frozenJob?.params.request?.plan.entries[0]?.sourceStartMs).toBe(originalStart);
    const rerun = catalog.renderJobs.insertQueued({
      id: crypto.randomUUID(),
      kind: "full",
      setPlanId: plan.id,
      params: {
        request: frozenJob!.params.request,
      },
    });
    const done = await catalog.service.waitForRenderJob(rerun.id, 15_000);
    expect(done.status).toBe("succeeded");
    const manifest = catalog.service.getRenderManifest(done.id);
    expect(manifest.tracks[0]?.sourceStartMs).toBe(originalStart);
  });

  it("keeps frozen evidence and settings after reanalysis and config change", async () => {
    const { catalog, plan, alpha, root } = await seededLibrary();
    stubAnalysis(catalog, alpha.id, { bpm: 174, beatTimesMs: [0, 345, 690] });
    stubAnalysis(catalog, plan.entries[1]!.trackId, { bpm: 174, beatTimesMs: [0, 345, 690] });
    const transitionId = plan.entries[0]!.transitionToNext!.id;
    const first = await catalog.service.createTransitionPreview({
      setPlanId: plan.id,
      transitionId,
      windowMs: 30_000,
    });
    const done = await catalog.service.waitForRenderJob(first.job.id, 15_000);
    expect(done.status).toBe("succeeded");
    const firstKey = catalog.renderJobs.findById(done.id)?.cacheKey;
    expect(firstKey).toBeTruthy();
    const frozen = catalog.renderJobs.findById(done.id)?.params.request?.evidence[alpha.id];
    expect(frozen && "present" in frozen && frozen.present).toBe(true);
    expect(frozen && "bpm" in frozen ? frozen.bpm : null).toBe(174);
    expect(catalog.renderJobs.findById(done.id)?.params.request?.settings?.loudnessTargetLufs).toBe(
      -14,
    );
    expect(catalog.renderJobs.findById(done.id)?.params.request?.settings?.rendererVersion).toBe(
      RENDERER_VERSION,
    );
    expect(catalog.renderJobs.findById(done.id)?.params.request?.settings?.audioEngineId).toBe(
      AUDIO_ENGINE_ID,
    );

    const hit = await catalog.service.createTransitionPreview({
      setPlanId: plan.id,
      transitionId,
      windowMs: 30_000,
    });
    expect(hit.job.status).toBe("succeeded");
    expect(catalog.renderJobs.findById(hit.job.id)?.cacheKey).toBe(firstKey);

    stubAnalysis(catalog, alpha.id, { bpm: 160, beatTimesMs: [80, 999] });
    const afterAnalysis = await catalog.service.createTransitionPreview({
      setPlanId: plan.id,
      transitionId,
      windowMs: 30_000,
    });
    expect(catalog.renderJobs.findById(afterAnalysis.job.id)?.cacheKey).not.toBe(firstKey);
    const afterDone = await catalog.service.waitForRenderJob(afterAnalysis.job.id, 15_000);
    expect(afterDone.status).toBe("succeeded");
    expect(catalog.service.getRenderManifest(done.id).joinEvidence?.[0]?.outgoingBeatsMs).toEqual([
      0, 345, 690,
    ]);

    const restarted = createCatalogRuntime(
      { ...testConfig(root), loudnessTargetLufs: -18 },
      undefined,
      { useFakeFfmpeg: true, passive: true },
    );
    cleanups.push(() => restarted.close());
    const afterSettings = await restarted.service.createTransitionPreview({
      setPlanId: plan.id,
      transitionId,
      windowMs: 30_000,
    });
    expect(afterSettings.job.status).toBe("queued");
    expect(restarted.renderJobs.findById(afterSettings.job.id)?.cacheKey).not.toBe(firstKey);
    expect(
      restarted.renderJobs.findById(afterSettings.job.id)?.params.request?.settings
        ?.loudnessTargetLufs,
    ).toBe(-18);
  });

  it("fails a queued job whose frozen audio engine no longer matches", async () => {
    const { catalog, plan } = await seededLibrary();
    const started = await catalog.service.startSetRender({ setPlanId: plan.id });
    const done = await catalog.service.waitForRenderJob(started.job.id, 15_000);
    expect(done.status).toBe("succeeded");
    const request = structuredClone(catalog.renderJobs.findById(done.id)!.params.request);
    request!.settings!.audioEngineId = "float-r3-lr4-join-v2";
    const rerun = catalog.renderJobs.insertQueued({
      id: crypto.randomUUID(),
      kind: "full",
      setPlanId: plan.id,
      params: { request },
    });
    const failed = await catalog.service.waitForRenderJob(rerun.id, 15_000);
    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toMatch(/incompatible with running/);
  });

  it("fails a queued job when the frozen Rubber Band executable is replaced", async () => {
    const root = path.join(os.tmpdir(), `dnb-r3-pin-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    const cli = path.join(root, "rubberband.exe");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(library, { recursive: true });
    await writeFile(cli, "rubberband-v1");
    const catalog = createCatalogRuntime(testConfig(root), undefined, {
      useFakeFfmpeg: true,
      rubberbandCliPath: cli,
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
    const done = await catalog.service.waitForRenderJob(started.job.id, 15_000);
    expect(done.status).toBe("succeeded");
    const frozen = catalog.renderJobs.findById(done.id)?.params.request?.settings;
    expect(frozen?.rubberbandCliPath).toBe(cli);
    expect(frozen?.rubberbandSha256).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(cli, "rubberband-v2");
    const rerun = catalog.renderJobs.insertQueued({
      id: crypto.randomUUID(),
      kind: "full",
      setPlanId: plan.id,
      params: { request: catalog.renderJobs.findById(done.id)!.params.request },
    });
    const failed = await catalog.service.waitForRenderJob(rerun.id, 15_000);
    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toMatch(/replaced after queue/);
  });

  it("withholds the listen copy when its measured peak exceeds the ceiling", async () => {
    const root = path.join(os.tmpdir(), `dnb-listen-peak-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    const { mkdir, access } = await import("node:fs/promises");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, {
      processRunner: createFakeFfmpegRunner({
        probeDurationSec: 15,
        eburForInput: (inputPath) =>
          inputPath.replaceAll("\\", "/").includes("renders/fixture-mix.flac.")
            ? { truePeakDb: 0.8 }
            : undefined,
      }),
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
    const done = await catalog.service.waitForRenderJob(started.job.id, 15_000);
    expect(done.status).toBe("succeeded");
    expect(done.listenRootRelativePath).toBeNull();
    const manifest = catalog.service.getRenderManifest(done.id);
    expect(manifest.listenRootRelativePath).toBeUndefined();
    expect(manifest.listenBitDepth).toBeUndefined();
    expect(manifest.listenTruePeakDb).toBeCloseTo(0.8);
    expect(manifest.warnings.some((warning) => warning.includes("Listen copy withheld"))).toBe(
      true,
    );
    await expect(
      access(path.join(root, "output", "renders", "fixture-mix.flac")),
    ).rejects.toThrow();
  });
});

function stubAnalysis(
  catalog: ReturnType<typeof createCatalogRuntime>,
  trackId: string,
  extras: { bpm: number; beatTimesMs: number[] },
): void {
  catalog.analyses.upsert({
    trackId,
    analyzerName: DSP_ANALYZER_NAME,
    analyzerVersion: DSP_ANALYZER_VERSION,
    bpm: extras.bpm,
    bpmConfidence: 0.9,
    bpmRaw: extras.bpm,
    referenceBpm: null,
    beatTimesMs: extras.beatTimesMs,
    downbeatTimesMs: extras.beatTimesMs.slice(0, 1),
    gridRejected: false,
    gridRejectionReason: null,
    gridSource: "analyzed",
    musicalKey: "Fm",
    keyConfidence: 0.7,
    keyMode: "minor",
    camelotKey: "4A",
    keyCandidates: null,
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
    analyzedAt: new Date().toISOString(),
    suggestedCues: [],
    sections: [],
  });
}
