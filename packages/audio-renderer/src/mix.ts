import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_RENDER_CHANNELS,
  DEFAULT_RENDER_SAMPLE_RATE_HZ,
  DomainError,
  FFMPEG_ARGV_SOFT_LIMIT,
} from "@dnb-crate/domain";

import type { FfmpegBinaries } from "./detect.ts";
import {
  buildMixFilter,
  estimateArgvChars,
  expectedDurationMs,
  limiterAmplitudeFromCeilingDb,
  mixFilterArgs,
  redactInvocation,
  type FilterTrim,
  type MixTransitionSpec,
} from "./filter-graph.ts";
import { sha256File } from "./hash.ts";
import { parseEbur128, parseOutTimeMs, parseSilenceSpans } from "./parse.ts";
import { probeAudioFile } from "./probe.ts";
import type { ProcessRunner } from "./runner.ts";

export type MixSegment = {
  filePath: string;
  sourceStartMs: number;
  sourceEndMs: number;
  gainDb: number;
  playbackRate?: number;
};

export type MixRequest = {
  segments: MixSegment[];
  overlapMs: number[];
  outputPath: string;
  sampleRateHz?: number;
  truePeakCeilingDb: number;
  loudnessTargetLufs: number;
  edgeFadeMs?: number;
  abortSignal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  postProcess?: boolean;
  transitions?: MixTransitionSpec[];
};

export type MixResult = {
  durationMs: number;
  sampleRateHz: number;
  channels: number;
  checksumSha256: string;
  integratedLufs: number | null;
  truePeakDb: number | null;
  invocation: string;
  warnings: string[];
  expectedDurationMs: number;
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("Render cancelled");
    error.name = "AbortError";
    throw error;
  }
}

