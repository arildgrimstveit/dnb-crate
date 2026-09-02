import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { decodeWavPcm, type PcmAudio } from "@dnb-crate/audio-analysis";
import { DomainError } from "@dnb-crate/domain";
import type { FfmpegBinaries, ProcessRunner } from "@dnb-crate/audio-renderer";

const WAV_EXTS = new Set([".wav"]);

export async function loadPcmForAnalysis(
  filePath: string,
  runner: ProcessRunner,
  binaries: FfmpegBinaries | null,
): Promise<PcmAudio> {
  const ext = path.extname(filePath).toLowerCase();
  if (WAV_EXTS.has(ext)) {
    try {
      return decodeWavPcm(await readFile(filePath));
    } catch {
      // 24-bit / non-PCM WAV falls through to FFmpeg.
    }
  }
  if (!binaries) {
    throw new DomainError("ANALYSIS_FAILED", "Non-WAV analysis needs FFmpeg to decode to PCM.", {
      retryable: false,
    });
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "dnb-an-"));
  const tmp = path.join(dir, "decode.wav");
  try {
    const result = await runner.run({
      executable: binaries.ffmpegPath,
      args: [
        "-nostdin",
        "-hide_banner",
        "-y",
        "-i",
        filePath,
        "-ac",
        "1",
        "-ar",
        "22050",
        "-c:a",
        "pcm_s16le",
        tmp,
      ],
    });
    if (result.exitCode !== 0) {
      throw new DomainError("ANALYSIS_FAILED", "FFmpeg could not decode this file for analysis", {
        retryable: false,
        details: { stderr: result.stderr.slice(-400) },
      });
    }
    return decodeWavPcm(await readFile(tmp));
  } finally {
    await unlink(tmp).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
