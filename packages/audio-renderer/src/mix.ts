import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_RENDER_CHANNELS,
  DEFAULT_RENDER_SAMPLE_RATE_HZ,
  DomainError,
  FFMPEG_ARGV_SOFT_LIMIT,
  overlapOnlyPlayableMs,
  resolveRateRegions,
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
  type StretchScope,
} from "./filter-graph.ts";
import { sha256File } from "./hash.ts";
import { buildFfmetadataFile, type MixOutputTags } from "./output-tags.ts";
import { parseEbur128, parseOutTimeMs, parseSilenceSpans } from "./parse.ts";
import { probeAudioFile } from "./probe.ts";
import { prepareCliStretchedSegments, prepareBothJoinRegions } from "./rubberband-cli.ts";
import type { ProcessRunner } from "./runner.ts";

export type MixSegment = {
  filePath: string;
  sourceStartMs: number;
  sourceEndMs: number;
  gainDb: number;
  playbackRate?: number;
  /** Solo isolate: stretch this many output milliseconds at the tail. */
  stretchTailMs?: number;
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
  /** When false, skip the graph alimiter (intermediate pairwise joins). */
  applyLimiter?: boolean;
  /** Intermediate hour joins use float so a hot sum cannot hard-clip in 24-bit. */
  pcmCodec?: "pcm_s24le" | "pcm_f32le";
  /** When false, keep the outgoing prefix in the 3-band graph. Hours play a dry prefix and acrossfade one bar onto a primed 3-band mix. */
  isolatePrefix?: boolean;
  /**
   * `rubberband-r3` (default when `rubberbandCliPath` is set): standalone R3 CLI.
   * `rubberband`: FFmpeg filter (`27` settings, flickers on Like a Memory).
   * `atempo`: fallback.
   */
  tempoEngine?: "rubberband" | "rubberband-r3" | "atempo";
  /** Standalone Rubber Band 4 CLI (`-3` / fine). When set, preferred over the FFmpeg filter. */
  rubberbandCliPath?: string | null;
  /**
   * `overlap` (default): featured body stays at rate 1; Rubber Band only on the join.
   * `all` is the pre-6.10 whole-window stretch.
   */
  stretchScope?: StretchScope;
  /** v7: prepare every source's head and tail before pairwise accumulation. */
  rateRegionsVersion?: 2;
  transitions?: MixTransitionSpec[];
  /** Mix-level tags for the published FLAC. Source-file tags are never copied. */
  outputMetadata?: MixOutputTags;
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

const FLAC_COMPRESSION_LEVEL = 8;

function isFlacOutput(outputPath: string): boolean {
  return path.extname(outputPath).toLowerCase() === ".flac";
}

function toTrims(segments: MixSegment[]): FilterTrim[] {
  return segments.map((segment) => ({
    startSec: segment.sourceStartMs / 1000,
    endSec: segment.sourceEndMs / 1000,
    gainDb: segment.gainDb,
    playbackRate: segment.playbackRate ?? 1,
    stretchTailSec: segment.stretchTailMs != null ? segment.stretchTailMs / 1000 : undefined,
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
    const overlapLeft = i > 0 ? request.overlapMs[i - 1]! : 0;
    const overlapRight = i < request.overlapMs.length ? request.overlapMs[i]! : 0;
    const playableOut =
      request.rateRegionsVersion === 2
        ? resolveRateRegions(playable, rate, overlapLeft, overlapRight).at(-1)!.outputEndMs
        : overlapOnlyPlayableMs({
            sourceMs: playable,
            rate,
            overlapToNextMs: i === 0 ? overlapRight : 0,
            overlapFromPrevMs: overlapLeft,
          });
    if (playableOut <= overlapLeft || (overlapRight > 0 && playableOut <= overlapRight)) {
      throw new DomainError(
        "INVALID_SET_PLAN",
        "Source window is shorter than the planned overlap after tempo matching",
      );
    }
  }

  if (request.rateRegionsVersion === 2) {
    if (!request.rubberbandCliPath) throw new Error("Head/body/tail rendering requires the accepted R3 CLI");
    await mkdir(path.dirname(request.outputPath), { recursive: true });
    const prepared = await prepareBothJoinRegions(runner, binaries, request.rubberbandCliPath, request, request.sampleRateHz ?? DEFAULT_RENDER_SAMPLE_RATE_HZ);
    try {
      const result = await renderMix(runner, binaries, { ...request, segments: prepared.segments, rateRegionsVersion: undefined, stretchScope: "all" });
      const expected = request.segments.reduce((sum, segment, i) => sum + resolveRateRegions(segment.sourceEndMs - segment.sourceStartMs, segment.playbackRate ?? 1, request.overlapMs[i - 1] ?? 0, request.overlapMs[i] ?? 0).at(-1)!.outputEndMs, 0) - request.overlapMs.reduce((a, b) => a + b, 0);
      return { ...result, expectedDurationMs: Math.round(expected), warnings: [...prepared.warnings, ...result.warnings], invocation: `${prepared.invocation} ; ${result.invocation}` };
    } finally {
      await Promise.all(prepared.tempPaths.map(removeIfPresent));
    }
  }
  if (needsPairwise(request) && request.segments.length > 2) {
    return await renderPairwise(runner, binaries, request);
  }

  await mkdir(path.dirname(request.outputPath), { recursive: true });
  const sampleRateHz = request.sampleRateHz ?? DEFAULT_RENDER_SAMPLE_RATE_HZ;
  const overlapSeconds = request.overlapMs.map((ms) => ms / 1000);
  const stretchScope = request.stretchScope ?? "overlap";
  const expectedMs = expectedDurationMs(toTrims(request.segments), overlapSeconds, stretchScope);
  const limiterAmplitude = limiterAmplitudeFromCeilingDb(request.truePeakCeilingDb);
  const edge = request.edgeFadeMs ?? 0;
  const warnings: string[] = [];
  const stretchTemps: string[] = [];
  const useCli =
    Boolean(request.rubberbandCliPath) &&
    request.tempoEngine !== "atempo" &&
    request.tempoEngine !== "rubberband";
  let mixSegments = request.segments;
  let cliInvocation = "";
  const partialPath = `${request.outputPath}.partial.wav`;
  const filterPath = `${request.outputPath}.filter.txt`;
  const useScript = binaries.hasFilterComplexScript;
  let invocation = "";

  const reportProgress = (outMs: number) => {
    if (!request.onProgress || expectedMs <= 0) {
      return;
    }
    request.onProgress(Math.max(0, Math.min(0.95, outMs / expectedMs)));
  };

  try {
    if (useCli && request.rubberbandCliPath) {
      const prepared = await prepareCliStretchedSegments(
        runner,
        binaries,
        request.rubberbandCliPath,
        {
          segments: request.segments,
          overlapMs: request.overlapMs,
          outputPath: request.outputPath,
          stretchScope,
          abortSignal: request.abortSignal,
        },
        sampleRateHz,
      );
      mixSegments = prepared.segments;
      stretchTemps.push(...prepared.tempPaths);
      warnings.push(...prepared.warnings);
      cliInvocation = prepared.invocation;
    } else if (
      request.tempoEngine !== "atempo" &&
      !request.rubberbandCliPath &&
      request.segments.some((segment) => (segment.playbackRate ?? 1) !== 1)
    ) {
      warnings.push(
        "Standalone Rubber Band R3 CLI was not found; using the FFmpeg rubberband filter.",
      );
    }
    const trims = toTrims(mixSegments);
    const filter = buildMixFilter({
      trims,
      overlapSeconds,
      limiterAmplitude,
      sampleRateHz,
      edgeFadeSeconds: edge > 0 ? { fadeIn: edge / 1000, fadeOut: edge / 1000 } : undefined,
      transitions: request.transitions,
      hasAfadeUnity: binaries.hasAfadeUnity,
      warnings,
      applyLimiter: request.applyLimiter,
      isolatePrefix: request.isolatePrefix,
      tempoEngine: useCli
        ? "atempo"
        : (request.tempoEngine === "rubberband-r3"
          ? "rubberband"
          : (request.tempoEngine ?? (binaries.hasRubberband ? "rubberband" : "atempo"))),
      stretchScope: useCli ? "all" : stretchScope,
    });
    invocation = cliInvocation;

    if (useScript) {
      await writeFile(filterPath, filter, "utf8");
    }
    const inputArgs = mixSegments.flatMap((segment) => ["-i", segment.filePath]);
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
      request.pcmCodec ?? "pcm_s24le",
      "-vn",
      "-map_metadata",
      "-1",
      partialPath,
    ];
    if (estimateArgvChars(args) > FFMPEG_ARGV_SOFT_LIMIT && request.segments.length > 2) {
      return await renderPairwise(runner, binaries, request);
    }
    invocation = cliInvocation
      ? `${cliInvocation} ; ${redactInvocation(binaries.ffmpegPath, args)}`
      : redactInvocation(binaries.ffmpegPath, args);
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
          "-map_metadata",
          "-1",
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
        const limited = `${request.outputPath}.peak-limited.wav`;
        const peakArgs = [
          "-nostdin",
          "-hide_banner",
          "-y",
          "-i",
          workingPath,
          "-map_metadata",
          "-1",
          "-af",
          `alimiter=limit=${limiterAmplitude}:level=false:attack=5:release=50`,
          "-c:a",
          "pcm_s24le",
          limited,
        ];
        invocation = `${invocation} ; ${redactInvocation(binaries.ffmpegPath, peakArgs)}`;
        const peakRun = await runner.run({
          executable: binaries.ffmpegPath,
          args: peakArgs,
          abortSignal: request.abortSignal,
        });
        if (peakRun.exitCode !== 0) {
          mapRunFailure(peakRun, request.abortSignal);
        }
        await removeIfPresent(workingPath);
        workingPath = limited;
        warnings.push(
          `Applied mix-wide true-peak limiter so true peak meets ${request.truePeakCeilingDb} dBTP.`,
        );
        measured = await measureLoudness(runner, binaries, workingPath, request.abortSignal);
        if (measured.truePeakDb !== null && measured.truePeakDb > request.truePeakCeilingDb + 0.3) {
          const peakGainDb = request.truePeakCeilingDb - measured.truePeakDb - 0.2;
          const ducked = `${request.outputPath}.peak-ducked.wav`;
          const duckArgs = [
            "-nostdin",
            "-hide_banner",
            "-y",
            "-i",
            workingPath,
            "-map_metadata",
            "-1",
            "-af",
            `volume=${peakGainDb}dB,alimiter=limit=${limiterAmplitude}:level=false:attack=5:release=50`,
            "-c:a",
            "pcm_s24le",
            ducked,
          ];
          invocation = `${invocation} ; ${redactInvocation(binaries.ffmpegPath, duckArgs)}`;
          const duckRun = await runner.run({
            executable: binaries.ffmpegPath,
            args: duckArgs,
            abortSignal: request.abortSignal,
          });
          if (duckRun.exitCode !== 0) {
            mapRunFailure(duckRun, request.abortSignal);
          }
          await removeIfPresent(workingPath);
          workingPath = ducked;
          warnings.push(
            `Applied ${peakGainDb.toFixed(2)} dB after limiter so true peak meets ${request.truePeakCeilingDb} dBTP.`,
          );
          measured = await measureLoudness(runner, binaries, workingPath, request.abortSignal);
          if (measured.truePeakDb !== null && measured.truePeakDb > request.truePeakCeilingDb + 0.3) {
            throw new DomainError(
              "RENDER_FAILED",
              `True peak ${measured.truePeakDb.toFixed(2)} dB exceeds ceiling ${request.truePeakCeilingDb} dB`,
              { retryable: false, details: { truePeakDb: measured.truePeakDb } },
            );
          }
        }
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

    if (isFlacOutput(request.outputPath)) {
      const encoded = `${request.outputPath}.partial.flac`;
      const metadataPath = `${request.outputPath}.ffmeta.txt`;
      try {
        const encodeArgs = await buildFlacEncodeArgs(
          runner,
          binaries,
          workingPath,
          encoded,
          metadataPath,
          request,
          expectedMs,
        );
        invocation = `${invocation} ; ${redactInvocation(binaries.ffmpegPath, encodeArgs)}`;
        const encodeRun = await runner.run({
          executable: binaries.ffmpegPath,
          args: encodeArgs,
          abortSignal: request.abortSignal,
        });
        if (encodeRun.exitCode !== 0) {
          await removeIfPresent(encoded);
          mapRunFailure(encodeRun, request.abortSignal);
        }
        await removeIfPresent(workingPath);
        await atomicReplace(encoded, request.outputPath);
      } finally {
        await removeIfPresent(metadataPath);
      }
    } else {
      await atomicReplace(workingPath, request.outputPath);
    }
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
    await removeIfPresent(`${request.outputPath}.peak-limited.wav`);
    await removeIfPresent(`${request.outputPath}.peak-ducked.wav`);
    await removeIfPresent(`${request.outputPath}.partial.flac`);
    await removeIfPresent(`${request.outputPath}.ffmeta.txt`);
    throw error;
  } finally {
    await removeIfPresent(filterPath);
    for (const tempPath of stretchTemps) {
      await removeIfPresent(tempPath);
    }
  }
}

async function buildFlacEncodeArgs(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  workingPath: string,
  encodedPath: string,
  metadataPath: string,
  request: MixRequest,
  expectedMs: number,
): Promise<string[]> {
  const codecArgs = ["-c:a", "flac", "-compression_level", String(FLAC_COMPRESSION_LEVEL)];
  if (!request.outputMetadata) {
    return [
      "-nostdin",
      "-hide_banner",
      "-y",
      "-i",
      workingPath,
      "-map_metadata",
      "-1",
      ...codecArgs,
      encodedPath,
    ];
  }
  let durationMs = expectedMs;
  try {
    durationMs = (await probeAudioFile(runner, binaries, workingPath, request.abortSignal)).durationMs;
  } catch {
    // Chapter ends fall back to the planned duration.
  }
  await writeFile(metadataPath, buildFfmetadataFile(request.outputMetadata, durationMs), "utf8");
  return [
    "-nostdin",
    "-hide_banner",
    "-y",
    "-i",
    workingPath,
    "-f",
    "ffmetadata",
    "-i",
    metadataPath,
    "-map",
    "0:a",
    "-map_metadata",
    "1",
    ...codecArgs,
    encodedPath,
  ];
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
  try {
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
        outputMetadata: i === request.segments.length - 1 ? request.outputMetadata : undefined,
        edgeFadeMs: i === request.segments.length - 1 ? request.edgeFadeMs : 0,
        postProcess: i === request.segments.length - 1,
        applyLimiter: i === request.segments.length - 1,
        pcmCodec: i === request.segments.length - 1 ? "pcm_s24le" : "pcm_f32le",
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
        request.stretchScope ?? "overlap",
      ),
    };
  } finally {
    await removeIfPresent(accPath);
  }
}
