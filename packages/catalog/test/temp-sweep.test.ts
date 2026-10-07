import { mkdir, mkdtemp, rm, utimes, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { sweepStaleRenderTemps, TEMP_SWEEP_MIN_AGE_MS } from "../src/render/temp-sweep.ts";

async function touch(file: string, ageMs: number): Promise<void> {
  await writeFile(file, "x");
  const when = new Date(Date.now() - ageMs);
  await utimes(file, when, when);
}

describe("sweepStaleRenderTemps", () => {
  it("removes only stale renderer temp files, keeping fresh and final files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dnb-sweep-"));
    const renders = path.join(root, "renders");
    const cache = path.join(root, "cache", "previews");
    await mkdir(renders, { recursive: true });
    await mkdir(cache, { recursive: true });

    const staleJoin = path.join(renders, "job.join-0.wav");
    const staleStitch = path.join(renders, "job.stitch-1.wav");
    const stalePartial = path.join(renders, "job.partial.wav");
    const staleRb = path.join(cache, "preview.rb0.wav");
    const staleSlice = path.join(cache, "preview.rb0.slice.wav");
    const staleListen = path.join(renders, "plan.uuid.partial.flac");
    const staleGained = path.join(renders, "job.gained.wav");
    const staleLimited = path.join(renders, "job.peak-limited.wav");
    for (const file of [
      staleJoin,
      staleStitch,
      stalePartial,
      staleRb,
      staleSlice,
      staleListen,
      staleGained,
      staleLimited,
    ]) {
      await touch(file, 2 * TEMP_SWEEP_MIN_AGE_MS);
    }

    const freshJoin = path.join(renders, "live.join-0.wav");
    await touch(freshJoin, 1000);
    const master = path.join(renders, "job.flac");
    const unrelated = path.join(renders, "notes.txt");
    await touch(master, 2 * TEMP_SWEEP_MIN_AGE_MS);
    await touch(unrelated, 2 * TEMP_SWEEP_MIN_AGE_MS);

    const removed = await sweepStaleRenderTemps(root);
    // The OS-tmpdir safety net may remove unrelated stale dnb-* dirs from
    // earlier sessions; scope the count to this test's output root.
    const removedInRoot = removed.filter((entry) => entry.startsWith(root));
    expect(removedInRoot.length).toBe(8);
    const remaining = new Set((await Promise.all([readdir(renders), readdir(cache)])).flat());
    expect(remaining.has("live.join-0.wav")).toBe(true);
    expect(remaining.has("job.flac")).toBe(true);
    expect(remaining.has("notes.txt")).toBe(true);
    expect([...remaining].some((name) => name.endsWith(".partial.wav"))).toBe(false);
  });

  it("sweeps stale dnb-* scratch directories from the OS temp dir", async () => {
    const stale = path.join(
      os.tmpdir(),
      `dnb-band-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const fresh = path.join(
      os.tmpdir(),
      `dnb-band-test-fresh-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const foreign = path.join(
      os.tmpdir(),
      `not-ours-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const fixtures = [stale, fresh, foreign];
    try {
      await mkdir(stale, { recursive: true });
      await mkdir(fresh, { recursive: true });
      await mkdir(foreign, { recursive: true });
      await writeFile(path.join(stale, "swap.wav"), "x");
      const old = new Date(Date.now() - 2 * TEMP_SWEEP_MIN_AGE_MS);
      await utimes(stale, old, old);

      const root = await mkdtemp(path.join(os.tmpdir(), "dnb-sweep-"));
      const removed = await sweepStaleRenderTemps(root);
      expect(removed).toContain(stale);
      expect(removed).not.toContain(fresh);
      expect(removed).not.toContain(foreign);
    } finally {
      await Promise.allSettled(fixtures.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  });

  it("survives a missing output root", async () => {
    const removed = await sweepStaleRenderTemps(path.join(os.tmpdir(), "does-not-exist-dnb"));
    expect(removed).toEqual([]);
  });
});
