import { readFile, writeFile, readdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFakeFfmpegRunner,
  detectFfmpeg,
  encodeListenFlac,
  listenCopyFailureReason,
  requireFfmpeg,
} from "../src/index.ts";

describe("encodeListenFlac", () => {
  it.each(["runner rejection", "cancelled verification"])(
    "cleans the stage and preserves the published file after %s",
    async (failure) => {
      const base = createFakeFfmpegRunner();
      const binaries = requireFfmpeg(
        await detectFfmpeg(base, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" }),
      );
      const root = await mkdtemp(path.join(os.tmpdir(), "dnb-listen-failure-"));
      try {
        const listen = path.join(root, "named.flac");
        await writeFile(listen, "previous verified output");
        const controller = new AbortController();
        const runner = {
          async run(request: Parameters<typeof base.run>[0]) {
            const result = await base.run(request);
            if (failure === "runner rejection")
              throw new Error("runner failed after writing stage");
            return result;
          },
        };
        await expect(
          encodeListenFlac(
            runner,
            binaries,
            path.join(root, "master.flac"),
            listen,
            controller.signal,
            () => {
              controller.abort();
              return Promise.resolve();
            },
          ),
        ).rejects.toThrow(failure === "runner rejection" ? "runner failed" : "Render cancelled");
        expect(await readFile(listen, "utf8")).toBe("previous verified output");
        expect((await readdir(root)).filter((name) => name.includes(".partial.flac"))).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("verifies private stages before publishing and cannot delete another job's output", async () => {
    const runner = createFakeFfmpegRunner();
    const binaries = requireFfmpeg(
      await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" }),
    );
    const root = path.join(os.tmpdir(), `dnb-listen-verify-${crypto.randomUUID()}`);
    const listen = path.join(root, "named.flac");
    const master = path.join(root, "master.flac");
    await encodeListenFlac(runner, binaries, master, listen);
    await writeFile(listen, "previous verified output");
    let entered!: () => void;
    let release!: () => void;
    const verifying = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failed = encodeListenFlac(runner, binaries, master, listen, undefined, async (staged) => {
      expect(staged).not.toBe(listen);
      entered();
      await held;
      const failure = listenCopyFailureReason({ integratedLufs: -14, truePeakDb: -0.5 }, -1);
      throw new Error(failure!);
    });
    const rejection = expect(failed).rejects.toThrow(/exceeds ceiling/);
    await verifying;
    expect(await readFile(listen, "utf8")).toBe("previous verified output");
    await encodeListenFlac(runner, binaries, master, listen, undefined, async (staged) => {
      expect(listenCopyFailureReason({ integratedLufs: -14, truePeakDb: -0.5 }, 0)).toBeNull();
      await writeFile(staged, "second verified output");
    });
    release();
    await rejection;
    expect(await readFile(listen, "utf8")).toBe("second verified output");
    expect((await readdir(root)).filter((name) => name.includes(".partial.flac"))).toEqual([]);
  });
  it("writes the listen path through the runner", async () => {
    const runner = createFakeFfmpegRunner();
    const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    requireFfmpeg(binaries);
    const root = path.join(
      os.tmpdir(),
      `dnb-listen-unit-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const master = path.join(root, "master.flac");
    const listen = path.join(root, "named.flac");
    await encodeListenFlac(runner, binaries!, master, listen);
    await expect(readFile(listen)).resolves.toBeInstanceOf(Buffer);
  });

  it("uses a unique staging file per overlapping encode", async () => {
    const base = createFakeFfmpegRunner();
    const binaries = await detectFfmpeg(base, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    requireFfmpeg(binaries);
    const root = path.join(os.tmpdir(), `dnb-listen-race-${crypto.randomUUID()}`);
    const master = path.join(root, "master.flac");
    const listen = path.join(root, "named.flac");
    const partials: string[] = [];
    let entered = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = {
      async run(request: Parameters<typeof base.run>[0]) {
        const last = request.args.at(-1);
        if (typeof last === "string" && last.includes(".partial.flac")) {
          partials.push(last);
          entered += 1;
          if (entered < 2) {
            await held;
          } else {
            release();
          }
        }
        return base.run(request);
      },
    };
    await Promise.all([
      encodeListenFlac(runner, binaries!, master, listen),
      encodeListenFlac(runner, binaries!, master, listen),
    ]);
    expect(new Set(partials).size).toBe(2);
    await expect(readFile(listen)).resolves.toBeInstanceOf(Buffer);
  });
});

describe("listenCopyFailureReason", () => {
  it("accepts a finite measurement under the ceiling", () => {
    expect(listenCopyFailureReason({ integratedLufs: -14.1, truePeakDb: -1.2 }, -1)).toBeNull();
  });

  it("rejects a missing measurement or a peak over the ceiling", () => {
    expect(listenCopyFailureReason({ integratedLufs: null, truePeakDb: -1.2 }, -1)).toMatch(
      /measurement failed/,
    );
    expect(listenCopyFailureReason({ integratedLufs: -14.1, truePeakDb: 0.2 }, -1)).toMatch(
      /exceeds ceiling/,
    );
  });
});
