import { copyFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CROSSFADE_CURVE,
  DEFAULT_RENDER_CHANNELS,
  DEFAULT_RENDER_SAMPLE_RATE_HZ,
  DomainError,
  FFMPEG_ARGV_SOFT_LIMIT,
  clampMixPresetParams,
  normalizePhraseBars,
  overlapOnlyPlayableMs,
  resolveRateRegions,
} from "@dnb-crate/domain";

import type { FfmpegBinaries } from "./detect.ts";
import {
  buildMixFilter,
  estimateArgvChars,
  expectedDurationMs,
  limiterAmplitudeFromCeilingDb,
  limiterFilter,
  JOIN_STITCH_XFADE_SEC,
  mixFilterArgs,
  outputDurationSec,
  redactInvocation,
  type FilterTrim,
  type MixTransitionSpec,
  type StretchScope,
} from "./filter-graph.ts";
import { sha256File } from "./hash.ts";
import { buildFfmetadataFile, type MixOutputTags } from "./output-tags.ts";
import { parseEbur128, parseOutTimeMs, parseSilenceSpans } from "./parse.ts";
import { probeAudioFile } from "./probe.ts";
import {
  INTERMEDIATE_PCM_CODEC,
  prepareBothJoinRegions,
  prepareCliStretchedSegments,
} from "./rubberband-cli.ts";
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
  /** When true, apply a limiter inside the mix graph. Final masters limit after static gain instead. */
  applyLimiter?: boolean;
  /** Assembly codec. Final masters stay float until delivery; intermediates must be float. */
  pcmCodec?: "pcm_s24le" | "pcm_f32le";
  /** Kept for callers; band reconstruction no longer dry/wet-splices the prefix. */
  isolatePrefix?: boolean;
  /**
   * Full-quality export: refuse unapproved stretch fallback, require finite
   * loudness/true-peak measurements, and prefer one static gain over limiting.
   */
  fidelityMode?: boolean;
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
  /** Keep a shared middle deck on the previous join’s crossover. */
  outgoingCrossoverHz?: number;
  incomingCrossoverHz?: number;
};

export type StretchEngine = "rubberband-r3" | "rubberband" | "atempo" | "none";

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
  staticGainDb: number | null;
  limiterApplied: boolean;
  stretchEngine: StretchEngine;
  stretchEngines: StretchEngine[];
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

function needsStretch(segments: MixSegment[]): boolean {
  return segments.some((segment) => {
    const rate = segment.playbackRate ?? 1;
    return rate !== 1 && Math.abs(rate - 1) > 1e-6;
  });
}

function usesCliStretch(request: MixRequest): boolean {
  return (
    Boolean(request.rubberbandCliPath) &&
    request.tempoEngine !== "atempo" &&
    request.tempoEngine !== "rubberband"
  );
}

function assertFidelityStretch(request: MixRequest): void {
  if (request.fidelityMode === true && needsStretch(request.segments) && !usesCliStretch(request)) {
    throw new DomainError(
      "RENDER_FAILED",
      "Fidelity mode requires Rubber Band R3; refusing FFmpeg rubberband/atempo fallback",
      { retryable: false },
    );
  }
}

function combineStretchEngines(engines: StretchEngine[]): StretchEngine {
  if (engines.includes("rubberband-r3")) {
    return "rubberband-r3";
  }
  if (engines.includes("rubberband")) {
    return "rubberband";
  }
  if (engines.includes("atempo")) {
    return "atempo";
  }
  return "none";
}

function chooseStaticGainDb(
  measured: { integratedLufs: number | null; truePeakDb: number | null },
  loudnessTargetLufs: number,
  truePeakCeilingDb: number,
): number {
  let gainDb = 0;
  if (measured.integratedLufs != null && measured.integratedLufs > loudnessTargetLufs + 0.5) {
    gainDb = loudnessTargetLufs - measured.integratedLufs;
  }
  if (measured.truePeakDb != null) {
    const after = measured.truePeakDb + gainDb;
    if (after > truePeakCeilingDb) {
      gainDb += truePeakCeilingDb - after;
    }
  }
  return gainDb;
}

const TRUE_PEAK_HEADROOM_DB = 0.05;

function requireLoudness(
  measured: { integratedLufs: number | null; truePeakDb: number | null },
  fidelityMode: boolean,
): void {
  const ok =
    measured.integratedLufs != null &&
    Number.isFinite(measured.integratedLufs) &&
    measured.truePeakDb != null &&
    Number.isFinite(measured.truePeakDb);
  if (!ok && fidelityMode) {
    throw new DomainError(
      "RENDER_FAILED",
      "Loudness/true-peak measurement failed; refusing to finish a fidelity export",
      { retryable: false },
    );
  }
}

