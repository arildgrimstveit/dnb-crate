import { randomBytes } from "node:crypto";
import { access, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AnalyzerResult } from "@dnb-crate/audio-analysis";
import { normalizeKey, type AppConfig } from "@dnb-crate/domain";
import type { ProcessRunner } from "@dnb-crate/audio-renderer";

export type KeyEngineProbe = {
  engine: "keyfinder" | null;
  command: string | null;
  available: boolean;
};

async function findOnPath(name: string): Promise<string | null> {
  const names = process.platform === "win32" ? [name, `${name}.exe`] : [name];
  const bundled = path.resolve(
    process.cwd(),
    "tools",
    "keyfinder-cli",
    process.platform === "win32" ? "keyfinder-cli.exe" : "keyfinder-cli",
  );
  const dirs = [path.dirname(bundled), process.cwd(), ...(process.env.PATH ?? "").split(path.delimiter)];
  const extra = [bundled];
  for (const candidate of extra) {
    try {
      await access(candidate, constants.F_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  for (const dir of dirs) {
    for (const file of names) {
      const candidate = path.join(dir, file);
      try {
        await access(candidate, constants.F_OK);
        return candidate;
      } catch {
        // continue
      }
    }
  }
  return null;
}

export async function probeKeyEngine(_config: AppConfig): Promise<KeyEngineProbe> {
  const keyfinder = await findOnPath("keyfinder-cli");
  if (keyfinder) {
    return { engine: "keyfinder", command: keyfinder, available: true };
  }
  return { engine: null, command: null, available: false };
}

export async function runKeyEngine(
  runner: ProcessRunner,
  config: AppConfig,
  filePath: string,
): Promise<AnalyzerResult> {
  const probe = await probeKeyEngine(config);
  if (!probe.available || !probe.engine || !probe.command) {
    throw new Error("KeyFinder CLI is not installed (keyfinder-cli)");
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
      cwd: path.dirname(probe.command),
    });
    if (decoded.exitCode !== 0) {
      throw new Error(decoded.stderr.slice(-400) || "FFmpeg decode for KeyFinder failed");
    }
    result = await runner.run({
      executable: probe.command,
      args: [wavPath],
      timeoutMs: 180_000,
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
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.slice(-400) || `${probe.engine} exited ${result.exitCode}`);
  }
  const parsed = parseKeyStdout(result.stdout);
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

export function parseKeyStdout(
  stdout: string,
): { musicalKey: string | null; camelotKey: string | null; keyConfidence: number | null } {
  const first = stdout.trim().split(/\s+/)[0] ?? "";
  const normalized = normalizeKey(first);
  return {
    musicalKey: normalized?.musicalKey ?? null,
    camelotKey: normalized?.camelotKey ?? null,
    keyConfidence: normalized ? 0.7 : null,
  };
}
