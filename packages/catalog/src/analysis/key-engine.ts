import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import type { AnalyzerResult } from "@dnb-crate/audio-analysis";
import { normalizeKey, type AnalysisEngineId, type AppConfig } from "@dnb-crate/domain";
import type { ProcessRunner } from "@dnb-crate/audio-renderer";

export type KeyEngineProbe = {
  engine: "keyfinder" | "essentia-key" | null;
  command: string | null;
  available: boolean;
};

function essentiaScriptPath(): string {
  return path.join(process.cwd(), "tools", "analyzer-py", "extract-key.py");
}

function defaultPythonPath(): string {
  const base = path.join(process.cwd(), "tools", "analyzer-py", ".venv");
  return process.platform === "win32"
    ? path.join(base, "Scripts", "python.exe")
    : path.join(base, "bin", "python");
}

async function findOnPath(name: string): Promise<string | null> {
  const names = process.platform === "win32" ? [name, `${name}.exe`] : [name];
  const bundled = path.resolve(process.cwd(), "tools", "keyfinder-cli", process.platform === "win32" ? "keyfinder-cli.exe" : "keyfinder-cli");
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

export async function probeKeyEngine(config: AppConfig): Promise<KeyEngineProbe> {
  const keyfinder = await findOnPath("keyfinder-cli");
  if (keyfinder) {
    return { engine: "keyfinder", command: keyfinder, available: true };
  }
  const pythonPath = config.analysis?.engines?.python?.pythonPath ?? defaultPythonPath();
  const script = essentiaScriptPath();
  try {
    await access(pythonPath, constants.F_OK);
    await access(script, constants.F_OK);
    await execFileAsync(pythonPath, ["-c", "import essentia.standard"], { timeout: 20_000 });
    return { engine: "essentia-key", command: pythonPath, available: true };
  } catch {
    return { engine: null, command: null, available: false };
  }
}

export async function runKeyEngine(
  runner: ProcessRunner,
  config: AppConfig,
  filePath: string,
): Promise<AnalyzerResult> {
  const probe = await probeKeyEngine(config);
  if (!probe.available || !probe.engine || !probe.command) {
    throw new Error("No local key engine is installed (keyfinder-cli or Essentia extract-key.py)");
  }
  const started = Date.now();
  let wavPath: string | null = null;
  let result;
  try {
    if (probe.engine === "keyfinder") {
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
    } else {
      result = await runner.run({
        executable: probe.command,
        args: [essentiaScriptPath(), "--input", filePath],
        timeoutMs: 180_000,
      });
    }
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
  const parsed = parseKeyStdout(result.stdout, probe.engine);
  const engine: AnalysisEngineId = probe.engine;
  return {
    analyzerName: engine,
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
  engine: "keyfinder" | "essentia-key",
): { musicalKey: string | null; camelotKey: string | null; keyConfidence: number | null } {
  const trimmed = stdout.trim();
  if (engine === "essentia-key") {
    try {
      const parsed = JSON.parse(trimmed) as {
        musicalKey?: string | null;
        keyConfidence?: number | null;
      };
      const normalized = normalizeKey(parsed.musicalKey);
      return {
        musicalKey: normalized?.musicalKey ?? null,
        camelotKey: normalized?.camelotKey ?? null,
        keyConfidence: parsed.keyConfidence ?? null,
      };
    } catch {
      return { musicalKey: null, camelotKey: null, keyConfidence: null };
    }
  }
  const first = trimmed.split(/\s+/)[0] ?? "";
  const normalized = normalizeKey(first);
  return {
    musicalKey: normalized?.musicalKey ?? null,
    camelotKey: normalized?.camelotKey ?? null,
    keyConfidence: normalized ? 0.7 : null,
  };
}
