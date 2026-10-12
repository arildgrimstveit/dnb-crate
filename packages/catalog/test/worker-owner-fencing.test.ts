import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import DatabaseDefault from "better-sqlite3";
import type { Database } from "better-sqlite3";
import type { AppConfig } from "@dnb-crate/domain";

import { createCatalogRuntime } from "../src/index.ts";
import { openDatabase } from "../src/db.ts";
import { WorkerOwner, WORKER_HEARTBEAT_STALE_MS } from "../src/worker-owner.ts";

function testConfig(root: string): AppConfig {
  return {
    databasePath: path.join(root, "catalog.sqlite"),
    libraryRoots: [path.join(root, "library")],
    outputRoot: path.join(root, "output"),
    logLevel: "error",
    supportedExtensions: [".wav"],
  };
}

function backdateHeartbeat(db: Database): void {
  const stale = new Date(Date.now() - WORKER_HEARTBEAT_STALE_MS - 5_000).toISOString();
  db.prepare("UPDATE worker_owner SET heartbeat_at = ? WHERE id = 1").run(stale);
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("worker ownership fencing (review item 5)", () => {
  it("deposes the old owner when a takeover happens between heartbeats", async () => {
    const root = path.join(os.tmpdir(), `dnb-fence-${crypto.randomUUID()}`);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const db = openDatabase(path.join(root, "catalog.sqlite"));
    try {
      const ownerA = new WorkerOwner(db);
      expect(ownerA.acquire()).toBe(true);
      expect(ownerA.heartbeat()).toBe(true);

      // Deterministic takeover: the same live pid's heartbeat goes stale, so
      // a second owner may acquire even though owner A never exited.
      backdateHeartbeat(db);
      const ownerB = new WorkerOwner(db);
      expect(ownerB.acquire()).toBe(true);
      expect(ownerB.heartbeat()).toBe(true);

      // A's next UNTHROTTLED beat (the pump retries within ~1 s) is a no-row
      // update: A must observe the deposal, report it, and stop acting as
      // owner — acquire stays false while B is viable.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(ownerA.heartbeat()).toBe(false);
      expect(ownerA.stillOwned()).toBe(false);
      expect(ownerA.acquire()).toBe(false);
      expect(ownerB.stillOwned()).toBe(true);
      ownerB.release();
    } finally {
      db.close();
    }
  });

  it("releases token-scoped so a deposed owner cannot delete the new row", () => {
    const root = path.join(os.tmpdir(), `dnb-fence-${crypto.randomUUID()}`);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const db = openDatabase(path.join(root, "catalog.sqlite"));
    try {
      const ownerA = new WorkerOwner(db);
      expect(ownerA.acquire()).toBe(true);
      backdateHeartbeat(db);
      const ownerB = new WorkerOwner(db);
      expect(ownerB.acquire()).toBe(true);

      // A's late release must not remove B's ownership row.
      ownerA.release();
      expect(ownerB.stillOwned()).toBe(true);
      ownerB.release();
    } finally {
      db.close();
    }
  });

  it("a fenced runtime cannot re-acquire ownership after takeover", async () => {
    const root = path.join(os.tmpdir(), `dnb-fence-runtime-${crypto.randomUUID()}`);
    await mkdir(path.join(root, "library"), { recursive: true });
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const runtimeA = createCatalogRuntime(testConfig(root), undefined, { passive: true });
    cleanups.push(() => runtimeA.close());

    // Simulate the moment after a takeover: another runtime owns the row.
    const db = openDatabase(testConfig(root).databasePath);
    try {
      const internalOwner = new WorkerOwner((runtimeA as unknown as { db: Database }).db);
      expect(internalOwner.acquire()).toBe(true);
      backdateHeartbeat(db);
      const ownerB = new WorkerOwner(db);
      expect(ownerB.acquire()).toBe(true);

      // The fenced runtime's owner can neither claim freshness nor re-acquire
      // against B's viable row; its pump therefore stops kicking work.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(internalOwner.heartbeat()).toBe(false);
      expect(internalOwner.stillOwned()).toBe(false);
      expect(internalOwner.acquire()).toBe(false);
      ownerB.release();
    } finally {
      db.close();
    }
  });

  it("a deposed owner cannot complete a render job recovered by takeover (R12)", async () => {
    const root = path.join(os.tmpdir(), `dnb-r12-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const catalog = createCatalogRuntime(testConfig(root), undefined, {
      useFakeFfmpeg: true,
      passive: true,
    });
    cleanups.push(() => catalog.close());
    const { writeSineWav } = await import("../src/index.ts");
    await writeSineWav(path.join(library, "a.wav"), { title: "Alpha", durationMs: 8000 });
    await writeSineWav(path.join(library, "b.wav"), { title: "Bravo", durationMs: 8000 });
    await catalog.service.scanLibrary();
    const tracks = catalog.service.searchTracks({ limit: 10 }).tracks;
    const alpha = tracks.find((track) => track.title === "Alpha")!;
    const bravo = tracks.find((track) => track.title === "Bravo")!;
    const plan = {
      schemaVersion: 1 as const,
      id: crypto.randomUUID(),
      name: "R12 fixture",
      targetDurationMs: 15_000,
      targetBpm: 174,
      requestedArc: [
        { atFraction: 0, targetEnergy: 3 },
        { atFraction: 1, targetEnergy: 6 },
      ],
      entries: [
        {
          id: crypto.randomUUID(),
          trackId: alpha.id,
          order: 0,
          sourceStartMs: 0,
          sourceEndMs: alpha.durationMs,
          timelineStartMs: 0,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: {
            id: crypto.randomUUID(),
            type: "crossfade" as const,
            durationMs: 500,
            outgoingCuePointId: null,
            incomingCuePointId: null,
            parameters: { purpose: "fixture" },
          },
        },
        {
          id: crypto.randomUUID(),
          trackId: bravo.id,
          order: 1,
          sourceStartMs: 0,
          sourceEndMs: bravo.durationMs,
          timelineStartMs: alpha.durationMs - 500,
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

    const db = (catalog as unknown as { db: Database }).db;
    const ownerA = new WorkerOwner(db);
    expect(ownerA.acquire()).toBe(true);
    const tokenA = ownerA.currentToken();
    expect(tokenA).not.toBeNull();

    const jobId = crypto.randomUUID();
    catalog.renderJobs.insertQueued({ id: jobId, kind: "full", setPlanId: plan.id, params: {} });
    const claimed = catalog.renderJobs.claimNextQueued(tokenA);
    expect(claimed?.id).toBe(jobId);
    expect(claimed?.status).toBe("running");

    // Takeover: A's heartbeat goes stale, B acquires, and recovery marks
    // the still-running job interrupted.
    backdateHeartbeat(db);
    const ownerB = new WorkerOwner(db);
    expect(ownerB.acquire()).toBe(true);
    expect(ownerB.currentToken()).not.toBe(tokenA);
    expect(catalog.renderJobs.failRunningAsInterrupted()).toBe(1);

    // A finishes anyway: its completion must be REJECTED — it cannot
    // overwrite the recovery state or publish its artifact.
    expect(() =>
      catalog.renderJobs.markSucceeded(
        jobId,
        {
          outputRelpath: "renders/rogue.wav",
          checksum: "deadbeef",
          manifest: {} as never,
          warnings: [],
        },
        tokenA,
      ),
    ).toThrow(/taken over/);
    const recovered = catalog.renderJobs.require(jobId);
    expect(recovered.status).toBe("failed");
    expect(recovered.errorCode).toBe("RENDER_INTERRUPTED");
    expect(recovered.outputRootRelativePath ?? null).toBeNull();

    // A's failure report is equally fenced: recovery state stays.
    catalog.renderJobs.markFailed(
      jobId,
      { code: "RENDER_FAILED", message: "late failure from deposed owner", retryable: false },
      undefined,
      tokenA,
    );
    expect(catalog.renderJobs.require(jobId).errorCode).toBe("RENDER_INTERRUPTED");

    // The winner re-queues the interrupted job and claims it under its own
    // token; A's stale token is now a claimed_by mismatch even while the
    // job is running again.
    db.prepare("UPDATE render_jobs SET status = 'queued', claimed_by = NULL WHERE id = ?").run(
      jobId,
    );
    const tokenB = ownerB.currentToken()!;
    const reclaimed = catalog.renderJobs.claimNextQueued(tokenB);
    expect(reclaimed?.id).toBe(jobId);
    expect(() =>
      catalog.renderJobs.markSucceeded(
        jobId,
        {
          outputRelpath: "renders/rogue.wav",
          checksum: "deadbeef",
          manifest: {} as never,
          warnings: [],
        },
        tokenA,
      ),
    ).toThrow(/taken over/);
    expect(catalog.renderJobs.require(jobId).status).toBe("running");
    ownerB.release();
  });

  it("a deposed analysis owner holds no current claim and writes no evidence (S5)", async () => {
    const root = path.join(os.tmpdir(), `dnb-s5-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, {
      useFakeFfmpeg: true,
      passive: true,
    });
    cleanups.push(() => catalog.close());
    const { writeSineWav } = await import("../src/index.ts");
    await writeSineWav(path.join(library, "a.wav"), { title: "Alpha", durationMs: 2000 });
    await catalog.service.scanLibrary();
    const trackId = catalog.repository.listAll()[0]!.id;

    const db = (catalog as unknown as { db: Database }).db;
    const ownerA = new WorkerOwner(db);
    expect(ownerA.acquire()).toBe(true);
    const tokenA = ownerA.currentToken()!;

    // Owner A claims an analysis job and is deposed mid-flight (heartbeat
    // expiry + takeover + recovery) BEFORE its evidence is written.
    const inserted = catalog.analysisJobs.insertQueued([trackId]);
    const jobId = inserted.id;
    const claimed = catalog.analysisJobs.claimNextQueued(tokenA);
    expect(claimed?.id).toBe(jobId);
    backdateHeartbeat(db);
    const ownerB = new WorkerOwner(db);
    expect(ownerB.acquire()).toBe(true);
    expect(catalog.analysisJobs.failRunningAsInterrupted()).toBe(1);

    // The authoritative cross-process claim check (S5): A's claim is gone
    // even though A's in-memory owned flag has not noticed yet; the
    // coordinator's persistence gates consult exactly this predicate.
    expect(catalog.analysisJobs.isClaimCurrent(jobId, tokenA)).toBe(false);
    expect(catalog.analysisJobs.isClaimCurrent(jobId, null)).toBe(false);

    // No catalog evidence exists for the deposed work, and the late fenced
    // terminal write is still rejected (R12 second defense).
    const stages = (db.prepare("SELECT COUNT(*) AS n FROM analysis_stages").get() as { n: number })
      .n;
    expect(stages).toBe(0);
    expect(catalog.analyses.findByTrackId(trackId)).toBeNull();
    expect(() => catalog.analysisJobs.markSucceeded(jobId, [trackId], [], tokenA)).toThrow(
      /taken over/,
    );
    expect(catalog.repository.findById(trackId)!.analysisStatus).not.toBe("failed");
    ownerB.release();
  });

  it("a deposed owner cannot publish the shared listen artifact mid-encode (S5)", async () => {
    const { createFakeFfmpegRunner } = await import("@dnb-crate/audio-renderer");
    const root = path.join(os.tmpdir(), `dnb-s5-pub-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const config = testConfig(root);

    // Runtime A: the ACTIVE worker whose listen encode BLOCKS on a delayed
    // runner until the test releases it — the real publication boundary.
    let releaseEncode!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseEncode = resolve;
    });
    const base = createFakeFfmpegRunner({ probeDurationSec: 16 });
    const delayedRunner = {
      run: async (request: {
        executable: string;
        args: string[];
        abortSignal?: AbortSignal;
        onStdout?: (chunk: string) => void;
        onStderr?: (chunk: string) => void;
      }) => {
        const result = await base.run(request);
        // Delay ONLY the listen encode — the dither filter marker is unique
        // to it (the master's staged flac shares the .partial.flac suffix).
        if (request.args.some((arg) => String(arg).includes("dither_method=triangular_hp"))) {
          await gate;
        }
        return result;
      },
    };
    const ownerA = createCatalogRuntime(config, undefined, { processRunner: delayedRunner });
    cleanups.push(() => ownerA.close());
    const { writeSineWav: writeWav } = await import("../src/index.ts");
    await writeWav(path.join(library, "a.wav"), { title: "Alpha", durationMs: 8000 });
    await writeWav(path.join(library, "b.wav"), { title: "Bravo", durationMs: 8000 });
    await ownerA.service.scanLibrary();
    const tracks = ownerA.service.searchTracks({ limit: 10 }).tracks;
    const plan = {
      schemaVersion: 1 as const,
      id: crypto.randomUUID(),
      name: "s5-pub",
      targetDurationMs: 15_000,
      targetBpm: 174,
      requestedArc: [
        { atFraction: 0, targetEnergy: 3 },
        { atFraction: 1, targetEnergy: 6 },
      ],
      entries: [
        {
          id: crypto.randomUUID(),
          trackId: tracks[0]!.id,
          order: 0,
          sourceStartMs: 0,
          sourceEndMs: tracks[0]!.durationMs,
          timelineStartMs: 0,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: {
            id: crypto.randomUUID(),
            type: "crossfade" as const,
            durationMs: 1000,
            outgoingCuePointId: null,
            incomingCuePointId: null,
            parameters: { purpose: "fixture" },
          },
        },
        {
          id: crypto.randomUUID(),
          trackId: tracks[1]!.id,
          order: 1,
          sourceStartMs: 0,
          sourceEndMs: tracks[1]!.durationMs,
          timelineStartMs: tracks[0]!.durationMs - 1000,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: null,
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    ownerA.setPlans.save(plan, 1, {
      seed: 1,
      selected: [],
      rejected: [],
      harmonicCoverage: { knownJoins: 0, totalJoins: 0 },
    });
    const started = await ownerA.service.startSetRender({ setPlanId: plan.id });
    // Wait until A is INSIDE the listen encode (blocked on the gate).
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const row = ownerA.renderJobs.findById(started.job.id);
      if (row?.progressMessage === "listen-encode") break;
      if (row && (row.status === "failed" || row.status === "succeeded")) {
        throw new Error(
          `render settled early: ${row.status} ${row.errorCode ?? ""} ${row.errorMessage ?? ""} (progress ${row.progressMessage})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(ownerA.renderJobs.findById(started.job.id)?.progressMessage).toBe("listen-encode");

    // Runtime B takes over mid-encode: heartbeat expiry + acquire + recover.
    const ownerB = createCatalogRuntime(config, undefined, {
      passive: true,
      useFakeFfmpeg: true,
    });
    cleanups.push(() => ownerB.close());
    const bdb = (ownerB as unknown as { db: Database }).db;
    backdateHeartbeat(bdb);
    const winner = new WorkerOwner(bdb);
    expect(winner.acquire()).toBe(true);
    expect(ownerB.renderJobs.failRunningAsInterrupted()).toBe(1);

    // Release A: the encode finishes, but the publication-boundary claim
    // check (between staging and publishing) refuses to write the
    // shared-name artifact, and the terminal write stays fenced.
    releaseEncode?.();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const settled = ownerB.renderJobs.findById(started.job.id)!;
    expect(settled.status).toBe("failed");
    expect(settled.errorCode).toBe("RENDER_INTERRUPTED");
    // The named listen file was never published by the deposed owner.
    const rendersDir = path.join(config.outputRoot, "renders");
    const files = await (await import("node:fs/promises")).readdir(rendersDir);
    const rogueListen = files.filter((name) => name.startsWith("s5-pub"));
    expect(rogueListen).toEqual([]);
    winner.release();
  }, 30_000);

  it("a deposed analysis owner writes no evidence when the subprocess straddles takeover (T2)", async () => {
    const { createFakeFfmpegRunner } = await import("@dnb-crate/audio-renderer");
    const root = path.join(os.tmpdir(), `dnb-t2-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const config = testConfig(root);

    // Runtime A: active worker whose LOUDNESS measurement (the ebur128
    // subprocess inside analyzeTrack) blocks until released — the exact
    // T2 window where the old code wrote the analysis row after the await.
    let releaseLoudness: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseLoudness = resolve;
    });
    const base = createFakeFfmpegRunner();
    const delayedRunner = {
      run: async (request: {
        executable: string;
        args: string[];
        abortSignal?: AbortSignal;
        onStdout?: (chunk: string) => void;
        onStderr?: (chunk: string) => void;
      }) => {
        const result = await base.run(request);
        if (request.args.some((arg) => String(arg).includes("ebur128=peak=true"))) {
          await gate;
        }
        return result;
      },
    };
    const ownerA = createCatalogRuntime(config, undefined, { processRunner: delayedRunner });
    cleanups.push(() => ownerA.close());
    const { writeSineWav: writeWav } = await import("../src/index.ts");
    await writeWav(path.join(library, "a.wav"), { title: "Alpha", durationMs: 2000 });
    await ownerA.service.scanLibrary();
    const trackId = ownerA.repository.listAll()[0]!.id;

    const started = ownerA.service.startTrackAnalysis({ trackIds: [trackId] });
    // Wait until A is INSIDE the delayed loudness measurement.
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Runtime B takes over mid-subprocess.
    const ownerB = createCatalogRuntime(config, undefined, {
      passive: true,
      useFakeFfmpeg: true,
    });
    cleanups.push(() => ownerB.close());
    const bdb = (ownerB as unknown as { db: Database }).db;
    backdateHeartbeat(bdb);
    const winner = new WorkerOwner(bdb);
    expect(winner.acquire()).toBe(true);
    expect(ownerB.analysisJobs.failRunningAsInterrupted()).toBe(1);

    // Release A: the DSP/loudness work completes, but every evidence write
    // is gated — no analysis row, no metadata, no cues, no stage.
    (releaseLoudness as unknown as () => void)();
    await ownerA.service.waitForAnalysisJob(started.job.id, 10_000).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const row = ownerB.analyses.findByTrackId(trackId);
    expect(row).toBeNull();
    const stages = (
      bdb.prepare("SELECT COUNT(*) AS n FROM analysis_stages WHERE track_id = ?").get(trackId) as {
        n: number;
      }
    ).n;
    expect(stages).toBe(0);
    expect(ownerB.repository.findById(trackId)!.analysisStatus).not.toBe("complete");
    const t2Job = ownerB.analysisJobs.findById(started.job.id)!;
    expect(t2Job.status).toBe("failed");
    winner.release();
  }, 30_000);

  it("publication is claim-atomic across processes: no interleaving between check and rename (T3)", async () => {
    const root = path.join(os.tmpdir(), `dnb-t3-race-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, {
      useFakeFfmpeg: true,
      passive: true,
    });
    cleanups.push(() => catalog.close());

    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const { writeSineWav: writeWav } = await import("../src/index.ts");
    await writeWav(path.join(library, "a.wav"), { title: "Alpha", durationMs: 2000 });
    await catalog.service.scanLibrary();
    const trackId = catalog.repository.listAll()[0]!.id;

    // A minimal stored plan to satisfy the render-job foreign key.
    const planId = crypto.randomUUID();
    catalog.setPlans.save(
      {
        schemaVersion: 1,
        id: planId,
        name: "t3-race",
        targetDurationMs: 15_000,
        targetBpm: 174,
        requestedArc: [
          { atFraction: 0, targetEnergy: 3 },
          { atFraction: 1, targetEnergy: 6 },
        ],
        entries: [
          {
            id: crypto.randomUUID(),
            trackId,
            order: 0,
            sourceStartMs: 0,
            sourceEndMs: 2000,
            timelineStartMs: 0,
            playbackRate: 1,
            gainDb: 0,
            transitionToNext: null,
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      1,
      { seed: 1, selected: [], rejected: [], harmonicCoverage: { knownJoins: 0, totalJoins: 0 } },
    );

    const makeJob = (token: string) => {
      const jobId = crypto.randomUUID();
      catalog.renderJobs.insertQueued({ id: jobId, kind: "full", setPlanId: planId });
      catalog.renderJobs.claimNextQueued(token);
      return jobId;
    };
    const dbPath = path.join(root, "catalog.sqlite");
    const { writeFile, readFile } = await import("node:fs/promises");

    // Scenario 1: the winner has ALREADY recovered and published; the
    // deposed owner's publish attempt must skip entirely (its check sees
    // the lost claim) and the winner's bytes stay intact.
    const jobId1 = makeJob("deposed-1");
    const winnerFile1 = path.join(root, "listen-1.flac");
    await writeFile(winnerFile1, "winner-bytes-1");
    const dbB1 = new DatabaseDefault(dbPath) as unknown as {
      prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
      close: () => void;
    };
    dbB1
      .prepare(
        "UPDATE render_jobs SET status = 'failed', error_code = 'RENDER_INTERRUPTED', claimed_by = NULL WHERE id = ?",
      )
      .run(jobId1);
    dbB1.close();
    let renamed1 = false;
    const published1 = await catalog.renderJobs.publishUnderClaim(jobId1, "deposed-1", async () => {
      renamed1 = true;
      await writeFile(winnerFile1, "deposed-bytes");
    });
    expect(published1).toBe(false);
    expect(renamed1).toBe(false);
    expect(await readFile(winnerFile1, "utf8")).toBe("winner-bytes-1");

    // Scenario 2: the takeover write is issued WHILE the publisher's
    // transaction is open (between its claim check and its rename). The
    // competing writer is a real CHILD PROCESS (better-sqlite3 writes are
    // synchronous and would freeze this process's event loop) — its UPDATE
    // blocks on the database write lock until the publisher commits,
    // proving no cross-process recovery can interleave between check and
    // rename.
    const jobId2 = makeJob("deposed-2");
    const target2 = path.join(root, "listen-2.flac");
    let renameStarted = false;
    let releaseRename: (() => void) | null = null;
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const { spawn } = await import("node:child_process");
    const { createRequire } = await import("node:module");
    const modPath = createRequire(
      "C:/Users/arild/repos/dnb-crate/packages/catalog/package.json",
    ).resolve("better-sqlite3");
    const child = spawn(process.execPath, [
      "-e",
      `
      const Database = require(${JSON.stringify(modPath)});
      const db = new Database(${JSON.stringify(dbPath)});
      process.stdin.resume();
      process.stdin.on("data", () => {
        try {
          db.prepare("UPDATE render_jobs SET status = 'failed', error_code = 'RENDER_INTERRUPTED', claimed_by = NULL WHERE id = ?").run(${JSON.stringify(jobId2)});
          process.stdout.write("done");
        } catch (error) {
          process.stdout.write("error:" + (error && error.message));
        }
      });
    `,
    ]);
    const childDone = new Promise<string>((resolve) => {
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes("done") || out.includes("error:")) {
          resolve(out.trim());
        }
      });
    });
    // Give the child time to open its connection, then start the publish
    // transaction with a rename that waits on our gate.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const publishPromise = catalog.renderJobs.publishUnderClaim(jobId2, "deposed-2", async () => {
      renameStarted = true;
      await renameGate;
      await writeFile(target2, "deposed-published");
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(renameStarted).toBe(true);
    // Fire the child's takeover write: it must BLOCK on the write lock.
    child.stdin.write("go");
    await new Promise((resolve) => setTimeout(resolve, 250));
    // The child has not completed — its write is excluded by the open
    // publish transaction.
    expect(
      await Promise.race([
        childDone,
        new Promise<string>((resolve) => setTimeout(() => resolve("__pending"), 50)),
      ]),
    ).toBe("__pending");
    // Release the rename; the publish commits; the child's write proceeds.
    (releaseRename as unknown as () => void)();
    const published2 = await publishPromise;
    expect(published2).toBe(true);
    expect(await childDone).toBe("done");
    child.kill();
    expect(catalog.renderJobs.require(jobId2).status).toBe("failed");
    expect(await readFile(target2, "utf8")).toBe("deposed-published");
  }, 60_000);
});
