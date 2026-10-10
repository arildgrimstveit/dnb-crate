import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
});
