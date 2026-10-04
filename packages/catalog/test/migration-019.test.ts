import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "@dnb-crate/domain";
import { createCatalogRuntime, writeSineWav } from "../src/index.ts";
import type { StoredSetPlan } from "../src/set-plan-repository.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("migration 019: double_drop retired", () => {
  it("rewrites stored double_drop transitions and recipe payloads to phrase_mix", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dnb-m019-"));
    cleanups.push(() =>
      import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true })),
    );
    const library = path.join(root, "library");
    await mkdir(library);
    await writeSineWav(path.join(library, "a.wav"), { title: "A", durationMs: 120_000 });
    await writeSineWav(path.join(library, "b.wav"), { title: "B", durationMs: 120_000 });
    const config: AppConfig = {
      databasePath: path.join(root, "catalog.sqlite"),
      libraryRoots: [library],
      outputRoot: path.join(root, "output"),
      logLevel: "error",
      supportedExtensions: [".wav"],
    };

    const runtime = createCatalogRuntime(config, undefined, { useFakeFfmpeg: true });
    cleanups.push(() => runtime.close());
    await runtime.service.scanLibrary();
    for (const track of runtime.repository.listAll()) {
      runtime.service.updateTrackMetadata(track.id, { bpm: 174, musicalKey: "Am", energy: 6 });
    }
    const created = runtime.service.createSetPlan({
      name: "legacy",
      targetDurationMinutes: 4,
      qualityPolicy: "off",
    });
    const entry = created.plan.entries.find((candidate) => candidate.transitionToNext !== null);
    const originalTransition = entry?.transitionToNext ?? null;
    expect(originalTransition).not.toBeNull();

    // Simulate a legacy pre-019 catalog: one double_drop entry transition and
    // one double_drop approved-recipe payload.
    if (entry && originalTransition) {
      runtime.db
        .prepare("UPDATE set_plan_entries SET transition_json = ? WHERE id = ?")
        .run(JSON.stringify({ ...originalTransition, type: "double_drop" }), entry.id);
    }
    runtime.db
      .prepare(
        `INSERT INTO approved_recipes (
           id, status, pair_key, reusable_fingerprint, payload_json,
           outgoing_track_id, incoming_track_id, created_at
         ) VALUES ('legacy-1', 'accepted', 'a->b', 'fp', ?,
                   'a', 'b', ?)`,
      )
      .run(
        JSON.stringify({ type: "double_drop", durationMs: 16000, parameters: {} }),
        new Date().toISOString(),
      );
    runtime.db.prepare("DELETE FROM schema_migrations WHERE id = 19").run();
    await runtime.close();

    const reopened = createCatalogRuntime(config, undefined, { useFakeFfmpeg: true });
    cleanups.push(() => reopened.close());

    const stored = reopened.setPlans.findById(created.plan.id) as StoredSetPlan;
    expect(entry).toBeDefined();
    const storedEntry = stored.plan.entries.find(
      (candidate) => entry !== undefined && candidate.id === entry.id,
    );
    expect(storedEntry?.transitionToNext?.type).toBe("phrase_mix");
    const payloadRow = reopened.db
      .prepare("SELECT payload_json FROM approved_recipes WHERE id = 'legacy-1'")
      .get() as { payload_json: string };
    const payload = JSON.parse(payloadRow.payload_json) as { type: string };
    expect(payload.type).toBe("phrase_mix");
  });
});
