import { DomainError } from "@dnb-crate/domain";

import { ProcessRunError, type ProcessRunner } from "./runner.ts";

export type FfmpegBinaries = {
  ffmpegPath: string;
  ffprobePath: string;
  ffmpegVersion: string;
  ffprobeVersion: string;
  hasAcrossfade: boolean;
  hasEbur128: boolean;
  hasAlimiter: boolean;
  hasAtempo: boolean;
  hasLowpass: boolean;
  hasHighpass: boolean;
  hasAsplit: boolean;
  hasAmix: boolean;
  hasAfade: boolean;
  hasAdelay: boolean;
  hasAfadeUnity: boolean;
  hasFilterComplexScript: boolean;
};

const VERSION_RE = /version\s+(\S+)/i;
const UNRECOGNIZED_FILTER_COMPLEX_SCRIPT =
  /unrecognized option ['"]?filter_complex_script['"]?/i;

export function parseFilterComplexScriptSupport(text: string): boolean {
  return !UNRECOGNIZED_FILTER_COMPLEX_SCRIPT.test(text);
}

export function parseAfadeUnitySupport(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("unity") && lower.includes("silence");
}

export function parseVersionLine(text: string): string | null {
  const match = VERSION_RE.exec(text);
  return match?.[1] ?? null;
}

export function parseFilterList(text: string): {
  hasAcrossfade: boolean;
  hasEbur128: boolean;
  hasAlimiter: boolean;
  hasAtempo: boolean;
  hasLowpass: boolean;
  hasHighpass: boolean;
  hasAsplit: boolean;
  hasAmix: boolean;
  hasAfade: boolean;
  hasAdelay: boolean;
} {
  const lower = text.toLowerCase();
  return {
    hasAcrossfade: lower.includes("acrossfade"),
    hasEbur128: lower.includes("ebur128"),
    hasAlimiter: lower.includes("alimiter"),
    hasAtempo: lower.includes("atempo"),
    hasLowpass: lower.includes("lowpass"),
    hasHighpass: lower.includes("highpass"),
    hasAsplit: lower.includes("asplit"),
    hasAmix: lower.includes("amix"),
    hasAfade: lower.includes("afade"),
    hasAdelay: lower.includes("adelay"),
  };
}

export async function detectFfmpeg(
  runner: ProcessRunner,
  paths: { ffmpegPath: string; ffprobePath: string },
): Promise<FfmpegBinaries | null> {
  try {
    const [ffmpegVer, ffprobeVer, filters, scriptProbe, afadeHelp] = await Promise.all([
      runner.run({ executable: paths.ffmpegPath, args: ["-hide_banner", "-version"] }),
      runner.run({ executable: paths.ffprobePath, args: ["-hide_banner", "-version"] }),
      runner.run({ executable: paths.ffmpegPath, args: ["-hide_banner", "-filters"] }),
      runner.run({
        executable: paths.ffmpegPath,
        args: ["-hide_banner", "-filter_complex_script"],
      }),
      runner.run({
        executable: paths.ffmpegPath,
        args: ["-hide_banner", "-h", "filter=afade"],
      }),
    ]);
    const ffmpegVersion = parseVersionLine(ffmpegVer.stdout + ffmpegVer.stderr);
    const ffprobeVersion = parseVersionLine(ffprobeVer.stdout + ffprobeVer.stderr);
    if (
      !ffmpegVersion ||
      !ffprobeVersion ||
      ffmpegVer.exitCode !== 0 ||
      ffprobeVer.exitCode !== 0
    ) {
      return null;
    }
    const caps = parseFilterList(filters.stdout + filters.stderr);
    return {
      ffmpegPath: paths.ffmpegPath,
      ffprobePath: paths.ffprobePath,
      ffmpegVersion,
      ffprobeVersion,
      ...caps,
      hasAfadeUnity: parseAfadeUnitySupport(afadeHelp.stdout + afadeHelp.stderr),
      hasFilterComplexScript: parseFilterComplexScriptSupport(
        scriptProbe.stdout + scriptProbe.stderr,
      ),
    };
  } catch (error) {
    if (error instanceof ProcessRunError && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function ffmpegMixReady(binaries: FfmpegBinaries | null): boolean {
  return binaries !== null && binaries.hasAcrossfade && binaries.hasEbur128 && binaries.hasAlimiter;
}

export function ffmpegAlignedReady(binaries: FfmpegBinaries | null): boolean {
  return (
    ffmpegMixReady(binaries) &&
    binaries !== null &&
    binaries.hasAtempo &&
    binaries.hasLowpass &&
    binaries.hasHighpass &&
    binaries.hasAsplit &&
    binaries.hasAmix &&
    binaries.hasAfade
  );
}

export function requireFfmpeg(binaries: FfmpegBinaries | null): FfmpegBinaries {
  if (!binaries) {
    throw new DomainError(
      "FFMPEG_UNAVAILABLE",
      "FFmpeg/ffprobe were not found. Install them and ensure they are on PATH (or set ffmpegPath/ffprobePath).",
      { retryable: false },
    );
  }
  if (!binaries.hasAcrossfade || !binaries.hasEbur128 || !binaries.hasAlimiter) {
    throw new DomainError(
      "FFMPEG_UNAVAILABLE",
      `FFmpeg ${binaries.ffmpegVersion} is missing required filters (acrossfade, ebur128, alimiter).`,
      { retryable: false, details: { ffmpegVersion: binaries.ffmpegVersion } },
    );
  }
  return binaries;
}

export function requireAlignedFfmpeg(binaries: FfmpegBinaries | null): FfmpegBinaries {
  const ready = requireFfmpeg(binaries);
  if (!ffmpegAlignedReady(ready)) {
    throw new DomainError(
      "FFMPEG_UNAVAILABLE",
      `FFmpeg ${ready.ffmpegVersion} is missing filters needed for phrase-mix/bass-swap (atempo, lowpass, highpass, asplit, amix, afade).`,
      { retryable: false, details: { ffmpegVersion: ready.ffmpegVersion } },
    );
  }
  return ready;
}
