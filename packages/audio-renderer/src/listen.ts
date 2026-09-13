import { copyFile, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { DomainError } from "@dnb-crate/domain";

import type { FfmpegBinaries } from "./detect.ts";
import type { ProcessRunner } from "./runner.ts";

const LISTEN_FLAC_COMPRESSION_LEVEL = 8;
const TRUE_PEAK_HEADROOM_DB = 0.05;

export function listenCopyFailureReason(
  measured: { integratedLufs: number | null; truePeakDb: number | null },
  ceilingDb: number,
): string | null {
  if (
    measured.integratedLufs == null ||
    measured.truePeakDb == null ||
    !Number.isFinite(measured.integratedLufs) ||
    !Number.isFinite(measured.truePeakDb)
  ) {
    return "Listen-copy loudness/true-peak measurement failed";
  }
  if (measured.truePeakDb > ceilingDb + TRUE_PEAK_HEADROOM_DB) {
    return `Listen-copy true peak ${measured.truePeakDb.toFixed(2)} dB exceeds ceiling ${ceilingDb} dB`;
  }
  return null;
}
const publishLocks = new Map<string, Promise<void>>();

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // missing is fine
  }
}

async function withPublishLock(outputPath: string, work: () => Promise<void>): Promise<void> {
  const previous = publishLocks.get(outputPath) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => held);
  publishLocks.set(outputPath, chain);
  await previous;
  try {
    await work();
  } finally {
    release();
    if (publishLocks.get(outputPath) === chain) {
      publishLocks.delete(outputPath);
    }
  }
}

async function atomicReplace(fromPath: string, toPath: string): Promise<void> {
  try {
    await rename(fromPath, toPath);
    return;
  } catch {
    // destination exists or rename is cross-device
  }
  const backup = `${toPath}.prev.${crypto.randomUUID()}`;
  let backedUp = false;
  try {
    await rename(toPath, backup);
    backedUp = true;
  } catch {
    // destination missing
  }
  try {
    await rename(fromPath, toPath);
  } catch {
    try {
      await copyFile(fromPath, toPath);
      await removeIfPresent(fromPath);
    } catch (error) {
      if (backedUp) {
        try {
          await rename(backup, toPath);
        } catch {
          // restore failed; leave backup
        }
      }
      throw error;
    }
  }
  if (backedUp) {
    await removeIfPresent(backup);
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
  const partial = `${outputPath}.${crypto.randomUUID()}.partial.flac`;
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
  await withPublishLock(outputPath, () => atomicReplace(partial, outputPath));
}
