import { describe, expect, it } from "vitest";

import type { AnalyzerResult } from "@dnb-crate/audio-analysis";
import { DomainError } from "@dnb-crate/domain";
import type { ProcessRunner } from "@dnb-crate/audio-renderer";

import { mergeAnalyzerResults } from "../src/analysis/merger.ts";
import { runPythonAnalyzer } from "../src/analysis/python-engine.ts";

function dspStub(): AnalyzerResult {
  return {
    analyzerName: "dnb-crate-dsp",
    analyzerVersion: "2.0.0",
    bpm: 174,
    bpmConfidence: 0.9,
    bpmRaw: 174,
    beatTimesMs: [0, 344],
    downbeatTimesMs: [0],
    gridRejected: false,
    gridRejectionReason: null,
    musicalKey: "Fm",
    keyConfidence: 0.8,
    keyMode: "minor",
    camelotKey: "4A",
    keyRunnerUp: "Cm",
    tempoStability: 0.9,
    downbeatConfidence: 0.7,
    lowBandEnergy: 0.4,
    midBandEnergy: 0.4,
    highBandEnergy: 0.2,
    waveformSummary: [0.1],
    suggestedCues: [],
    sections: [
      {
        type: "drop",
        startMs: 1000,
        endMs: 2000,
        startBar: 8,
        endBar: 16,
        confidence: 0.6,
        sectionEnergy: 0.8,
      },
    ],
    descriptors: {
      integratedLufs: null,
      shortTermLufsMean: null,
      shortTermLufsMax: null,
      truePeakDb: null,
      subBassRatio: 0.4,
      brightness: 0.2,
      onsetDensity: 0.5,
      dynamicRange: 8,
      dropIntensity: 0.7,
      suggestedEnergy: 8,
      waveformSummary: [0.1],
      lowBandEnergy: 0.4,
      midBandEnergy: 0.4,
      highBandEnergy: 0.2,
      chromaVector: null,
      tempoEvidence: null,
    },
    engineRuntimeMs: 12,
  };
}

describe("analysis merger and python adapter", () => {
  it("keeps sidecar rhythm and TypeScript key/descriptors", () => {
    const rhythm: AnalyzerResult = {
      ...dspStub(),
      analyzerName: "beat-this",
      bpm: 176,
      musicalKey: null,
      keyMode: null,
      descriptors: null,
      sections: [],
      suggestedCues: [{ type: "drop", positionMs: 1500, confidence: 0.9 }],
    };
    const merged = mergeAnalyzerResults(rhythm, dspStub());
    expect(merged.bpm).toBe(176);
    expect(merged.musicalKey).toBe("Fm");
    expect(merged.camelotKey).toBe("4A");
    expect(merged.descriptors?.suggestedEnergy).toBe(8);
    expect(merged.suggestedCues[0]?.positionMs).toBe(1500);
    expect(merged.sections[0]?.type).toBe("drop");
  });

  it("maps canned sidecar JSON through a fake process runner", async () => {
    const runner: ProcessRunner = {
      async run() {
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            analyzerName: "beat-this",
            analyzerVersion: "sidecar",
            bpm: 174,
            bpmConfidence: 0.8,
            bpmRaw: 174,
            beatTimesMs: [0, 344, 689],
            downbeatTimesMs: [0, 1379],
            gridRejected: false,
            sections: [],
            engineRuntimeMs: 5,
          }),
          stderr: "",
        };
      },
    };
    const result = await runPythonAnalyzer(
      runner,
      {
        databasePath: ":memory:",
        libraryRoots: ["."],
        outputRoot: ".",
        logLevel: "error",
        supportedExtensions: [".wav"],
        analysis: {
          defaultEngine: "dnb-crate-dsp",
          engines: {
            python: {
              enabled: true,
              pythonPath: process.execPath,
              scriptPath: process.execPath,
            },
          },
        },
      },
      "beat-this",
      "C:/tmp/track.wav",
    );
    expect(result.analyzerName).toBe("beat-this");
    expect(result.bpm).toBe(174);
    expect(result.beatTimesMs).toHaveLength(3);
  });

  it("throws ANALYSIS_ENGINE_UNAVAILABLE when python is disabled", async () => {
    const runner: ProcessRunner = {
      async run() {
        throw new Error("should not run");
      },
    };
    await expect(
      runPythonAnalyzer(
        runner,
        {
          databasePath: ":memory:",
          libraryRoots: ["."],
          outputRoot: ".",
          logLevel: "error",
          supportedExtensions: [".wav"],
        },
        "beat-this",
        "C:/tmp/track.wav",
      ),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("throws ANALYSIS_ENGINE_FAILED retryable on sidecar timeout", async () => {
    const runner: ProcessRunner = {
      async run(request) {
        expect(request.timeoutMs).toBe(180_000);
        return {
          exitCode: 1,
          signal: "SIGTERM",
          stdout: "",
          stderr: "timed out",
          timedOut: true,
        };
      },
    };
    await expect(
      runPythonAnalyzer(
        runner,
        {
          databasePath: ":memory:",
          libraryRoots: ["."],
          outputRoot: ".",
          logLevel: "error",
          supportedExtensions: [".wav"],
          analysis: {
            defaultEngine: "dnb-crate-dsp",
            engines: {
              python: {
                enabled: true,
                pythonPath: process.execPath,
                scriptPath: process.execPath,
              },
            },
          },
        },
        "beat-this",
        "C:/tmp/track.wav",
      ),
    ).rejects.toMatchObject({ code: "ANALYSIS_ENGINE_FAILED", retryable: true });
  });
});
