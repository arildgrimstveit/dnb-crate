import { readFile } from "node:fs/promises";
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
