import { describe, expect, it } from "vitest";

import { envelopeAnalyzer } from "../src/envelope-analyzer.ts";
import { buildClickTrackPcm } from "../src/click-track.ts";
import { decodeWavPcm } from "../src/wav.ts";
import { encodeMonoWav } from "../src/click-track.ts";

describe("envelope analyzer click-track grids", () => {
  it.each([170, 174, 180])("detects %i BPM click tracks within 0.5 BPM", (bpm) => {
    const pcm = buildClickTrackPcm({ bpm, durationMs: 12_000, offsetMs: 0 });
    const result = envelopeAnalyzer.analyze(pcm);
    expect(result.gridRejected).toBe(false);
    expect(result.bpm).not.toBeNull();
    expect(Math.abs((result.bpm ?? 0) - bpm)).toBeLessThan(0.5);
    expect(result.bpmConfidence ?? 0).toBeGreaterThanOrEqual(0.5);
    const period = 60_000 / bpm;
    const firstBeats = result.beatTimesMs.slice(0, 8);
    for (let i = 0; i < firstBeats.length; i += 1) {
      const expected = i * period;
      expect(Math.abs(firstBeats[i]! - expected)).toBeLessThan(20);
    }
  });

  it("tracks a 120ms offset within 20ms", () => {
    const pcm = buildClickTrackPcm({ bpm: 174, durationMs: 10_000, offsetMs: 120 });
    const result = envelopeAnalyzer.analyze(pcm, { beatAnchorMs: 120 });
    expect(result.gridRejected).toBe(false);
    expect(Math.abs((result.beatTimesMs[0] ?? 0) - 120)).toBeLessThan(20);
  });

  it("folds 87 BPM half-time clicks into 174", () => {
    const pcm = buildClickTrackPcm({ bpm: 87, durationMs: 16_000 });
    const result = envelopeAnalyzer.analyze(pcm);
    expect(result.gridRejected).toBe(false);
    expect(result.bpm).toBeCloseTo(174, 0);
    expect(result.bpmRaw).toBeCloseTo(87, 0);
  });

  it("rejects a grid that cannot fold into 160–190", () => {
    const pcm = buildClickTrackPcm({ bpm: 100, durationMs: 10_000 });
    const result = envelopeAnalyzer.analyze(pcm);
    expect(result.gridRejected).toBe(true);
    expect(result.gridRejectionReason).toMatch(/DnB tempo/i);
  });

  it("rejects unstructured noise rather than inventing a grid", () => {
    const samples = new Float32Array(44_100 * 4);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = ((i * 1103515245 + 12345) >>> 16) / 32768 - 1;
    }
    const result = envelopeAnalyzer.analyze({
      samples,
      sampleRateHz: 44_100,
      durationMs: 4000,
      channels: 1,
    });
    expect(result.gridRejected || (result.bpmConfidence ?? 0) < 0.5).toBe(true);
  });

  it("rejects a constant sine rather than inventing a DnB grid", () => {
    const samples = new Float32Array(44_100 * 4);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / 44_100);
    }
    const result = envelopeAnalyzer.analyze({
      samples,
      sampleRateHz: 44_100,
      durationMs: 4000,
      channels: 1,
    });
    expect(result.gridRejected).toBe(true);
  });

  it("round-trips click WAV decode", () => {
    const pcm = buildClickTrackPcm({ bpm: 174, durationMs: 500 });
    const decoded = decodeWavPcm(encodeMonoWav(pcm));
    expect(decoded.sampleRateHz).toBe(pcm.sampleRateHz);
    expect(decoded.samples.length).toBe(pcm.samples.length);
  });
});
