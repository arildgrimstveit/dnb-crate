import { createHash, randomBytes } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AnalyzerResult } from "@dnb-crate/audio-analysis";
import { DomainError, normalizeKey, type AppConfig } from "@dnb-crate/domain";
import { createNodeProcessRunner, type ProcessRunner } from "@dnb-crate/audio-renderer";

export type KeyEngineProbe = {
  engine: "keyfinder" | null;
  command: string | null;
  available: boolean;
  identity?: string;
  reason?: string;
};

function candidates(config: AppConfig): string[] {
  if (config.keyfinderPath) return [config.keyfinderPath];
  const name = process.platform === "win32" ? "keyfinder-cli.exe" : "keyfinder-cli";
  return [
    ...new Set([
      path.resolve(process.cwd(), "tools", "keyfinder-cli", name),
      ...(process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir.replace(/^"|"$/g, ""), name)),
    ]),
  ];
}

/** Recognition confidence is a fixed heuristic, not a KeyFinder probability. */
export const KEYFINDER_CONFIDENCE = 0.7;

export async function probeKeyEngine(
  config: AppConfig,
  runner: ProcessRunner = createNodeProcessRunner(),
): Promise<KeyEngineProbe> {
  for (const command of candidates(config)) {
    try {
      const bytes = await readFile(command);
      const result = await runner.run({
        executable: command,
        args: [],
        timeoutMs: 10_000,
        cwd: path.dirname(command),
      });
      if (result.timedOut || !/usage:.*keyfinder/i.test(result.stdout + result.stderr))
        throw new Error("Unrecognized KeyFinder executable");
      return {
        engine: "keyfinder",
        command,
        available: true,
        identity: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch (cause) {
      if (config.keyfinderPath)
        throw new DomainError(
          "CONFIG_INVALID",
          "keyfinderPath is not a usable KeyFinder CLI executable. Correct keyfinderPath or DNB_CRATE_KEYFINDER_PATH.",
          { cause },
        );
    }
  }
  return { engine: null, command: null, available: false };
}

export async function runKeyEngine(
  runner: ProcessRunner,
  config: AppConfig,
  filePath: string,
  resolved?: KeyEngineProbe,
  abortSignal?: AbortSignal,
): Promise<AnalyzerResult> {
  const probe = resolved ?? (await probeKeyEngine(config, runner));
  if (!probe.available || !probe.engine || !probe.command) {
    throw new Error(
      probe.reason ??
        "KeyFinder CLI is not installed. Install keyfinder-cli or configure keyfinderPath.",
    );
  }
  const started = Date.now();
  let wavPath: string | null = null;
  let result;
  try {
    wavPath = path.join(os.tmpdir(), `dnb-key-${randomBytes(6).toString("hex")}.wav`);
    const ffmpeg = config.ffmpegPath ?? "ffmpeg";
    const decoded = await runner.run({
      executable: ffmpeg,
      args: [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        filePath,
        "-ac",
        "2",
        "-ar",
        "44100",
        "-c:a",
        "pcm_s16le",
        wavPath,
      ],
      timeoutMs: 180_000,
      abortSignal,
      cwd: path.dirname(probe.command),
    });
    if (decoded.exitCode !== 0 || decoded.timedOut || abortSignal?.aborted) {
      throw new Error(
        abortSignal?.aborted
          ? "Key analysis cancelled."
          : decoded.timedOut
            ? "Key decode timed out after 180 seconds. Retry with a shorter or repaired source."
            : "FFmpeg could not decode the source for KeyFinder. Check source readability.",
      );
    }
    result = await runner.run({
      executable: probe.command,
      args: [wavPath],
      timeoutMs: 180_000,
      abortSignal,
      cwd: path.dirname(probe.command),
    });
  } finally {
    if (wavPath) {
      try {
        await unlink(wavPath);
      } catch {
        // best-effort
      }
    }
  }
  if (result.exitCode !== 0 || result.timedOut || abortSignal?.aborted) {
    throw new Error(
      abortSignal?.aborted
        ? "Key analysis cancelled."
        : result.timedOut
          ? "KeyFinder timed out after 180 seconds. Retry with a shorter or repaired source."
          : "KeyFinder execution failed. Check its native dependencies and source readability.",
    );
  }
  const parsed = parseKeyStdout(result.stdout);
  if (!parsed.musicalKey)
    throw new Error(
      "KeyFinder returned an unrecognized key. Retry with a readable musical source.",
    );
  return {
    analyzerName: "keyfinder",
    analyzerVersion: "1.0.0",
    bpm: null,
    bpmConfidence: null,
    bpmRaw: null,
    beatTimesMs: [],
    downbeatTimesMs: [],
    gridRejected: true,
    gridRejectionReason: "key-only evidence",
    gridSource: "analyzed",
    musicalKey: parsed.musicalKey,
    keyConfidence: parsed.keyConfidence,
    keyMode: parsed.musicalKey?.endsWith("m") ? "minor" : parsed.musicalKey ? "major" : null,
    camelotKey: parsed.camelotKey,
    keyRunnerUp: null,
    tempoStability: null,
    downbeatConfidence: null,
    lowBandEnergy: null,
    midBandEnergy: null,
    highBandEnergy: null,
    waveformSummary: [],
    suggestedCues: [],
    sections: [],
    descriptors: {
      integratedLufs: null,
      shortTermLufsMean: null,
      shortTermLufsMax: null,
      truePeakDb: null,
      subBassRatio: null,
      brightness: null,
      onsetDensity: null,
      dynamicRange: null,
      dropIntensity: null,
      suggestedEnergy: null,
      energy: null,
      danceability: null,
      acousticness: null,
      melodicness: null,
      valence: null,
      waveformSummary: [],
      lowBandEnergy: null,
      midBandEnergy: null,
      highBandEnergy: null,
      chromaVector: null,
      tempoEvidence: null,
      keyCandidates: parsed.musicalKey ? [parsed.musicalKey] : null,
    },
    engineRuntimeMs: Date.now() - started,
  };
}

export function parseKeyStdout(stdout: string): {
  musicalKey: string | null;
  camelotKey: string | null;
  keyConfidence: number | null;
} {
  const first = stdout.trim().split(/\s+/)[0] ?? "";
  const normalized = normalizeKey(first);
  return {
    musicalKey: normalized?.musicalKey ?? null,
    camelotKey: normalized?.camelotKey ?? null,
    keyConfidence: normalized ? KEYFINDER_CONFIDENCE : null,
  };
}
