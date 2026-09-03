import { describe, expect, it } from "vitest";

import { dspAnalyzer } from "../src/dsp-analyzer.ts";
import { resolveBpmHint } from "@dnb-crate/domain";

import { buildChordPcm, buildKeyedDnbPcm, buildOffbeatHatPcm, buildSyntheticDnbPcm } from "../src/synthetic-dnb.ts";
import { buildClickTrackPcm } from "../src/click-track.ts";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

describe("dnb-crate-dsp", () => {
  it("detects synthetic DnB BPM within 0.3 and a drop near the expected bar", () => {
    const pcm = buildSyntheticDnbPcm({ bpm: 174 });
    const result = dspAnalyzer.analyze(pcm);
    expect(result.gridRejected).toBe(false);
    expect(result.bpm).not.toBeNull();
    expect(Math.abs((result.bpm ?? 0) - 174)).toBeLessThan(0.3);
    expect(result.bpmConfidence ?? 0).toBeGreaterThanOrEqual(0.7);
    expect(result.bpmConfidence).not.toBe(0.55);
    const drop = result.suggestedCues.find((cue) => cue.type === "drop");
    expect(drop).toBeDefined();
    const barMs = (4 * 60_000) / 174;
    expect(Math.abs((drop?.positionMs ?? 0) - pcm.expected.dropMs)).toBeLessThan(barMs);
    const firstDown = result.downbeatTimesMs[0] ?? 0;
    const beatMs = 60_000 / 174;
    expect(firstDown < 10 || Math.abs(firstDown - beatMs) < 10).toBe(true);
    const dropSection = result.sections.find((section) => section.type === "drop");
    expect(dropSection).toBeDefined();
  });

  it("labels sections on the synthetic fixture within one bar", () => {
    const pcm = buildSyntheticDnbPcm({ bpm: 174 });
    const result = dspAnalyzer.analyze(pcm);
    const barMs = (4 * 60_000) / 174;
    const intro = result.sections.find((section) => section.type === "intro");
    const drop = result.sections.find((section) => section.type === "drop");
    const breakdown = result.sections.find((section) => section.type === "breakdown");
    const outro = result.sections.find((section) => section.type === "outro");
    expect(intro).toBeDefined();
    expect(drop).toBeDefined();
    expect(breakdown).toBeDefined();
    expect(outro).toBeDefined();
    expect(result.sections.filter((section) => section.type === "intro")).toHaveLength(1);
    expect(result.sections.filter((section) => section.type === "drop")).toHaveLength(1);
    expect(result.sections.filter((section) => section.type === "breakdown")).toHaveLength(1);
    expect(result.sections.filter((section) => section.type === "outro")).toHaveLength(1);
    expect(Math.abs((intro?.startMs ?? 0) - 0)).toBeLessThan(barMs);
    expect(Math.abs((drop?.startMs ?? 0) - pcm.expected.dropMs)).toBeLessThan(barMs);
    expect(Math.abs((breakdown?.startMs ?? 0) - pcm.expected.breakdownMs)).toBeLessThan(barMs);
    expect(Math.abs((outro?.startMs ?? 0) - pcm.expected.outroMs)).toBeLessThan(barMs);
    expect((drop?.confidence ?? 0) >= (intro?.confidence ?? 1) - 0.05).toBe(true);
  });

  it("keeps two drop sections and a single drop cue", () => {
    const pcm = buildSyntheticDnbPcm({
      bpm: 174,
      introBars: 8,
      dropBars: 16,
      breakdownBars: 8,
      drop2Bars: 16,
      outroBars: 8,
    });
    const result = dspAnalyzer.analyze(pcm);
    expect(result.sections.filter((section) => section.type === "drop").length).toBe(2);
    expect(result.suggestedCues.filter((cue) => cue.type === "drop")).toHaveLength(1);
    const firstDrop = result.sections.find((section) => section.type === "drop");
    expect(Math.abs((firstDrop?.startMs ?? 0) - pcm.expected.dropMs)).toBeLessThan((4 * 60_000) / 174);
  });

  it("ends on a drop with no outro cue when the track never leaves the drop", () => {
    const pcm = buildSyntheticDnbPcm({
      bpm: 174,
      introBars: 8,
      dropBars: 24,
      breakdownBars: 0,
      outroBars: 0,
    });
    const result = dspAnalyzer.analyze(pcm);
    expect(result.sections.at(-1)?.type).toBe("drop");
    expect(result.suggestedCues.some((cue) => cue.type === "outro_start")).toBe(false);
  });

  it("labels a C major chord as C / 8B", () => {
    const pcm = buildChordPcm({ frequencies: [261.63, 329.63, 392.0], durationMs: 4000 });
    const result = dspAnalyzer.analyze(pcm, { dnbBpmMin: 40, dnbBpmMax: 240 });
    expect(result.musicalKey === "C" || result.keyRunnerUp === "C").toBe(true);
    if (result.musicalKey === "C") {
      expect(result.keyMode).toBe("major");
      expect(result.camelotKey).toBe("8B");
    }
    expect(result.descriptors?.chromaVector).toHaveLength(12);
  });

  it("detects F#m despite an F# sub below the chroma band", () => {
    const pcm = buildKeyedDnbPcm({ key: "F#m", subHz: 46.25 });
    const result = dspAnalyzer.analyze(pcm);
    expect(result.musicalKey).toBe("F#m");
    expect(result.camelotKey).toBe("11A");
    expect(result.keyMode).toBe("minor");
    expect(result.keyCandidates?.[0]).toBe("F#m");
    expect(result.descriptors?.keyCandidates?.[0]).toBe("F#m");
  });

  it("keeps Em when a G sub sits under an Em pad", () => {
    const pcm = buildKeyedDnbPcm({ key: "Em", subHz: 98 });
    const result = dspAnalyzer.analyze(pcm);
    expect(result.musicalKey === "Em" || result.keyRunnerUp === "Em").toBe(true);
    expect(result.musicalKey).not.toBe("G");
  });

  it("ignores a foreign A sub at 55 Hz when the pad is F#m", () => {
    const pcm = buildKeyedDnbPcm({ key: "F#m", subHz: 55 });
    const result = dspAnalyzer.analyze(pcm);
    expect(result.musicalKey).toBe("F#m");
  });

  it("still reports F#m when the pad is detuned 30 cents flat", () => {
    const pcm = buildKeyedDnbPcm({ key: "F#m", detuneCents: -30 });
    const result = dspAnalyzer.analyze(pcm);
    expect(result.musicalKey).toBe("F#m");
  });

  it("tracks 174 BPM clicks with sub-hop accuracy", () => {
    const pcm = buildClickTrackPcm({
      bpm: 174,
      durationMs: 12_000,
      sampleRateHz: 22_050,
      offsetMs: 100,
    });
    const result = dspAnalyzer.analyze(pcm);
    expect(result.gridRejected).toBe(false);
    expect(Math.abs((result.bpm ?? 0) - 174)).toBeLessThan(0.5);
    expect(result.bpmConfidence ?? 0).toBeGreaterThanOrEqual(0.7);
    const period = 60_000 / 174;
    const errors = result.beatTimesMs.map((time) => {
      const k = Math.round((time - 100) / period);
      return Math.abs(time - (100 + k * period));
    });
    expect(median(errors)).toBeLessThan(3);
  });

  it("rejects a constant sine rather than inventing a DnB grid", () => {
    const samples = new Float32Array(22_050 * 4);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / 22_050);
    }
    const result = dspAnalyzer.analyze({
      samples,
      sampleRateHz: 22_050,
      durationMs: 4000,
      channels: 1,
    });
    expect(result.gridRejected).toBe(true);
    expect(result.bpmConfidence).not.toBe(0.55);
  });

  it("rejects unstructured noise rather than inventing a grid", () => {
    const samples = new Float32Array(22_050 * 4);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = ((i * 1103515245 + 12345) >>> 16) / 32768 - 1;
    }
    const result = dspAnalyzer.analyze({
      samples,
      sampleRateHz: 22_050,
      durationMs: 4000,
      channels: 1,
    });
    expect(result.gridRejected || (result.bpmConfidence ?? 0) < 0.6).toBe(true);
    expect(result.bpmConfidence).not.toBe(0.55);
  });

  it("records audioEndMs before appended digital silence and keeps cues out of it", () => {
    const pcm = buildSyntheticDnbPcm({ bpm: 174 });
    const silenceMs = 6000;
    const extra = Math.round((pcm.sampleRateHz * silenceMs) / 1000);
    const samples = new Float32Array(pcm.samples.length + extra);
    samples.set(pcm.samples);
    const padded = {
      ...pcm,
      samples,
      durationMs: pcm.durationMs + silenceMs,
    };
    const result = dspAnalyzer.analyze(padded);
    expect(result.descriptors?.audioEndMs).toBeDefined();
    let trueEndMs = 0;
    for (let i = pcm.samples.length - 1; i >= 0; i -= 1) {
      if (Math.abs(pcm.samples[i] ?? 0) >= 1e-6) {
        trueEndMs = (i / pcm.sampleRateHz) * 1000;
        break;
      }
    }
    expect(Math.abs((result.descriptors?.audioEndMs ?? 0) - trueEndMs)).toBeLessThan(100);
    expect(result.sections.at(-1)?.endMs ?? 0).toBeLessThanOrEqual(
      (result.descriptors?.audioEndMs ?? 0) + 1,
    );
    for (const cue of result.suggestedCues) {
      expect(cue.positionMs).toBeLessThanOrEqual((result.descriptors?.audioEndMs ?? 0) + 50);
    }
  });

  it("accepts a reference grid when the free estimate is rejected", () => {
    const full = buildClickTrackPcm({ bpm: 174, durationMs: 12_000, sampleRateHz: 22_050 });
    const periodFrames = Math.round((full.sampleRateHz * 60) / 174);
    const samples = new Float32Array(full.samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const beat = Math.round(i / periodFrames);
      samples[i] = beat % 3 === 0 ? (full.samples[i] ?? 0) : 0;
    }
    const sparse = { ...full, samples };
    const free = dspAnalyzer.analyze(sparse);
    expect(free.gridRejected).toBe(true);
    const referenced = dspAnalyzer.analyze(sparse, { referenceBpm: 174 });
    expect(referenced.gridRejected).toBe(false);
    expect(referenced.gridSource).toBe("reference");
    expect(referenced.bpm).toBe(174);
    const period = 60_000 / 174;
    const errors = referenced.beatTimesMs.map((time) => {
      const k = Math.round(time / period);
      return Math.abs(time - k * period);
    });
    expect(median(errors)).toBeLessThan(5);
  });

  it("rejects a reference tempo that does not fit the onsets", () => {
    const pcm = buildSyntheticDnbPcm({ bpm: 174 });
    const result = dspAnalyzer.analyze(pcm, { referenceBpm: 150 });
    expect(result.gridRejected).toBe(true);
    expect(result.gridRejectionReason ?? "").toMatch(/Reference tempo 150 does not fit/i);
    expect(result.bpm).toBeNull();
  });

  it("keeps a free 175 grid as analyzed against published 176", () => {
    const pcm = buildClickTrackPcm({ bpm: 175, durationMs: 12_000, sampleRateHz: 22_050 });
    const result = dspAnalyzer.analyze(pcm, { referenceBpm: 176 });
    expect(result.gridRejected).toBe(false);
    expect(result.gridSource).toBe("analyzed");
    expect(Math.abs((result.bpm ?? 0) - 175)).toBeLessThan(0.5);
  });

  it("rejects a 124-kick / 186-hat 3:2 confusion instead of accepting 186", () => {
    const pcm = buildOffbeatHatPcm();
    const result = dspAnalyzer.analyze(pcm);
    expect(result.gridRejected).toBe(true);
    expect(result.bpm).toBeNull();
    expect(result.bpmRaw).not.toBeNull();
    const raw = result.bpmRaw ?? 0;
    const near124 = Math.abs(raw - 124) < 8 || Math.abs(raw * (2 / 3) - 124) < 8 || Math.abs(raw * (3 / 2) - 124) < 8;
    expect(near124).toBe(true);
    expect(result.bpm === 186 || Math.abs((result.bpm ?? 0) - 186) < 1).toBe(false);
  });

  it("keeps a free-accepted 186 click track as analyzed", () => {
    const pcm = buildClickTrackPcm({ bpm: 186, durationMs: 12_000, sampleRateHz: 22_050 });
    const result = dspAnalyzer.analyze(pcm);
    expect(result.gridRejected).toBe(false);
    expect(result.gridSource).toBe("analyzed");
    expect(Math.abs((result.bpm ?? 0) - 186)).toBeLessThan(0.5);
  });

  it("exposes a bpmHint on a rejected in-range fixture and not below 0.3", () => {
    const pcm = buildSyntheticDnbPcm({ bpm: 174 });
    const rejected = dspAnalyzer.analyze(pcm, { referenceBpm: 150 });
    expect(rejected.gridRejected).toBe(true);
    const hint = resolveBpmHint(rejected);
    expect(hint.bpm).not.toBeNull();
    expect(Math.abs((hint.bpm ?? 0) - 174)).toBeLessThan(1);
    expect(hint.confidence ?? 0).toBeGreaterThanOrEqual(0.3);

    const samples = new Float32Array(22_050 * 4);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / 22_050);
    }
    const sine = dspAnalyzer.analyze({
      samples,
      sampleRateHz: 22_050,
      durationMs: 4000,
      channels: 1,
    });
    expect(sine.gridRejected).toBe(true);
    expect(resolveBpmHint(sine).bpm).toBeNull();
  });

  it("keeps a free-accepted click track as analyzed", () => {
    const pcm = buildClickTrackPcm({ bpm: 174, durationMs: 12_000, sampleRateHz: 22_050 });
    const result = dspAnalyzer.analyze(pcm);
    expect(result.gridRejected).toBe(false);
    expect(result.gridSource).toBe("analyzed");
  });

  it("recovers a 2-beat downbeat offset with high confidence", () => {
    const pcm = buildSyntheticDnbPcm({ bpm: 174, downbeatOffsetBeats: 2 });
    const result = dspAnalyzer.analyze(pcm);
    const beatMs = 60_000 / 174;
    expect(result.gridRejected).toBe(false);
    expect(Math.abs((result.downbeatTimesMs[0] ?? 0) - 2 * beatMs)).toBeLessThan(10);
    expect(result.downbeatConfidence ?? 0).toBeGreaterThanOrEqual(0.9);
  });

  it("resolves 8-beat ambiguity to the accented bar 1", () => {
    const pcm = buildSyntheticDnbPcm({ bpm: 174, barAccentEvery: 2 });
    const result = dspAnalyzer.analyze(pcm);
    const firstDown = result.downbeatTimesMs[0] ?? 99;
    expect(firstDown).toBeLessThan(10);
    expect(result.downbeatConfidence ?? 0).toBeGreaterThanOrEqual(0.9);
    const bars = result.descriptors?.bars;
    expect(bars).toBeTruthy();
    expect(bars?.rms.length).toBeGreaterThan(8);
    expect(bars?.rms.length).toBe(bars?.sub.length);
    expect(bars?.rms.length).toBe(bars?.midFlux.length);
    expect(bars?.rms.length).toBe(bars?.onsetDensity.length);
  });

  it("does not trim a 4s musical fade-out", () => {
    const pcm = buildSyntheticDnbPcm({ bpm: 174 });
    const fadeMs = 4000;
    const fadeSamples = Math.round((pcm.sampleRateHz * fadeMs) / 1000);
    const start = Math.max(0, pcm.samples.length - fadeSamples);
    const faded = pcm.samples.slice();
    for (let i = start; i < faded.length; i += 1) {
      const t = (i - start) / Math.max(1, faded.length - start);
      faded[i] = (faded[i] ?? 0) * (1 - t);
    }
    const result = dspAnalyzer.analyze({
      ...pcm,
      samples: faded,
    });
    expect(result.descriptors?.audioEndMs ?? 0).toBeGreaterThan(pcm.durationMs - 200);
  });
});
