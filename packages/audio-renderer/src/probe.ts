import { DomainError } from "@dnb-crate/domain";

import { parseFfprobeJson, type ProbeResult } from "./parse.ts";
import type { FfmpegBinaries } from "./detect.ts";
import type { ProcessRunner } from "./runner.ts";

export async function probeAudioFile(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  filePath: string,
  abortSignal?: AbortSignal,
): Promise<ProbeResult> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ];
  const result = await runner.run({
    executable: binaries.ffprobePath,
    args,
    abortSignal,
  });
  if (result.exitCode !== 0) {
    throw new DomainError("AUDIO_FILE_UNAVAILABLE", "ffprobe could not read the audio file", {
      retryable: false,
      details: { stderr: result.stderr.slice(-500) },
    });
  }
  try {
    const probe = parseFfprobeJson(result.stdout);
    if (!probe.isAudio || probe.durationMs <= 0) {
      throw new DomainError("AUDIO_FILE_UNAVAILABLE", "File has no readable audio stream", {
        retryable: false,
      });
    }
    return probe;
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError("AUDIO_FILE_UNAVAILABLE", "ffprobe returned unreadable JSON", {
      retryable: false,
      cause: error,
    });
  }
}
