import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "@dnb-crate/domain";
import { createCatalogRuntime, writeSineWav } from "../src/index.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("migration 020: descriptor keys renamed", () => {
  it("renames stored shortTermLufs keys in place, preserving values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dnb-m020-"));
    cleanups.push(() =>
      import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true })),
    );
    const library = path.join(root, "library");
    await mkdir(library);
    await writeSineWav(path.join(library, "a.wav"), { title: "A", durationMs: 1000 });
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

    // Plant a legacy pre-3.5.0 descriptors row with distinctive values.
    const trackId = runtime.repository.listAll()[0]!.id;
    const legacy = {
      shortTermLufsMean: -18.25,
      shortTermLufsMax: -6.5,
      energy: 0.6,
      subBassRatio: 0.4,
      brightness: 0.2,
    };
    runtime.db
      .prepare(
        `INSERT INTO track_analyses (
           track_id, analyzer_name, analyzer_version, bpm, bpm_confidence, bpm_raw,
           beat_times_json, downbeat_times_json, grid_rejected, grid_rejection_reason, grid_source,
           musical_key, key_confidence, key_mode, camelot_key, tempo_stability, downbeat_confidence,
           integrated_lufs, true_peak_db, low_band_energy, mid_band_energy, high_band_energy,
           waveform_summary_json, beat_anchor_ms, suggested_cues_json, descriptors_json,
           engine_runtime_ms, analyzed_at
         ) VALUES (?, 'dnb-crate-dsp', '3.4.0', 174, 0.9, 174,
                   '[]', '[]', 0, NULL, 'analyzed',
                   NULL, NULL, NULL, NULL, NULL, NULL,
                   NULL, NULL, NULL, NULL, NULL,
                   NULL, NULL, '[]', ?, 1, ?)`,
      )
      .run(trackId, JSON.stringify(legacy), new Date().toISOString());
    runtime.db.prepare("DELETE FROM schema_migrations WHERE id = 20").run();
    await runtime.close();

    const reopened = createCatalogRuntime(config, undefined, { useFakeFfmpeg: true });
    cleanups.push(() => reopened.close());

    const row = reopened.db
      .prepare("SELECT descriptors_json FROM track_analyses WHERE track_id = ?")
      .get(trackId) as { descriptors_json: string };
    const descriptors = JSON.parse(row.descriptors_json) as Record<string, unknown>;
    expect(descriptors.shortTermRmsDbfsMean).toBe(-18.25);
    expect(descriptors.shortTermRmsDbfsMax).toBe(-6.5);
    expect("shortTermLufsMean" in descriptors).toBe(false);
    expect("shortTermLufsMax" in descriptors).toBe(false);
    expect(descriptors.energy).toBe(0.6);
  });
});
