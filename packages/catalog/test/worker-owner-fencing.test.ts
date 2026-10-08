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
});
