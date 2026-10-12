import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import DatabaseDefault from "better-sqlite3";

import type { AppConfig, SetPlanV1 } from "@dnb-crate/domain";

import { createCatalogRuntime, writeSineWav } from "../src/index.ts";
import { migration027StoredJoinContracts } from "../src/migrations/027_stored_join_contracts.ts";

function testConfig(root: string): AppConfig {
  return {
    databasePath: path.join(root, "catalog.sqlite"),
    libraryRoots: [path.join(root, "library")],
    outputRoot: path.join(root, "output"),
    logLevel: "error",
    supportedExtensions: [".wav"],
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("migration 027: stored join contracts (Q03 slice 3)", () => {
  it("upgrades legacy recipeVersion pins to stamped contracts and retires the flag", async () => {
    const root = path.join(
      os.tmpdir(),
      `dnb-mig027-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const config = testConfig(root);
    const catalog = createCatalogRuntime(config, undefined, { useFakeFfmpeg: true });
    cleanups.push(async () => {
      await catalog.close();
      await rm(root, { recursive: true, force: true });
    });
    await writeSineWav(path.join(library, "alpha.wav"), {
      title: "Alpha",
      artist: "A",
      durationMs: 20_000,
    });
    await writeSineWav(path.join(library, "bravo.wav"), {
      title: "Bravo",
      artist: "B",
      durationMs: 20_000,
    });
    await catalog.service.scanLibrary();
    const tracks = catalog.service.searchTracks({ limit: 10 }).tracks;
    const alpha = tracks.find((item) => item.title === "Alpha")!;
    const bravo = tracks.find((item) => item.title === "Bravo")!;

    // A LEGACY plan: recipeVersion pin, no contract (pre-Q03 shape).
    const plan: SetPlanV1 = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      name: "legacy-pin",
      targetDurationMs: 30_000,
      targetBpm: 174,
      requestedArc: [
        { atFraction: 0, targetEnergy: 5 },
        { atFraction: 1, targetEnergy: 5 },
      ],
      entries: [
        {
          id: crypto.randomUUID(),
          trackId: alpha.id,
          order: 0,
          sourceStartMs: 0,
          sourceEndMs: 12_000,
          timelineStartMs: 0,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: {
            id: crypto.randomUUID(),
            type: "phrase_mix",
            durationMs: 5517,
            outgoingCuePointId: null,
            incomingCuePointId: null,
            parameters: {
              barCount: 16,
              targetBpm: 174,
              mixOutMs: 12_000 - 5517,
              mixInMs: 3000,
              incomingTrackId: bravo.id,
              downbeatOffsetMs: 0,
              alignmentMode: "bar",
              alignmentPeriodMs: Number(((60_000 / 174) * 4).toFixed(3)),
              recipeVersion: 1,
            },
          },
        },
        {
          id: crypto.randomUUID(),
          trackId: bravo.id,
          order: 1,
          sourceStartMs: 3000,
          sourceEndMs: 15_000,
          timelineStartMs: 12_000 - 5517,
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

    // Run the upgrade on a second connection, exactly as a migration would.
    const db = new DatabaseDefault(config.databasePath);
    migration027StoredJoinContracts.up(db);
    db.close();

    const upgraded = { plan: catalog.service.getSetPlan(plan.id) };
    const parameters = upgraded.plan.entries[0]!.transitionToNext!.parameters as Record<
      string,
      unknown
    > & {
      resolvedJoin?: {
        schemaVersion: number;
        geometry: { joinOutputAnchorMs: number };
        evidence: { outgoingFingerprint: string };
      };
    };
    // The flag is retired; the contract carries the semantics.
    expect(parameters.recipeVersion).toBeUndefined();
    expect(parameters.resolvedJoin).toBeTruthy();
    expect(parameters.resolvedJoin!.schemaVersion).toBe(1);
    // The anchor is the incoming entry's timeline position; the evidence
    // fingerprints came from the tracks table.
    expect(parameters.resolvedJoin!.geometry.joinOutputAnchorMs).toBe(
      upgraded.plan.entries[1]!.timelineStartMs,
    );
    expect(parameters.resolvedJoin!.evidence.outgoingFingerprint).toBeTruthy();

    // Idempotent: running the upgrade again changes nothing.
    const db2 = new DatabaseDefault(config.databasePath);
    migration027StoredJoinContracts.up(db2);
    db2.close();
    const again = { plan: catalog.service.getSetPlan(plan.id) };
    expect(
      (again.plan.entries[0]!.transitionToNext!.parameters as Record<string, unknown>).resolvedJoin,
    ).toBeTruthy();
  });
});
