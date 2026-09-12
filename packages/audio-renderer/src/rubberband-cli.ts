import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";

import { DomainError, effectivePlaybackRate, resolveRateRegions } from "@dnb-crate/domain";

import type { FfmpegBinaries } from "./detect.ts";
import { RATE_SPLICE_XFADE_SEC } from "./filter-graph.ts";
import { createNodeProcessRunner } from "./node-runner.ts";
import { parseEbur128 } from "./parse.ts";
import { probeAudioFile } from "./probe.ts";
import type { ProcessRunner } from "./runner.ts";

export type StretchPrepareSegment = {
  filePath: string;
  sourceStartMs: number;
  sourceEndMs: number;
  gainDb: number;
  playbackRate?: number;
  stretchTailMs?: number;
};

export type StretchPrepareRequest = {
  segments: StretchPrepareSegment[];
  overlapMs: number[];
  outputPath: string;
  stretchScope?: "all" | "overlap";
  abortSignal?: AbortSignal;
};

export const RUBBERBAND_MAKEUP_CLAMP_DB = 6;

/** Prepare both joins before accumulation; never stretch an already mixed prefix. */
export async function prepareBothJoinRegions(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  cliPath: string,
  request: StretchPrepareRequest,
  sampleRateHz: number,
): Promise<Awaited<ReturnType<typeof prepareCliStretchedSegments>>> {
  const segments: StretchPrepareSegment[] = [];
  const tempPaths: string[] = [];
  const warnings: string[] = [];
  const invocations: string[] = [];
  try {
    for (const [index, source] of request.segments.entries()) {
      const rate = source.playbackRate ?? 1;
      const head = request.overlapMs[index - 1] ?? 0;
      const tail = request.overlapMs[index] ?? 0;
      resolveRateRegions(source.sourceEndMs - source.sourceStartMs, rate, head, tail);
      let prepared = source;
      for (const [role, duration] of [
        ["head", head],
        ["tail", tail],
      ] as const) {
        if (duration <= 0 || effectivePlaybackRate(rate, duration) === 1) continue;
        // A dummy identity deck gives the head the incoming role without decoding it.
        const dummy = { ...prepared, playbackRate: 1 };
        const result = await prepareCliStretchedSegments(
          runner,
          binaries,
          cliPath,
          {
            ...request,
            outputPath: `${request.outputPath}.regions-${index}-${role}`,
            stretchScope: "overlap",
            segments:
              role === "head"
                ? [dummy, { ...prepared, playbackRate: rate }]
                : [{ ...prepared, playbackRate: rate, stretchTailMs: duration }],
            overlapMs: role === "head" ? [duration] : [],
          },
          sampleRateHz,
        );
        tempPaths.push(...result.tempPaths);
        warnings.push(...result.warnings);
        invocations.push(result.invocation);
        prepared = result.segments.at(-1)!;
      }
      segments.push({ ...prepared, playbackRate: 1, stretchTailMs: undefined });
    }
    return { segments, tempPaths, warnings, invocation: invocations.filter(Boolean).join(" ; ") };
  } catch (error) {
    await Promise.all(tempPaths.map((file) => unlink(file).catch(() => undefined)));
    throw error;
  }
}

const BUNDLED_DIR = path.join("tools", "rubberband-cli", "rubberband-4.0.0-gpl-executable-windows");