function mapRunFailure(
  result: { exitCode: number; signal: string | null; stderr: string },
  signal: AbortSignal | undefined,
): never {
  if (signal?.aborted) {
    const error = new Error("Render cancelled");
    error.name = "AbortError";
    throw error;
  }
  throw new DomainError(
    "RENDER_FAILED",
    `FFmpeg exited with code ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
    {
      retryable: false,
      details: { stderr: result.stderr.slice(-800) },
    },
  );
}

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

function toTrims(segments: MixSegment[]): FilterTrim[] {
  return segments.map((segment) => ({
    startSec: segment.sourceStartMs / 1000,
    endSec: segment.sourceEndMs / 1000,
    gainDb: segment.gainDb,
    playbackRate: segment.playbackRate ?? 1,
  }));
}

function needsPairwise(request: MixRequest): boolean {
  const types =
    request.transitions ?? request.overlapMs.map(() => ({ type: "crossfade" as const }));
  return types.some((item) => item.type !== "crossfade");
}

export async function renderMix(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  request: MixRequest,
): Promise<MixResult> {
  throwIfAborted(request.abortSignal);
  if (request.segments.length === 0) {
    throw new DomainError("INVALID_SET_PLAN", "Render has no audio segments");
  }
  if (request.overlapMs.length !== Math.max(0, request.segments.length - 1)) {
    throw new DomainError("INVALID_SET_PLAN", "Overlap list does not match segment count");
  }
  for (const overlap of request.overlapMs) {
    if (overlap < 0) {
      throw new DomainError("INVALID_SET_PLAN", "Transition overlap cannot be negative");
    }
  }
  for (let i = 0; i < request.segments.length; i += 1) {
    const segment = request.segments[i]!;
    const playable = segment.sourceEndMs - segment.sourceStartMs;
    if (playable <= 0) {
      throw new DomainError("INVALID_SET_PLAN", "Source window is empty");
    }
    const rate =
      segment.playbackRate !== undefined && segment.playbackRate > 0 ? segment.playbackRate : 1;
    const playableOut = playable / rate;
    const overlapLeft = i > 0 ? request.overlapMs[i - 1]! : 0;
    const overlapRight = i < request.overlapMs.length ? request.overlapMs[i]! : 0;
    if (playableOut <= overlapLeft || (overlapRight > 0 && playableOut <= overlapRight)) {
      throw new DomainError(
        "INVALID_SET_PLAN",
        "Source window is shorter than the planned overlap after tempo matching",
      );
    }
  }

  if (needsPairwise(request) && request.segments.length > 2) {
    return await renderPairwise(runner, binaries, request);
  }

  const sampleRateHz = request.sampleRateHz ?? DEFAULT_RENDER_SAMPLE_RATE_HZ;
  const overlapSeconds = request.overlapMs.map((ms) => ms / 1000);
  const trims = toTrims(request.segments);
  const expectedMs = expectedDurationMs(trims, overlapSeconds);
  const limiterAmplitude = limiterAmplitudeFromCeilingDb(request.truePeakCeilingDb);
  const edge = request.edgeFadeMs ?? 0;
  const filter = buildMixFilter({
    trims,
    overlapSeconds,
    limiterAmplitude,
    sampleRateHz,
    edgeFadeSeconds: edge > 0 ? { fadeIn: edge / 1000, fadeOut: edge / 1000 } : undefined,
    transitions: request.transitions,
  });

  await mkdir(path.dirname(request.outputPath), { recursive: true });
  const partialPath = `${request.outputPath}.partial.wav`;
  const filterPath = `${request.outputPath}.filter.txt`;
  const useScript = binaries.hasFilterComplexScript;
  const warnings: string[] = [];
  let invocation = "";

  const reportProgress = (outMs: number) => {
    if (!request.onProgress || expectedMs <= 0) {
      return;
    }
    request.onProgress(Math.max(0, Math.min(0.95, outMs / expectedMs)));
  };

  try {
    if (useScript) {
      await writeFile(filterPath, filter, "utf8");
    }
    const inputArgs = request.segments.flatMap((segment) => ["-i", segment.filePath]);
    const args = [
      "-nostdin",
      "-hide_banner",
      "-y",
      "-progress",
      "pipe:1",
      "-nostats",
      ...inputArgs,
      ...mixFilterArgs(filter, filterPath, useScript),
      "-map",
      "[out]",
      "-ac",
      String(DEFAULT_RENDER_CHANNELS),
      "-ar",
      String(sampleRateHz),
      "-c:a",
      "pcm_s24le",
      "-vn",
      partialPath,
    ];
    if (estimateArgvChars(args) > FFMPEG_ARGV_SOFT_LIMIT && request.segments.length > 2) {
      return await renderPairwise(runner, binaries, request);
    }
    invocation = redactInvocation(binaries.ffmpegPath, args);
    const mixRun = await runner.run({
      executable: binaries.ffmpegPath,
      args,
      abortSignal: request.abortSignal,
      onStdout: (chunk) => {
        const ms = parseOutTimeMs(chunk);
        if (ms !== null) {
          reportProgress(ms);
        }
      },
    });
    if (mixRun.exitCode !== 0) {
      mapRunFailure(mixRun, request.abortSignal);
    }

    const postProcess = request.postProcess ?? true;
    let workingPath = partialPath;
    let measured = { integratedLufs: null as number | null, truePeakDb: null as number | null };
    if (postProcess) {
      measured = await measureLoudness(runner, binaries, workingPath, request.abortSignal);
      if (
        measured.integratedLufs !== null &&
        measured.integratedLufs > request.loudnessTargetLufs + 0.5
      ) {
        const gainDb = request.loudnessTargetLufs - measured.integratedLufs;
        const attenuated = `${request.outputPath}.attenuated.wav`;
        const volumeArgs = [
          "-nostdin",
          "-hide_banner",
          "-y",
          "-i",
          workingPath,
          "-af",
          `volume=${gainDb}dB,alimiter=limit=${limiterAmplitude}:level=false:attack=5:release=50`,
          "-c:a",
          "pcm_s24le",
          attenuated,
        ];
        invocation = `${invocation} ; ${redactInvocation(binaries.ffmpegPath, volumeArgs)}`;
        const volRun = await runner.run({
          executable: binaries.ffmpegPath,
          args: volumeArgs,
          abortSignal: request.abortSignal,
        });
        if (volRun.exitCode !== 0) {
          mapRunFailure(volRun, request.abortSignal);
        }
        await removeIfPresent(workingPath);
        workingPath = attenuated;
        warnings.push(
          `Applied mix-wide ${gainDb.toFixed(2)} dB attenuation so integrated LUFS meets ${request.loudnessTargetLufs} LUFS. Per-track energy differences were preserved.`,
        );
        measured = await measureLoudness(runner, binaries, workingPath, request.abortSignal);
      }

      if (measured.truePeakDb !== null && measured.truePeakDb > request.truePeakCeilingDb + 0.3) {
        throw new DomainError(
          "RENDER_FAILED",
          `True peak ${measured.truePeakDb.toFixed(2)} dB exceeds ceiling ${request.truePeakCeilingDb} dB`,
          { retryable: false, details: { truePeakDb: measured.truePeakDb } },
        );
      }

      const silenceArgs = [
        "-nostdin",
        "-hide_banner",
        "-i",
        workingPath,
        "-af",
        "silencedetect=noise=-60dB:d=2",
        "-f",
        "null",
        "-",
      ];
      const silenceRun = await runner.run({
        executable: binaries.ffmpegPath,
        args: silenceArgs,
        abortSignal: request.abortSignal,
      });
      const spans = parseSilenceSpans(silenceRun.stderr);
      const interior = spans.filter((span) => (span.startMs ?? 0) > 500);
      if (interior.length > 0) {
        warnings.push("Unexpected silence longer than 2s was detected in the mix.");
      }
    }

    await atomicReplace(workingPath, request.outputPath);
    const probe = await probeAudioFile(runner, binaries, request.outputPath, request.abortSignal);
    const checksumSha256 = await sha256File(request.outputPath);
    request.onProgress?.(1);
    return {
      durationMs: probe.durationMs,
      sampleRateHz: probe.sampleRateHz || sampleRateHz,
      channels: probe.channels || DEFAULT_RENDER_CHANNELS,
      checksumSha256,
      integratedLufs: measured.integratedLufs,
      truePeakDb: measured.truePeakDb,
      invocation,
      warnings,
      expectedDurationMs: expectedMs,
    };
  } catch (error) {
    await removeIfPresent(partialPath);
    await removeIfPresent(`${request.outputPath}.attenuated.wav`);
    throw error;
  } finally {
    await removeIfPresent(filterPath);
  }
}

async function measureLoudness(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  filePath: string,
  abortSignal?: AbortSignal,
): Promise<{ integratedLufs: number | null; truePeakDb: number | null }> {
  const args = [
    "-nostdin",
    "-hide_banner",
    "-i",
    filePath,
    "-filter_complex",
    "ebur128=peak=true",
    "-f",
    "null",
    "-",
  ];
  const result = await runner.run({
    executable: binaries.ffmpegPath,
    args,
    abortSignal,
  });
  if (result.exitCode !== 0 && !abortSignal?.aborted) {
    return parseEbur128(result.stderr);
  }
  if (abortSignal?.aborted) {
    const error = new Error("Render cancelled");
    error.name = "AbortError";
    throw error;
  }
  return parseEbur128(result.stderr);
}

async function renderPairwise(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  request: MixRequest,
): Promise<MixResult> {
  const dir = path.dirname(request.outputPath);
  const accPath = path.join(dir, `${path.basename(request.outputPath)}.acc.wav`);
  let current: MixSegment = request.segments[0]!;
  let currentFile = current.filePath;
  const warnings: string[] = [];
  let invocation = "pairwise-acrossfade";
  for (let i = 1; i < request.segments.length; i += 1) {
    const next = request.segments[i]!;
    const overlap = request.overlapMs[i - 1]!;
    const stepOut = i === request.segments.length - 1 ? request.outputPath : accPath;
    const result = await renderMix(runner, binaries, {
      ...request,
      segments: [
        { ...current, filePath: currentFile, playbackRate: current.playbackRate ?? 1 },
        next,
      ],
      overlapMs: [overlap],
      transitions: request.transitions
        ? [request.transitions[i - 1] ?? { type: "crossfade" }]
        : undefined,
      outputPath: stepOut,
      edgeFadeMs: i === request.segments.length - 1 ? request.edgeFadeMs : 0,
      postProcess: i === request.segments.length - 1,
      onProgress: (fraction) => {
        const overall = (i - 1 + fraction) / (request.segments.length - 1);
        request.onProgress?.(overall);
      },
    });
    warnings.push(...result.warnings);
    invocation = `${invocation} ; ${result.invocation}`;
    currentFile = stepOut;
    current = {
      filePath: stepOut,
      sourceStartMs: 0,
      sourceEndMs: result.durationMs,
      gainDb: 0,
      playbackRate: 1,
    };
  }
  const probe = await probeAudioFile(runner, binaries, request.outputPath, request.abortSignal);
  const checksumSha256 = await sha256File(request.outputPath);
  const loudness = await measureLoudness(runner, binaries, request.outputPath, request.abortSignal);
  await removeIfPresent(accPath);
  return {
    durationMs: probe.durationMs,
    sampleRateHz: probe.sampleRateHz,
    channels: probe.channels,
    checksumSha256,
    integratedLufs: loudness.integratedLufs,
    truePeakDb: loudness.truePeakDb,
    invocation,
    warnings,
    expectedDurationMs: expectedDurationMs(
      toTrims(request.segments),
      request.overlapMs.map((ms) => ms / 1000),
    ),
  };
}
