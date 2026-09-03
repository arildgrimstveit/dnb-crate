import { mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "@dnb-crate/domain";
import { DomainError } from "@dnb-crate/domain";

import { createCatalogRuntime, writeSineWav } from "../src/index.ts";
import { isPathInsideRoot } from "../src/paths.ts";

function testConfig(root: string): AppConfig {
  return {
    databasePath: path.join(root, "catalog.sqlite"),
    libraryRoots: [path.join(root, "library")],
    outputRoot: path.join(root, "output"),
    logLevel: "error",
    supportedExtensions: [".wav", ".flac", ".mp3", ".m4a", ".aiff", ".aif"],
  };
}

async function makeWorkspace(): Promise<{ root: string; library: string; config: AppConfig }> {
  const unique = path.join(
    os.tmpdir(),
    `dnb-crate-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(unique, { recursive: true });
  const library = path.join(unique, "library");
  await mkdir(library, { recursive: true });
  return { root: unique, library, config: testConfig(unique) };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("path containment", () => {
  it("treats a file in the root as inside and a sibling as outside", () => {
    const root = path.resolve("/music/library");
    expect(isPathInsideRoot(path.join(root, "a.wav"), root)).toBe(true);
    expect(isPathInsideRoot(path.resolve("/music/other/a.wav"), root)).toBe(false);
    expect(isPathInsideRoot(path.resolve("/music/library-extra/a.wav"), root)).toBe(false);
  });
});

describe("catalog repository and scanner", () => {
  it("ingests tagged wavs, skips unsupported and malformed files, and searches with filters", async () => {
    const { library, config } = await makeWorkspace();
    const runtime = createCatalogRuntime(config);
    cleanups.push(() => runtime.close());

    await writeSineWav(path.join(library, "nightfall.wav"), {
      title: "The Nightfall",
      artist: "Technimatic",
      album: "Soul Charity",
      durationMs: 400,
    });
    await writeSineWav(path.join(library, "untitled.wav"), { durationMs: 300 });
    await writeFile(path.join(library, "notes.txt"), "not audio");
    await writeFile(path.join(library, "broken.wav"), Buffer.from("not a wav"));

    const scan = await runtime.service.scanLibrary();
    expect(scan.result.upserted).toBe(2);
    expect(scan.result.skippedUnsupported).toBe(1);
    expect(scan.result.skippedMalformed).toBe(1);
    expect(scan.warnings.some((warning) => warning.includes("broken.wav"))).toBe(true);

    const byArtist = runtime.service.searchTracks({ artist: "Technimatic" });
    expect(byArtist.tracks).toHaveLength(1);
    expect(byArtist.tracks[0]?.title).toBe("The Nightfall");
    expect(byArtist.tracks[0]?.artist).toBe("Technimatic");
    expect(byArtist.tracks[0]).not.toHaveProperty("filePath");

    const nightfall = runtime.service.getTrack(byArtist.tracks[0]!.id);
    runtime.service.updateTrackMetadata(nightfall.id, {
      energy: 6,
      rating: 5,
      moods: ["emotional", "liquid"],
      subgenres: ["liquid"],
      tags: ["technimatic"],
      notes: "Peak-time closer",
    });

    const filtered = runtime.service.searchTracks({
      query: "Nightfall",
      minRating: 5,
      moods: ["liquid"],
      subgenres: ["liquid"],
      tags: ["technimatic"],
      energyMin: 5,
      energyMax: 8,
    });
    expect(filtered.tracks).toHaveLength(1);

    runtime.db.prepare("UPDATE tracks SET bpm = 174 WHERE id = ?").run(nightfall.id);
    expect(runtime.service.searchTracks({ bpmMin: 172, bpmMax: 176 }).tracks).toHaveLength(1);

    const stats = runtime.service.getLibraryStats();
    expect(stats.trackCount).toBe(2);
    expect(stats.missingArtistCount).toBe(1);
    expect(stats.extensionCounts[".wav"]).toBe(2);
    expect(stats.analysisCoverage.analyzed).toBe(0);
    expect(stats.analysisCoverage.notAnalyzed).toBe(2);
    expect(stats.metadataCoverage.energy).toBe(1);
    expect(stats.metadataCoverage.moods).toBe(1);
    expect(stats.metadataCoverage.genres).toBe(0);
  });

  it("paginates deterministically and rejects a corrupted cursor", async () => {
    const { library, config } = await makeWorkspace();
    const runtime = createCatalogRuntime(config);
    cleanups.push(() => runtime.close());

    for (const title of ["Alpha", "Bravo", "Charlie", "Delta"]) {
      await writeSineWav(path.join(library, `${title}.wav`), {
        title,
        artist: "Fixture",
        durationMs: 200,
      });
    }
    await runtime.service.scanLibrary();

    const page1 = runtime.service.searchTracks({ sort: "title", direction: "asc", limit: 2 });
    expect(page1.tracks.map((track) => track.title)).toEqual(["Alpha", "Bravo"]);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = runtime.service.searchTracks({
      sort: "title",
      direction: "asc",
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.tracks.map((track) => track.title)).toEqual(["Charlie", "Delta"]);

    expect(() => runtime.service.searchTracks({ cursor: "%%%not-a-cursor%%%" })).toThrow(
      DomainError,
    );
  });

  it("marks removed files missing without deleting records", async () => {
    const { library, config } = await makeWorkspace();
    const runtime = createCatalogRuntime(config);
    cleanups.push(() => runtime.close());

    const filePath = path.join(library, "gone.wav");
    await writeSineWav(filePath, { title: "Gone", artist: "Ghost", durationMs: 200 });
    await runtime.service.scanLibrary();
    await rm(filePath);

    const second = await runtime.service.scanLibrary();
    expect(second.result.markedMissing).toBe(1);
    const found = runtime.service.searchTracks({ query: "Gone" });
    expect(found.tracks[0]?.fileMissing).toBe(true);
  });

  it("updates a moved file in place when the fingerprint matches a missing record", async () => {
    const { library, config } = await makeWorkspace();
    const runtime = createCatalogRuntime(config);
    cleanups.push(() => runtime.close());

    const original = path.join(library, "move-me.wav");
    await writeSineWav(original, { title: "Mover", artist: "Portable", durationMs: 220 });
    await runtime.service.scanLibrary();
    const before = runtime.service.searchTracks({ query: "Mover" }).tracks[0];
    expect(before).toBeTruthy();

    await rm(original);
    await runtime.service.scanLibrary();

    const relocated = path.join(library, "nested");
    await mkdir(relocated, { recursive: true });
    await writeSineWav(path.join(relocated, "move-me.wav"), {
      title: "Mover",
      artist: "Portable",
      durationMs: 220,
    });
    const afterScan = await runtime.service.scanLibrary();
    expect(afterScan.result.moved).toBe(1);
    const after = runtime.service.searchTracks({ query: "Mover" });
    expect(after.tracks).toHaveLength(1);
    expect(after.tracks[0]?.id).toBe(before?.id);
    expect(after.tracks[0]?.fileMissing).toBe(false);
  });

  it("does not follow a symlink that escapes the library root", async () => {
    const { library, config } = await makeWorkspace();
    const outsideDir = path.join(path.dirname(library), "outside");
    await mkdir(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "secret.wav");
    await writeSineWav(outsideFile, { title: "Secret", artist: "Nope", durationMs: 200 });

    const linkPath = path.join(library, "escape.wav");
    try {
      await symlink(outsideFile, linkPath);
    } catch (error) {
      // Windows may require Developer Mode for file symlinks.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        return;
      }
      throw error;
    }

    const runtime = createCatalogRuntime(config);
    cleanups.push(() => runtime.close());
    const scan = await runtime.service.scanLibrary();
    expect(scan.result.upserted).toBe(0);
    expect(scan.warnings.some((warning) => warning.toLowerCase().includes("symlink"))).toBe(true);
    expect(runtime.service.searchTracks({ query: "Secret" }).tracks).toHaveLength(0);
  });

  it("rejects metadata outside allowed ranges", async () => {
    const { library, config } = await makeWorkspace();
    const runtime = createCatalogRuntime(config);
    cleanups.push(() => runtime.close());
    await writeSineWav(path.join(library, "range.wav"), { title: "Range", durationMs: 200 });
    await runtime.service.scanLibrary();
    const id = runtime.service.searchTracks({ query: "Range" }).tracks[0]!.id;

    expect(() => runtime.service.updateTrackMetadata(id, { energy: 11 })).toThrow(DomainError);
    expect(() => runtime.service.updateTrackMetadata(id, { rating: 0 })).toThrow(DomainError);
  });

  it("stores published BPM provenance", async () => {
    const { library, config } = await makeWorkspace();
    const runtime = createCatalogRuntime(config);
    cleanups.push(() => runtime.close());
    await writeSineWav(path.join(library, "store.wav"), { title: "Store", durationMs: 200 });
    await runtime.service.scanLibrary();
    const id = runtime.service.searchTracks({ query: "Store" }).tracks[0]!.id;
    const updated = runtime.service.updateTrackMetadata(id, { bpm: 174, bpmSource: "published" });
    expect(updated.bpm).toBe(174);
    expect(updated.bpmSource).toBe("published");
  });
});
