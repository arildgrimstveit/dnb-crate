import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createFakeFfmpegRunner, detectFfmpeg, encodeListenFlac, requireFfmpeg } from "../src/index.ts";

describe("encodeListenFlac", () => {
  it("writes the listen path through the runner", async () => {
    const runner = createFakeFfmpegRunner();
    const binaries = await detectFfmpeg(runner, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    requireFfmpeg(binaries!);
    const root = path.join(
      os.tmpdir(),
      `dnb-listen-unit-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const master = path.join(root, "master.flac");
    const listen = path.join(root, "named.flac");
    await encodeListenFlac(runner, binaries!, master, listen);
    await expect(readFile(listen)).resolves.toBeInstanceOf(Buffer);
  });
});
