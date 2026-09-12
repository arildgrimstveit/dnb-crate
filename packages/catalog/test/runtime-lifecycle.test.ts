import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeFfmpegRunner, type ProcessRunner } from "@dnb-crate/audio-renderer";
import type { AppConfig } from "@dnb-crate/domain";
import { createCatalogRuntime, writeSineWav } from "../src/index.ts";
import { hasLiveWorker, WorkerOwner } from "../src/worker-owner.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const runtimes: ReturnType<typeof createCatalogRuntime>[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.close();
});

async function workspace(): Promise<AppConfig> {
  const root = await mkdtemp(path.join(os.tmpdir(), "dnb-lifecycle-"));
  const library = path.join(root, "library");
  await mkdir(library);
  await writeSineWav(path.join(library, "healthy.wav"), { title: "Healthy", durationMs: 1000 });
  await writeSineWav(path.join(library, "next.wav"), { title: "Next", durationMs: 1000 });
  return {
    databasePath: path.join(root, "catalog.sqlite"),
    libraryRoots: [library],
    outputRoot: path.join(root, "output"),
    supportedExtensions: [".wav"],
    logLevel: "error",
  };
}

function open(
  config: AppConfig,
  options: Parameters<typeof createCatalogRuntime>[2] = { useFakeFfmpeg: true },
) {
  const runtime = createCatalogRuntime(config, undefined, options);
  runtimes.push(runtime);
  return runtime;
}

describe("runtime ownership and shutdown", () => {
  it("reports a live worker only while an owner holds the catalog", async () => {
    const config = await workspace();
    const first = open(config);
    expect(hasLiveWorker(first.db)).toBe(true);
    const reader = open(config, { passive: true, useFakeFfmpeg: true });
    expect(hasLiveWorker(reader.db)).toBe(true);
    await first.close();
    expect(hasLiveWorker(reader.db)).toBe(false);
  });

  it("leaves a live owner's job running when active and passive runtimes open", async () => {
    const config = await workspace();
    const first = open(config);
    const job = first.analysisJobs.insertQueued([]);
    first.analysisJobs.claimNextQueued();
    const second = open(config);
    const passive = open(config, { passive: true, useFakeFfmpeg: true });
    expect(second.analysisJobs.require(job.id).status).toBe("running");
    expect(passive.analysisJobs.require(job.id).status).toBe("running");
    await second.close();
    expect(first.analysisJobs.require(job.id).status).toBe("running");
  });

  it("takes over after ownership is released and recovers interrupted jobs", async () => {
    const config = await workspace();
    const first = open(config);
    const job = first.analysisJobs.insertQueued([]);
    first.analysisJobs.claimNextQueued();
    const second = open(config);
    await first.close();
    await expect.poll(() => second.analysisJobs.require(job.id).status).toBe("failed");
  });

  it("recovers ownership left by a dead process", async () => {
    const config = await workspace();
    const passive = open(config, { passive: true, useFakeFfmpeg: true });
    // Use an exited child PID rather than assuming an arbitrary PID is unused.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", ""], { windowsHide: true });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    passive.db
      .prepare("INSERT INTO worker_owner (id, token, pid) VALUES (1, 'dead', ?)")
      .run(child.pid!);
    const owner = new WorkerOwner(passive.db);
    expect(owner.acquire()).toBe(true);
    owner.release();
  });

  it("the owner picks up jobs enqueued by another runtime", async () => {
    const config = await workspace();
    const first = open(config);
    await first.service.scanLibrary();
    const second = open(config);
    const ids = second.repository.listAll().map((t) => t.id);
    const job = second.service.startTrackAnalysis({ trackIds: ids }).job;
    const done = await second.service.waitForAnalysisJob(job.id, 5000);
    expect(done.completedTrackIds).toHaveLength(2);
    expect(done.failedTrackIds).toEqual([]);
  });

  it("keeps SQLite open until active analysis settles, and close is idempotent", async () => {
    const config = await workspace();
    const base = createFakeFfmpegRunner();
    const entered = deferred();
    const release = deferred();
    const runner: ProcessRunner = {
      async run(request) {
        if (request.args.some((arg) => arg.includes("ebur128"))) {
          entered.resolve();
          await release.promise;
        }
        return base.run(request);
      },
    };
    const runtime = open(config, { processRunner: runner });
    await runtime.service.scanLibrary();
    const job = runtime.service.startTrackAnalysis({
      trackIds: [runtime.repository.listAll()[0]!.id],
    }).job;
    await entered.promise;
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    expect(runtime.db.open).toBe(true);
    expect(runtime.analysisJobs.require(job.id).status).toBe("running");
    release.resolve();
    await closing;
    expect(runtime.db.open).toBe(false);
    const reader = open(config, { passive: true, useFakeFfmpeg: true });
    expect(reader.analysisJobs.require(job.id).status).toBe("succeeded");
  });

  it("waits for an in-flight enrichment request before closing SQLite", async () => {
    const config = await workspace();
    config.enrichment = { enabled: true, deezer: { enabled: false }, writePublishedBpm: true };
    const entered = deferred();
    const release = deferred();
    const runtime = open(config, {
      useFakeFfmpeg: true,
      http: {
        async get() {
          entered.resolve();
          await release.promise;
          return { status: 404, body: "{}", headers: {} };
        },
      },
    });
    await runtime.service.scanLibrary();
    const trackId = runtime.repository.listAll()[0]!.id;
    runtime.db
      .prepare("UPDATE tracks SET recording_mbid = ? WHERE id = ?")
      .run("11111111-1111-4111-8111-111111111111", trackId);
    runtime.service.startMetadataEnrichment({ scope: "ids", trackIds: [trackId] });
    await entered.promise;
    const closing = runtime.close();
    expect(runtime.db.open).toBe(true);
    release.resolve();
    await closing;
    expect(runtime.db.open).toBe(false);
  });
});

describe("analysis prefetch isolation", () => {
  it.each([1, 4])(
    "keeps healthy results when a prefetched decode fails (prefetch %i)",
    async (prefetch) => {
      const config = await workspace();
      config.analysis = { defaultEngine: "dnb-crate-dsp", prefetch };
      const base = createFakeFfmpegRunner();
      const runner: ProcessRunner = {
        run(request) {
          if (request.args.includes("pcm_s16le")) {
            return Promise.resolve({
              exitCode: 1,
              signal: null,
              stdout: "",
              stderr: "corrupt file",
            });
          }
          return base.run(request);
        },
      };
      const runtime = open(config, { processRunner: runner });
      await runtime.service.scanLibrary();
      const tracks = runtime.repository.listAll();
      const healthy = tracks.find((t) => t.title === "Healthy")!;
      const corrupt = tracks.find((t) => t.title === "Next")!;
      await writeFile(corrupt.filePath, "invalid wav");
      const job = runtime.service.startTrackAnalysis({ trackIds: [healthy.id, corrupt.id] }).job;
      const done = await runtime.service.waitForAnalysisJob(job.id, 5000);
      expect(done.completedTrackIds).toEqual([healthy.id]);
      expect(done.failedTrackIds).toEqual([corrupt.id]);
      expect(runtime.analyses.findByTrackId(healthy.id)).not.toBeNull();
    },
  );
});
