import { describe, expect, it } from "vitest";

import { dspAnalyzer } from "../src/dsp-analyzer.ts";
import { computeDescriptorPack } from "../src/descriptors.ts";
import {
  buildDrumsOnlyDnbPcm,
  buildKeyedDnbPcm,
  buildPadOnlyPcm,
  buildSyntheticDnbPcm,
} from "../src/synthetic-dnb.ts";

function inUnit(value: number | null | undefined): void {
  expect(value).toBeTypeOf("number");
  expect(value ?? -1).toBeGreaterThanOrEqual(0);
  expect(value ?? 2).toBeLessThanOrEqual(1);
}

describe("descriptor pack", () => {
  it("scores synthetic DnB as danceable, electric, and energetic", () => {
    const pcm = buildSyntheticDnbPcm({ bpm: 174 });
    const result = dspAnalyzer.analyze(pcm);
    const d = result.descriptors!;
    inUnit(d.energy);
    inUnit(d.danceability);
    inUnit(d.acousticness);
    inUnit(d.melodicness);
    inUnit(d.valence);
    expect(d.danceability ?? 0).toBeGreaterThanOrEqual(0.7);
    expect(d.acousticness ?? 1).toBeLessThanOrEqual(0.3);
    expect(d.energy ?? 0).toBeGreaterThanOrEqual(0.6);
    expect(d.suggestedEnergy).toBe(Math.round(1 + 9 * (d.energy ?? 0)));
    expect(d.shortTermLufsMean).not.toBeNull();
    expect(d.shortTermLufsMax).not.toBeNull();
  });

  it("scores a pad-only fixture as acoustic and low-energy", () => {
    const pcm = buildPadOnlyPcm({ key: "C" });
    const result = dspAnalyzer.analyze(pcm);
    const d = result.descriptors!;
    expect(d.acousticness ?? 0).toBeGreaterThanOrEqual(0.6);
    expect(d.danceability ?? 1).toBeLessThanOrEqual(0.35);
    expect(d.energy ?? 1).toBeLessThanOrEqual(0.4);
  });

  it("scores white noise as non-melodic and not danceable", () => {
    const samples = new Float32Array(22_050 * 8);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = ((i * 1103515245 + 12345) >>> 16) / 32768 - 1;
    }
    const result = dspAnalyzer.analyze({
      samples,
      sampleRateHz: 22_050,
      durationMs: 8000,
      channels: 1,
    });
    const d = result.descriptors!;
    expect(d.melodicness ?? 1).toBeLessThanOrEqual(0.15);
    expect(d.danceability ?? 1).toBeLessThanOrEqual(0.3);
  });

  it("gives keyed DnB higher melodicness than drums-only", () => {
    const keyed = dspAnalyzer.analyze(buildKeyedDnbPcm({ key: "F#m", subHz: 46.25 }));
    const drums = dspAnalyzer.analyze(buildDrumsOnlyDnbPcm({ bpm: 174 }));
    expect((keyed.descriptors?.melodicness ?? 0) - (drums.descriptors?.melodicness ?? 0)).toBeGreaterThanOrEqual(
      0.2,
    );
  });

  it("gives a C major pad higher valence than an F#m pad", () => {
    const major = dspAnalyzer.analyze(buildPadOnlyPcm({ key: "C" }));
    const minor = dspAnalyzer.analyze(buildPadOnlyPcm({ key: "F#m" }));
    expect((major.descriptors?.valence ?? 0) - (minor.descriptors?.valence ?? 0)).toBeGreaterThanOrEqual(0.15);
  });

  it("is deterministic on the same PCM", () => {
    const pcm = buildSyntheticDnbPcm({ bpm: 174 });
    const a = dspAnalyzer.analyze(pcm);
    const b = dspAnalyzer.analyze(pcm);
    expect(a.descriptors?.energy).toBe(b.descriptors?.energy);
    expect(a.descriptors?.danceability).toBe(b.descriptors?.danceability);
    expect(a.descriptors?.acousticness).toBe(b.descriptors?.acousticness);
    expect(a.descriptors?.melodicness).toBe(b.descriptors?.melodicness);
    expect(a.descriptors?.valence).toBe(b.descriptors?.valence);
    expect(a.analyzerVersion).toBe("3.0.0");
  });

  it("maps suggestedEnergy from continuous energy", () => {
    const pack = computeDescriptorPack({
      samples: new Float32Array(22_050),
      sampleRateHz: 22_050,
      rms: 0.2,
      dropIntensity: 0.5,
      onsetDensity: 0.5,
      subBassRatio: 0.2,
      brightness: 0.1,
      dynamicRangeDb: 10,
      tempoEvidence: { prominence: 0.5, stability: 0.5, tempoConf: 0.5, onGridRatio: 0.5 },
      chroma: {
        chromaClarity: 0.5,
        tonalStability: 0.5,
        tonalPeakRatio: 0.5,
        strongPeakRatio: 0.5,
        majorness: 0.5,
        keyConfidence: 0.4,
      },
    });
    expect(pack.suggestedEnergy).toBe(Math.round(1 + 9 * pack.energy));
  });
});
