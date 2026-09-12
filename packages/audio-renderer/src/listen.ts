import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { DomainError } from "@dnb-crate/domain";

import type { FfmpegBinaries } from "./detect.ts";
import type { ProcessRunner } from "./runner.ts";

const LISTEN_FLAC_COMPRESSION_LEVEL = 8;

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // missing is fine
  }
}

async function atomicReplace(fromPath: string, toPath: string): Promise<void> {
  await removeIfPresent(toPath);
  try {
    await rename(fromPath, toPath);
  } catch {
    const { copyFile } = await import("node:fs/promises");
    await copyFile(fromPath, toPath);
    await removeIfPresent(fromPath);
  }
}

/** 16-bit 48 kHz FLAC from a 24-bit master. Dithered. Copies tags and chapters. */
export async function encodeListenFlac(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  inputPath: string,
  outputPath: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (abortSignal?.aborted) {
    const error = new Error("Render cancelled");
    error.name = "AbortError";
    throw error;
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  const partial = `${outputPath}.partial.flac`;
  const args = [
    "-nostdin",
    "-hide_banner",
    "-y",
    "-i",
    inputPath,
    "-map_metadata",
    "0",
    "-map_chapters",
    "0",
    "-af",
    "aresample=osf=s16:dither_method=triangular_hp",
    "-c:a",
    "flac",
    "-compression_level",
    String(LISTEN_FLAC_COMPRESSION_LEVEL),
    partial,
  ];
  const result = await runner.run({
    executable: binaries.ffmpegPath,
    args,
    abortSignal,
  });
  if (result.exitCode !== 0) {
    await removeIfPresent(partial);
    if (abortSignal?.aborted) {
      const error = new Error("Render cancelled");
      error.name = "AbortError";
      throw error;
    }
    throw new DomainError(
      "RENDER_FAILED",
      `Listen encode exited with code ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
      {
        retryable: false,
        details: { stderr: result.stderr.slice(-800) },
      },
    );
  }
  await atomicReplace(partial, outputPath);
}
