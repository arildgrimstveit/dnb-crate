import { afterEach, describe, expect, it, vi } from "vitest";

import { toPublicTrack } from "@dnb-crate/domain";

import { openDatabase, TrackRepository } from "../src/index.ts";
import type { SqliteDatabase } from "../src/db.ts";

let db: SqliteDatabase | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
  db = undefined;
});

function library(count: number) {
  db = openDatabase(":memory:");
  const repository = new TrackRepository(db);
  repository.withTransaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `track-${String(i).padStart(4, "0")}`;
      repository.upsertFromScan({
        id,
        filePath: `/fixture/${id}.mp3`,
        fileFingerprint: id,
        artist: "Fixture",
        title: id,
        album: null,
        durationMs: 12_000,
        sampleRateHz: 44_100,
        channels: 2,
        bpm: null,
        bpmSource: null,
        musicalKey: null,
        camelotKey: null,
        keySource: null,
      });
    }
  });
  return repository;
}

describe("catalog reads", () => {
  it("batches relations beyond SQLite's traditional parameter limit and retains per-track metadata", () => {
    const repository = library(1100);
    repository.updateMetadata("track-0000", {
      moods: ["rolling", "deep"],
      subgenres: ["liquid"],
      tags: ["warm", "favorite"],
      genres: ["drum and bass"],
      album: "Manual album",
    });
    repository.updateMetadata("track-1099", { moods: ["dark"], tags: ["closer"] });
    const first = repository.findById("track-0000")!;
    const last = repository.findById("track-1099")!;
    const prepare = vi.spyOn(db!, "prepare");
    const all = repository.listAll();
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(6);
    expect(all).toHaveLength(1100);
    expect(all.find((track) => track.id === first.id)).toEqual(first);
    expect(all.find((track) => track.id === last.id)).toEqual(last);
    expect(all.find((track) => track.id === "track-0500")?.moods).toEqual([]);
    expect(first.moods).toEqual(["deep", "rolling"]);

    prepare.mockClear();
    const page = repository.search({ limit: 50, sort: "title" });
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(6);
    expect(page.tracks[0]).toEqual(toPublicTrack(first));
    expect(page.tracks).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
    // No cache may hide a later metadata edit.
    repository.updateMetadata(first.id, { moods: ["new"] });
    expect(repository.listAll().find((track) => track.id === first.id)?.moods).toEqual(["new"]);
    expect(repository.search({ query: "absent" }).tracks).toEqual([]);
  });

  it.each(["asc", "desc"] as const)(
    "paginates missing BPMs last without skips or repeats (%s)",
    (direction) => {
      const repository = library(5);
      repository.updateMetadata("track-0000", { bpm: 174 });
      repository.updateMetadata("track-0001", { bpm: 172 });
      repository.updateMetadata("track-0002", { bpm: 174 });
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 6; pageIndex++) {
        const page = repository.search({ sort: "bpm", direction, limit: 1, cursor });
        ids.push(...page.tracks.map((track) => track.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      const order = direction === "asc" ? [1, 0, 2, 3, 4] : [2, 0, 1, 4, 3];
      expect(ids).toEqual(order.map((i) => `track-000${i}`));
    },
  );
});