function assertTruePeakCeiling(
  measured: { truePeakDb: number | null },
  ceilingDb: number,
  label: string,
): void {
  if (measured.truePeakDb == null || !Number.isFinite(measured.truePeakDb)) {
    return;
  }
  if (measured.truePeakDb > ceilingDb + TRUE_PEAK_HEADROOM_DB) {
    throw new DomainError(
      "RENDER_FAILED",
      `${label} true peak ${measured.truePeakDb.toFixed(2)} dB exceeds ceiling ${ceilingDb} dB`,
      { retryable: false, details: { truePeakDb: measured.truePeakDb } },
    );
  }
}

function resolvedCrossoverHz(spec: MixTransitionSpec | undefined): number | undefined {
  if (!spec || spec.type === "crossfade") {
    return undefined;
  }
  const barCount = normalizePhraseBars(spec.barCount ?? spec.params?.barCount);
  return clampMixPresetParams({ ...spec.bassSwap, ...spec.params, barCount }, barCount).crossoverHz;
}

function oversampledLimiterAf(limit: number, sampleRateHz: number): string {
  const up = Math.min(192_000, sampleRateHz * 4);
  const limiter = limiterFilter(limit, true);
  if (up === sampleRateHz) {
    return limiter;
  }
  return `aformat=sample_fmts=fltp:sample_rates=${up},${limiter},aformat=sample_fmts=fltp:sample_rates=${sampleRateHz}`;
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
  assertFidelityStretch(request);
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
    if (!request.rubberbandCliPath)
      throw new Error("Head/body/tail rendering requires the accepted R3 CLI");
    await mkdir(path.dirname(request.outputPath), { recursive: true });
    const prepared = await prepareBothJoinRegions(
      runner,
      binaries,
      request.rubberbandCliPath,
      request,
      request.sampleRateHz ?? DEFAULT_RENDER_SAMPLE_RATE_HZ,
    );
    try {
      const result = await renderMix(runner, binaries, {
        ...request,
        segments: prepared.segments,
        rateRegionsVersion: undefined,
        stretchScope: "all",
      });
      const expected =
        request.segments.reduce(
          (sum, segment, i) =>
            sum +
            resolveRateRegions(
              segment.sourceEndMs - segment.sourceStartMs,
              segment.playbackRate ?? 1,
              request.overlapMs[i - 1] ?? 0,
              request.overlapMs[i] ?? 0,
            ).at(-1)!.outputEndMs,
          0,
        ) - request.overlapMs.reduce((a, b) => a + b, 0);
      return {
        ...result,
        expectedDurationMs: Math.round(expected),
        warnings: [...prepared.warnings, ...result.warnings],
        invocation: `${prepared.invocation} ; ${result.invocation}`,
        stretchEngine: "rubberband-r3",
        stretchEngines: ["rubberband-r3"],
      };
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
  const fidelityMode = request.fidelityMode === true;
  const useCli = usesCliStretch(request);
  let mixSegments = request.segments;
  let cliInvocation = "";
  const stretchEngine: MixResult["stretchEngine"] = needsStretch(request.segments)
    ? useCli
      ? "rubberband-r3"
      : request.tempoEngine === "atempo" || !binaries.hasRubberband
        ? "atempo"
        : "rubberband"
    : "none";
  let staticGainDb: number | null = null;
  let limiterApplied = false;
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
      applyLimiter: request.applyLimiter === true,
      isolatePrefix: request.isolatePrefix,
      outgoingCrossoverHz: request.outgoingCrossoverHz,
      incomingCrossoverHz: request.incomingCrossoverHz,
      tempoEngine: useCli
        ? "atempo"
        : request.tempoEngine === "rubberband-r3"
          ? "rubberband"
          : (request.tempoEngine ?? (binaries.hasRubberband ? "rubberband" : "atempo")),
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
      request.pcmCodec ?? INTERMEDIATE_PCM_CODEC,
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
      requireLoudness(measured, fidelityMode);
      const gainDb = chooseStaticGainDb(
        measured,
        request.loudnessTargetLufs,
        request.truePeakCeilingDb,
      );
      if (Math.abs(gainDb) >= 0.05) {
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
          `volume=${gainDb}dB`,
          "-c:a",
          INTERMEDIATE_PCM_CODEC,
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
        staticGainDb = gainDb;
        warnings.push(
          `Applied mix-wide ${gainDb.toFixed(2)} dB static gain so loudness and true peak meet target without limiting.`,
        );
        measured = await measureLoudness(runner, binaries, workingPath, request.abortSignal);
        requireLoudness(measured, fidelityMode);
      }

      if (measured.truePeakDb !== null && measured.truePeakDb > request.truePeakCeilingDb + 0.05) {
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
          oversampledLimiterAf(limiterAmplitude, sampleRateHz),
          "-c:a",
          INTERMEDIATE_PCM_CODEC,
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
        limiterApplied = true;
        warnings.push(
          `Applied one latency-compensated oversampled limiter so true peak meets ${request.truePeakCeilingDb} dBTP.`,
        );
        measured = await measureLoudness(runner, binaries, workingPath, request.abortSignal);
        requireLoudness(measured, fidelityMode);
        assertTruePeakCeiling(measured, request.truePeakCeilingDb, "Assembled mix");
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
        measured = await measureLoudness(runner, binaries, request.outputPath, request.abortSignal);
        requireLoudness(measured, fidelityMode);
        assertTruePeakCeiling(measured, request.truePeakCeilingDb, "Encoded master");
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
      staticGainDb,
      limiterApplied,
      stretchEngine,
      stretchEngines: [stretchEngine],
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
  const codecArgs = [
    "-af",
    `aformat=sample_fmts=s32:sample_rates=${request.sampleRateHz ?? DEFAULT_RENDER_SAMPLE_RATE_HZ}:channel_layouts=stereo`,
    "-c:a",
    "flac",
    "-compression_level",
    String(FLAC_COMPRESSION_LEVEL),
    "-sample_fmt",
    "s32",
  ];
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
    durationMs = (await probeAudioFile(runner, binaries, workingPath, request.abortSignal))
      .durationMs;
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

export async function measureLoudness(
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
  if (abortSignal?.aborted) {
    const error = new Error("Render cancelled");
    error.name = "AbortError";
    throw error;
  }
  if (result.exitCode !== 0) {
    return { integratedLufs: null, truePeakDb: null };
  }
  return parseEbur128(result.stderr);
}

async function stitchPreservedPrefix(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  accPath: string,
  accDurationMs: number,
  joinPath: string,
  joinSkipMs: number,
  overlapMs: number,
  outputPath: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const accKeepSec = (accDurationMs - overlapMs) / 1000;
  const xfadeSec = Math.min(
    JOIN_STITCH_XFADE_SEC,
    overlapMs / 4000,
    Math.max(0, joinSkipMs / 1000),
  );
  const joinSkipSec = Math.max(0, joinSkipMs / 1000 - xfadeSec);
  if (accKeepSec <= 0 || joinSkipMs / 1000 < 0) {
    throw new DomainError(
      "RENDER_FAILED",
      "Cannot preserve completed audio: join region is longer than the accumulated mix",
      { retryable: false },
    );
  }
  const join =
    xfadeSec > 0.001
      ? `[0:a]atrim=end=${accKeepSec.toFixed(6)},asetpts=PTS-STARTPTS[prefix];[1:a]atrim=start=${joinSkipSec.toFixed(6)},asetpts=PTS-STARTPTS[tail];[prefix][tail]acrossfade=d=${xfadeSec.toFixed(6)}:o=1:c1=${CROSSFADE_CURVE}:c2=${CROSSFADE_CURVE}[out]`
      : `[0:a]atrim=end=${accKeepSec.toFixed(6)},asetpts=PTS-STARTPTS[prefix];[1:a]atrim=start=${(joinSkipMs / 1000).toFixed(6)},asetpts=PTS-STARTPTS[tail];[prefix][tail]concat=n=2:v=0:a=1[out]`;
  const args = [
    "-nostdin",
    "-hide_banner",
    "-y",
    "-i",
    accPath,
    "-i",
    joinPath,
    "-filter_complex",
    join,
    "-map",
    "[out]",
    "-c:a",
    INTERMEDIATE_PCM_CODEC,
    outputPath,
  ];
  const result = await runner.run({
    executable: binaries.ffmpegPath,
    args,
    abortSignal,
  });
  if (result.exitCode !== 0) {
    mapRunFailure(result, abortSignal);
  }
}

async function renderPairwise(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  request: MixRequest,
): Promise<MixResult> {
  const dir = path.dirname(request.outputPath);
  const base = path.basename(request.outputPath);
  const stretchScope = request.stretchScope ?? "overlap";
  const temps: string[] = [];
  const warnings: string[] = [];
  const engines: StretchEngine[] = [];
  let invocation = "pairwise-original-joins";
  let accPath: string | null = null;
  let accDurationMs = 0;
  try {
    for (let i = 1; i < request.segments.length; i += 1) {
      const outgoing = request.segments[i - 1]!;
      const next = request.segments[i]!;
      const overlap = request.overlapMs[i - 1]!;
      const joinPath = path.join(dir, `${base}.join-${i}.wav`);
      temps.push(joinPath);
      const join = await renderMix(runner, binaries, {
        ...request,
        segments: [outgoing, next],
        overlapMs: [overlap],
        transitions: request.transitions
          ? [request.transitions[i - 1] ?? { type: "crossfade" }]
          : undefined,
        outgoingCrossoverHz:
          i > 1
            ? (resolvedCrossoverHz(request.transitions?.[i - 2]) ??
              resolvedCrossoverHz(request.transitions?.[i - 1]))
            : request.outgoingCrossoverHz,
        incomingCrossoverHz:
          resolvedCrossoverHz(request.transitions?.[i - 1]) ??
          resolvedCrossoverHz(request.transitions?.[i]),
        outputPath: joinPath,
        outputMetadata: undefined,
        edgeFadeMs: 0,
        postProcess: false,
        applyLimiter: false,
        pcmCodec: INTERMEDIATE_PCM_CODEC,
        fidelityMode: false,
        onProgress: (fraction) => {
          const overall = (i - 1 + fraction) / (request.segments.length - 1);
          request.onProgress?.(Math.min(0.9, overall));
        },
      });
      engines.push(join.stretchEngine);
      warnings.push(...join.warnings);
      invocation = `${invocation} ; ${join.invocation}`;
      if (accPath == null) {
        accPath = joinPath;
        accDurationMs = join.durationMs;
        continue;
      }
      const outgoingPlayableMs = Math.round(
        outputDurationSec(toTrims([outgoing])[0]!, {
          overlapSec: overlap / 1000,
          stretchScope,
        }) * 1000,
      );
      const stitched = path.join(dir, `${base}.stitch-${i}.wav`);
      temps.push(stitched);
      await stitchPreservedPrefix(
        runner,
        binaries,
        accPath,
        accDurationMs,
        joinPath,
        outgoingPlayableMs - overlap,
        overlap,
        stitched,
        request.abortSignal,
      );
      invocation = `${invocation} ; pairwise-preserve-prefix`;
      accPath = stitched;
      const probe = await probeAudioFile(runner, binaries, stitched, request.abortSignal);
      accDurationMs = probe.durationMs;
    }
    if (!accPath) {
      throw new DomainError("INVALID_SET_PLAN", "Render has no audio segments", {
        retryable: false,
      });
    }
    const expectedMs = expectedDurationMs(
      toTrims(request.segments),
      request.overlapMs.map((ms) => ms / 1000),
      stretchScope,
    );
    if (
      (request.postProcess ?? true) === false &&
      !isFlacOutput(request.outputPath) &&
      !request.outputMetadata
    ) {
      await mkdir(path.dirname(request.outputPath), { recursive: true });
      await copyFile(accPath, request.outputPath);
      const probe = await probeAudioFile(runner, binaries, request.outputPath, request.abortSignal);
      return {
        durationMs: probe.durationMs,
        sampleRateHz: probe.sampleRateHz,
        channels: probe.channels,
        checksumSha256: await sha256File(request.outputPath),
        integratedLufs: null,
        truePeakDb: null,
        invocation,
        warnings,
        expectedDurationMs: expectedMs,
        staticGainDb: null,
        limiterApplied: false,
        stretchEngine: combineStretchEngines(engines),
        stretchEngines: engines,
      };
    }
    const finalized = await renderMix(runner, binaries, {
      ...request,
      segments: [
        {
          filePath: accPath,
          sourceStartMs: 0,
          sourceEndMs: accDurationMs,
          gainDb: 0,
          playbackRate: 1,
        },
      ],
      overlapMs: [],
      transitions: undefined,
      rateRegionsVersion: undefined,
      postProcess: request.postProcess ?? true,
      applyLimiter: false,
      fidelityMode: request.fidelityMode,
      rubberbandCliPath: request.rubberbandCliPath,
    });
    return {
      ...finalized,
      warnings: [...warnings, ...finalized.warnings],
      invocation: `${invocation} ; ${finalized.invocation}`,
      expectedDurationMs: expectedMs,
      stretchEngine: combineStretchEngines(engines),
      stretchEngines: engines,
    };
  } finally {
    await Promise.all(temps.map(removeIfPresent));
  }
}
