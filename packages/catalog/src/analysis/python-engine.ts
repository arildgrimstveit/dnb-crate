import path from "node:path";
import { access } from "node:fs/promises";
import { constants } from "node:fs";

import type { AnalyzerResult } from "@dnb-crate/audio-analysis";
import {
  DomainError,
  type AnalysisEngineId,
  type AppConfig,
} from "@dnb-crate/domain";
import type { ProcessRunner } from "@dnb-crate/audio-renderer";

export type PythonEngineStatus = {
  available: boolean;
  engines: AnalysisEngineId[];
  pythonPath: string | null;
  scriptPath: string | null;
};

function defaultPythonPath(): string {
  const base = path.join(process.cwd(), "tools", "analyzer-py", ".venv");
  return process.platform === "win32"
    ? path.join(base, "Scripts", "python.exe")
    : path.join(base, "bin", "python");
}

function defaultScriptPath(): string {
  return path.join(process.cwd(), "tools", "analyzer-py", "analyze.py");
}

export function pythonPaths(config: AppConfig): { pythonPath: string; scriptPath: string } {
  return {
    pythonPath: config.analysis?.engines?.python?.pythonPath ?? defaultPythonPath(),
    scriptPath: config.analysis?.engines?.python?.scriptPath ?? defaultScriptPath(),
  };
}

export async function probePythonEngine(config: AppConfig): Promise<PythonEngineStatus> {
  const enabled = config.analysis?.engines?.python?.enabled === true;
  const { pythonPath, scriptPath } = pythonPaths(config);
  if (!enabled) {
    return { available: false, engines: [], pythonPath, scriptPath };
  }
  try {
    await access(pythonPath, constants.X_OK).catch(async () => access(pythonPath, constants.F_OK));
    await access(scriptPath, constants.F_OK);
    return { available: true, engines: ["beat-this", "allin1"], pythonPath, scriptPath };
  } catch {
    return { available: false, engines: [], pythonPath, scriptPath };
  }
}

export async function runPythonAnalyzer(
  runner: ProcessRunner,
  config: AppConfig,
  engine: "beat-this" | "allin1",
  filePath: string,
): Promise<AnalyzerResult> {
  const status = await probePythonEngine(config);
  if (!status.available || !status.pythonPath || !status.scriptPath) {
    throw new DomainError(
      "ANALYSIS_ENGINE_UNAVAILABLE",
      `Python sidecar is not available for ${engine}. Enable analysis.engines.python and run tools/analyzer-py/setup.`,
      { retryable: false },
    );
  }
  const result = await runner.run({
    executable: status.pythonPath,
    args: [status.scriptPath, "--engine", engine, "--input", filePath, "--sample-rate", "22050"],
    timeoutMs: engine === "allin1" ? 900_000 : 180_000,
  });
  if (result.timedOut) {
    throw new DomainError(
      "ANALYSIS_ENGINE_FAILED",
      `${engine} sidecar timed out`,
      { retryable: true },
    );
  }
  if (result.exitCode !== 0) {
    throw new DomainError(
      "ANALYSIS_ENGINE_FAILED",
      result.stderr.slice(-400) || `${engine} sidecar exited ${result.exitCode}`,
      { retryable: true, details: { stderr: result.stderr.slice(-400) } },
    );
  }
  let parsed: Partial<AnalyzerResult>;
  try {
    parsed = JSON.parse(result.stdout) as Partial<AnalyzerResult>;
  } catch {
    throw new DomainError("ANALYSIS_ENGINE_FAILED", `${engine} sidecar returned invalid JSON`, {
      retryable: true,
    });
  }
  return {
    analyzerName: parsed.analyzerName ?? engine,
    analyzerVersion: parsed.analyzerVersion ?? "sidecar",
    bpm: parsed.bpm ?? null,
    bpmConfidence: parsed.bpmConfidence ?? null,
    bpmRaw: parsed.bpmRaw ?? parsed.bpm ?? null,
    beatTimesMs: parsed.beatTimesMs ?? [],
    downbeatTimesMs: parsed.downbeatTimesMs ?? [],
    gridRejected: parsed.gridRejected ?? parsed.bpm == null,
    gridRejectionReason: parsed.gridRejectionReason ?? null,
    musicalKey: null,
    keyConfidence: null,
    keyMode: null,
    camelotKey: null,
    keyRunnerUp: null,
    tempoStability: null,
    downbeatConfidence: parsed.downbeatConfidence ?? null,
    lowBandEnergy: null,
    midBandEnergy: null,
    highBandEnergy: null,
    waveformSummary: [],
    suggestedCues: parsed.suggestedCues ?? [],
    sections: parsed.sections ?? [],
    descriptors: null,
    engineRuntimeMs: parsed.engineRuntimeMs ?? null,
  };
}