export function resolveRubberbandCli(explicit?: string | null): string | null {
  const bundled = path.resolve(process.cwd(), BUNDLED_DIR);
  const candidates = [
    explicit,
    process.env.DNB_CRATE_RUBBERBAND_PATH,
    path.join(bundled, "rubberband.exe"),
    path.join(bundled, "rubberband-r3.exe"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** R3 / fine, centre-focus. `-T` is the same tempo multiple as FFmpeg `tempo=`. */
export function rubberbandCliArgs(rate: number, inputWav: string, outputWav: string): string[] {
  return ["-3", "-T", rate.toFixed(8), "--centre-focus", "-q", inputWav, outputWav];
}

export function clampMakeupDb(gainDb: number, limit = RUBBERBAND_MAKEUP_CLAMP_DB): number {
  return Math.max(-limit, Math.min(limit, gainDb));
}

async function runFfmpeg(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  args: string[],
  abortSignal?: AbortSignal,
): Promise<void> {
  const result = await runner.run({
    executable: binaries.ffmpegPath,
    args: ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args],
    abortSignal,
  });
  if (result.exitCode !== 0) {
    throw new DomainError("RENDER_FAILED", "FFmpeg extract/splice for Rubber Band CLI failed", {
      retryable: false,
      details: { stderr: result.stderr.slice(-400) },
    });
  }
}

async function measureLufs(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  filePath: string,
  abortSignal?: AbortSignal,
): Promise<number | null> {
  const result = await runner.run({
    executable: binaries.ffmpegPath,
    args: [
      "-nostdin",
      "-hide_banner",
      "-i",
      filePath,
      "-filter_complex",
      "ebur128=peak=true",
      "-f",
      "null",
      "-",
    ],
    abortSignal,
  });
  return parseEbur128(result.stderr).integratedLufs;
}

async function applyMakeup(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  dryPath: string,
  wetPath: string,
  abortSignal?: AbortSignal,
): Promise<{ gainDb: number; outputPath: string }> {
  const [dry, wet] = await Promise.all([
    measureLufs(runner, binaries, dryPath, abortSignal),
    measureLufs(runner, binaries, wetPath, abortSignal),
  ]);
  if (dry == null || wet == null) {
    return { gainDb: 0, outputPath: wetPath };
  }
  const gainDb = clampMakeupDb(dry - wet);
  if (Math.abs(gainDb) < 0.15) {
    return { gainDb, outputPath: wetPath };
  }
  const matched = `${wetPath}.matched.wav`;
  await runFfmpeg(
    runner,
    binaries,
    ["-i", wetPath, "-af", `volume=${gainDb.toFixed(3)}dB`, "-c:a", "pcm_s24le", matched],
    abortSignal,
  );
  return { gainDb, outputPath: matched };
}

async function stretchCli(
  cliPath: string,
  rate: number,
  inputWav: string,
  outputWav: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const cli = createNodeProcessRunner();
  const result = await cli.run({
    executable: cliPath,
    args: rubberbandCliArgs(rate, inputWav, outputWav),
    abortSignal,
    cwd: path.dirname(cliPath),
  });
  if (result.exitCode !== 0) {
    throw new DomainError("RENDER_FAILED", "Rubber Band R3 CLI exited with an error", {
      retryable: false,
      details: { stderr: result.stderr.slice(-400) },
    });
  }
  return outputWav;
}

function overlapForSegment(request: StretchPrepareRequest, index: number): number {
  const segment = request.segments[index]!;
  if (segment.stretchTailMs != null) {
    return segment.stretchTailMs;
  }
  if (index === 0) {
    return request.overlapMs[0] ?? 0;
  }
  return request.overlapMs[index - 1] ?? 0;
}

/**
 * Stretch with standalone R3, then mix at rate 1. Featured body stays dry when
 * `stretchScope` is `overlap`. Makeup matches the dry slice LUFS (R3 is quieter).
 */
export async function prepareCliStretchedSegments(
  runner: ProcessRunner,
  binaries: FfmpegBinaries,
  cliPath: string,
  request: StretchPrepareRequest,
  sampleRateHz: number,
): Promise<{
  segments: StretchPrepareSegment[];
  tempPaths: string[];
  invocation: string;
  warnings: string[];
}> {
  const stretchScope = request.stretchScope ?? "overlap";
  const tempPaths: string[] = [];
  const warnings: string[] = [];
  const parts: string[] = [];
  const work = path.dirname(request.outputPath);
  const segments: StretchPrepareSegment[] = [];

  try {
    for (let i = 0; i < request.segments.length; i += 1) {
      const segment = request.segments[i]!;
      const sourceMs = segment.sourceEndMs - segment.sourceStartMs;
      const requested = segment.playbackRate ?? 1;
      const overlapMs = overlapForSegment(request, i);
      const rate = effectivePlaybackRate(
        requested,
        stretchScope === "all" || overlapMs <= 0 ? sourceMs : overlapMs,
      );
      if (rate === 1) {
        segments.push(segment);
        continue;
      }
      const slice = path.join(work, `${path.basename(request.outputPath)}.rb${i}.slice.wav`);
      const stretched = path.join(work, `${path.basename(request.outputPath)}.rb${i}.wav`);
      tempPaths.push(slice, stretched);
      await runFfmpeg(
        runner,
        binaries,
        [
          "-ss",
          (segment.sourceStartMs / 1000).toFixed(6),
          "-i",
          segment.filePath,
          "-t",
          (sourceMs / 1000).toFixed(6),
          "-ar",
          String(sampleRateHz),
          "-ac",
          "2",
          "-c:a",
          "pcm_s24le",
          slice,
        ],
        request.abortSignal,
      );
      const overlapOutSec = overlapMs / 1000;
      const sourceSec = sourceMs / 1000;
      const overlapSrc = overlapOutSec * rate;
      const xfade = RATE_SPLICE_XFADE_SEC;
      const canSplit =
        stretchScope === "overlap" &&
        overlapOutSec > 0 &&
        overlapSrc < sourceSec - xfade &&
        overlapSrc >= xfade;

      if (!canSplit) {
        await stretchCli(cliPath, rate, slice, stretched, request.abortSignal);
        const makeup = await applyMakeup(runner, binaries, slice, stretched, request.abortSignal);
        if (makeup.outputPath !== stretched) {
          tempPaths.push(makeup.outputPath);
        }
        const probe = await probeAudioFile(
          runner,
          binaries,
          makeup.outputPath,
          request.abortSignal,
        );
        segments.push({
          ...segment,
          filePath: makeup.outputPath,
          sourceStartMs: 0,
          sourceEndMs: probe.durationMs,
          playbackRate: 1,
          stretchTailMs: undefined,
        });
        parts.push(`rubberband-r3 -T ${rate.toFixed(6)} makeup=${makeup.gainDb.toFixed(2)}dB`);
        if (Math.abs(makeup.gainDb) >= 0.15) {
          warnings.push(
            `Rubber Band R3 makeup ${makeup.gainDb.toFixed(2)} dB to match the dry slice.`,
          );
        }
        continue;
      }

      const role = segment.stretchTailMs != null || i === 0 ? "outgoing" : "incoming";
      const region = path.join(work, `${path.basename(request.outputPath)}.rb${i}.region.wav`);
      const regionOut = path.join(
        work,
        `${path.basename(request.outputPath)}.rb${i}.region-rb.wav`,
      );
      const native = path.join(work, `${path.basename(request.outputPath)}.rb${i}.native.wav`);
      tempPaths.push(region, regionOut, native, stretched);
      if (role === "outgoing") {
        const bodySrc = sourceSec - overlapSrc;
        await runFfmpeg(
          runner,
          binaries,
          [
            "-i",
            slice,
            "-af",
            `atrim=start=${bodySrc.toFixed(6)},asetpts=PTS-STARTPTS`,
            "-c:a",
            "pcm_s24le",
            region,
          ],
          request.abortSignal,
        );
        await runFfmpeg(
          runner,
          binaries,
          [
            "-i",
            slice,
            "-af",
            `atrim=start=0:end=${(bodySrc + xfade).toFixed(6)},asetpts=PTS-STARTPTS`,
            "-c:a",
            "pcm_s24le",
            native,
          ],
          request.abortSignal,
        );
      } else {
        await runFfmpeg(
          runner,
          binaries,
          [
            "-i",
            slice,
            "-af",
            `atrim=start=0:end=${overlapSrc.toFixed(6)},asetpts=PTS-STARTPTS`,
            "-c:a",
            "pcm_s24le",
            region,
          ],
          request.abortSignal,
        );
        await runFfmpeg(
          runner,
          binaries,
          [
            "-i",
            slice,
            "-af",
            `atrim=start=${Math.max(0, overlapSrc - xfade).toFixed(6)},asetpts=PTS-STARTPTS`,
            "-c:a",
            "pcm_s24le",
            native,
          ],
          request.abortSignal,
        );
      }
      await stretchCli(cliPath, rate, region, regionOut, request.abortSignal);
      const makeup = await applyMakeup(runner, binaries, region, regionOut, request.abortSignal);
      if (makeup.outputPath !== regionOut) {
        tempPaths.push(makeup.outputPath);
      }
      const left = role === "outgoing" ? native : makeup.outputPath;
      const right = role === "outgoing" ? makeup.outputPath : native;
      await runFfmpeg(
        runner,
        binaries,
        [
          "-i",
          left,
          "-i",
          right,
          "-filter_complex",
          `[0:a][1:a]acrossfade=d=${xfade}:o=1:c1=hsin:c2=hsin[out]`,
          "-map",
          "[out]",
          "-c:a",
          "pcm_s24le",
          stretched,
        ],
        request.abortSignal,
      );
      const probe = await probeAudioFile(runner, binaries, stretched, request.abortSignal);
      segments.push({
        ...segment,
        filePath: stretched,
        sourceStartMs: 0,
        sourceEndMs: probe.durationMs,
        playbackRate: 1,
        stretchTailMs: undefined,
      });
      parts.push(
        `rubberband-r3 ${role} -T ${rate.toFixed(6)} makeup=${makeup.gainDb.toFixed(2)}dB`,
      );
      if (Math.abs(makeup.gainDb) >= 0.15) {
        warnings.push(
          `Rubber Band R3 makeup ${makeup.gainDb.toFixed(2)} dB to match the dry slice.`,
        );
      }
    }

    return {
      segments,
      tempPaths,
      invocation: parts.join(" ; "),
      warnings,
    };
  } catch (error) {
    await Promise.all(
      tempPaths.map(async (filePath) => {
        try {
          await unlink(filePath);
        } catch {
          // best-effort
        }
      }),
    );
    throw error;
  }
}
