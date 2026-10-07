import { describe, expect, it } from "vitest";

import { dspAnalyzer } from "../src/dsp-analyzer.ts";
import { publishedReferenceCandidates, resolveBpmHint } from "@dnb-crate/domain";

import {
  buildChordPcm,
  buildKeyedDnbPcm,
  buildOffbeatHatPcm,
  buildPadOnlyPcm,
  buildSyntheticDnbPcm,
} from "../src/synthetic-dnb.ts";
import { buildClickTrackPcm } from "../src/click-track.ts";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function noisyClicks(gain: number) {
  const full = buildClickTrackPcm({ bpm: 174, durationMs: 12_000, sampleRateHz: 22_050 });
  const samples = new Float32Array(full.samples);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = (samples[i] ?? 0) + (((i * 1_103_515_245 + 12_345) >>> 16) / 32_768 - 0.5) * gain;
  }
  return { ...full, samples };
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
    expect(result.descriptors?.bars?.beatKick?.length).toBe(result.beatTimesMs.length);
    expect(result.descriptors?.bars?.beatSnare?.length).toBe(result.beatTimesMs.length);
    expect((result.descriptors?.bars?.beatKick?.length ?? 0) / 4).toBeCloseTo(
      result.descriptors?.bars?.rms.length ?? 0,
      0,
    );
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
    expect(Math.abs((firstDrop?.startMs ?? 0) - pcm.expected.dropMs)).toBeLessThan(
      (4 * 60_000) / 174,
    );
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

  it("starts the intro section at the first audible sample, not inside lead-in silence", () => {
    const pcm = buildSyntheticDnbPcm({ bpm: 174 });
    const leadMs = 3000;
    const extra = Math.round((pcm.sampleRateHz * leadMs) / 1000);
    const samples = new Float32Array(extra + pcm.samples.length);
    samples.set(pcm.samples, extra);
    const padded = {
      ...pcm,
      samples,
      durationMs: pcm.durationMs + leadMs,
    };
    const result = dspAnalyzer.analyze(padded);
    const audioStart = result.descriptors?.audioStartMs ?? 0;
    expect(audioStart).toBeGreaterThan(leadMs - 150);
    const intro = result.sections.find((section) => section.type === "intro");
    expect(intro).toBeDefined();
    expect(Math.abs((intro?.startMs ?? 0) - audioStart)).toBeLessThanOrEqual(1);
    const introCue = result.suggestedCues.find((cue) => cue.type === "intro_start");
    expect(introCue).toBeDefined();
    expect(Math.abs((introCue?.positionMs ?? -1) - audioStart)).toBeLessThanOrEqual(1);
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

  it("rejects a reference tempo that does not fit when the free grid already failed", () => {
    const full = buildClickTrackPcm({ bpm: 174, durationMs: 12_000, sampleRateHz: 22_050 });
    const periodFrames = Math.round((full.sampleRateHz * 60) / 174);
    const samples = new Float32Array(full.samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const beat = Math.round(i / periodFrames);
      samples[i] = beat % 3 === 0 ? (full.samples[i] ?? 0) : 0;
    }
    const sparse = { ...full, samples };
    expect(dspAnalyzer.analyze(sparse).gridRejected).toBe(true);
    const result = dspAnalyzer.analyze(sparse, { referenceBpm: 150 });
    expect(result.gridRejected).toBe(true);
    expect(result.gridRejectionReason ?? "").toMatch(
      /Reference tempo 150(→\d+(\.\d+)?)? does not fit/i,
    );
    expect(result.bpm).toBeNull();
  });

  it("folds a half-time published 87 lock onto 174 clicks", () => {
    const pcm = buildClickTrackPcm({ bpm: 174, durationMs: 12_000, sampleRateHz: 22_050 });
    const result = dspAnalyzer.analyze(pcm, { referenceBpm: 87 });
    expect(result.gridRejected).toBe(false);
    expect(result.gridSource).toBe("analyzed");
    expect(Math.abs((result.bpm ?? 0) - 174)).toBeLessThan(0.5);
  });

  it("keeps a passing free 174 grid when published 150 does not fit", () => {
    const pcm = buildClickTrackPcm({ bpm: 174, durationMs: 12_000, sampleRateHz: 22_050 });
    const result = dspAnalyzer.analyze(pcm, { referenceBpm: 150 });
    expect(result.gridRejected).toBe(false);
    expect(result.gridSource).toBe("analyzed");
    expect(Math.abs((result.bpm ?? 0) - 174)).toBeLessThan(0.5);
  });

  it("rescues a near-miss 174 free grid when published 174 agrees", () => {
    const pcm = noisyClicks(1.2);
    const free = dspAnalyzer.analyze(pcm);
    expect(free.gridRejected).toBe(true);
    expect(free.bpmConfidence ?? 0).toBeGreaterThanOrEqual(0.45);
    expect(free.bpmConfidence ?? 0).toBeLessThan(0.6);
    const rescued = dspAnalyzer.analyze(pcm, { referenceBpm: 174 });
    expect(rescued.gridRejected).toBe(false);
    expect(rescued.gridSource).toBe("analyzed");
    expect(Math.abs((rescued.bpm ?? 0) - 174)).toBeLessThan(0.5);
    expect(rescued.bpmConfidence ?? 0).toBeGreaterThanOrEqual(0.6);
  });

  it("rescues a near-miss 174 free grid when published 140 folds to 175", () => {
    const pcm = noisyClicks(1.2);
    const rescued = dspAnalyzer.analyze(pcm, { referenceBpm: 140 });
    expect(rescued.gridRejected).toBe(false);
    expect(rescued.gridSource).toBe("analyzed");
    expect(Math.abs((rescued.bpm ?? 0) - 174)).toBeLessThan(0.5);
  });

  it("does not rescue a near-miss 174 free grid when published 150 does not fold nearby", () => {
    const pcm = noisyClicks(1.2);
    const result = dspAnalyzer.analyze(pcm, { referenceBpm: 150 });
    expect(result.gridRejected).toBe(true);
    expect(result.bpm).toBeNull();
  });

  it("does not accept a 3:2 hat confusion just because published says 186", () => {
    const pcm = buildOffbeatHatPcm();
    const result = dspAnalyzer.analyze(pcm, { referenceBpm: 186 });
    expect(result.gridRejected).toBe(true);
    expect(result.bpm === 186 || Math.abs((result.bpm ?? 0) - 186) < 1).toBe(false);
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
    const near124 =
      Math.abs(raw - 124) < 8 ||
      Math.abs(raw * (2 / 3) - 124) < 8 ||
      Math.abs(raw * (3 / 2) - 124) < 8;
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
    const full = buildClickTrackPcm({ bpm: 174, durationMs: 12_000, sampleRateHz: 22_050 });
    const samples = new Float32Array(full.samples);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = (samples[i] ?? 0) + (((i * 1_103_515_245 + 12_345) >>> 16) / 32_768 - 0.5) * 1.3;
    }
    const rejected = dspAnalyzer.analyze({ ...full, samples });
    expect(rejected.gridRejected).toBe(true);
    const hint = resolveBpmHint(rejected);
    expect(hint.bpm).not.toBeNull();
    expect(Math.abs((hint.bpm ?? 0) - 174)).toBeLessThan(1);
    expect(hint.confidence ?? 0).toBeGreaterThanOrEqual(0.3);

    const sineSamples = new Float32Array(22_050 * 4);
    for (let i = 0; i < sineSamples.length; i += 1) {
      sineSamples[i] = Math.sin((2 * Math.PI * 440 * i) / 22_050);
    }
    const sine = dspAnalyzer.analyze({
      samples: sineSamples,
      sampleRateHz: 22_050,
      durationMs: 4000,
      channels: 1,
    });
    expect(sine.gridRejected).toBe(true);
    expect(resolveBpmHint(sine).bpm).toBeNull();
    expect(sine.bpmConfidence ?? 0).toBeLessThan(0.45);
  });

  it("keeps a free-accepted click track as analyzed", () => {
    const pcm = buildClickTrackPcm({ bpm: 174, durationMs: 12_000, sampleRateHz: 22_050 });
    const result = dspAnalyzer.analyze(pcm);
    expect(result.gridRejected).toBe(false);
    expect(result.gridSource).toBe("analyzed");
  });

  it("folds a 7:5 published 126 reference onto a 175 grid", () => {
    const pcm = buildClickTrackPcm({ bpm: 175, durationMs: 12_000, sampleRateHz: 22_050 });
    const result = dspAnalyzer.analyze(pcm, { referenceBpm: 126 });
    expect(result.gridRejected).toBe(false);
    expect(Math.abs((result.bpm ?? 0) - 175)).toBeLessThan(1);
  });

  it("folds a 4:3 published 130 reference onto a 173 grid", () => {
    const pcm = buildClickTrackPcm({ bpm: 173, durationMs: 12_000, sampleRateHz: 22_050 });
    const result = dspAnalyzer.analyze(pcm, { referenceBpm: 130 });
    expect(result.gridRejected).toBe(false);
    expect(Math.abs((result.bpm ?? 0) - 173)).toBeLessThan(1);
  });

  it("publishedReferenceCandidates(126) includes 176.4 via 7:5", () => {
    const candidates = publishedReferenceCandidates(126);
    const septuple = candidates.find((value) => Math.abs(value - 176.4) < 0.1);
    expect(septuple).toBeDefined();
  });

  it("accepts a grid on a track with a long ambient intro (stability filter)", () => {
    // 128 intro bars ≈ 35 seconds of sub/pad with no drums, then clear drops.
    // The local windows over the intro produce noise-level tempo peaks that
    // used to pollute the MAD and collapse stability to ~0. The confidence
    // filter keeps them out; only the drop windows contribute.
    const pcm = buildSyntheticDnbPcm({
      bpm: 174,
      introBars: 128,
      dropBars: 32,
      breakdownBars: 32,
      drop2Bars: 32,
      outroBars: 32,
    });
    const result = dspAnalyzer.analyze(pcm);
    expect(result.gridRejected).toBe(false);
    expect(result.bpm).not.toBeNull();
    expect(Math.abs((result.bpm ?? 0) - 174)).toBeLessThan(1);
    expect(result.bpmConfidence ?? 0).toBeGreaterThanOrEqual(0.6);
    const evidence = result.descriptors?.tempoEvidence;
    expect(evidence?.stability ?? 0).toBeGreaterThanOrEqual(0.4);
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
    expect(bars?.rms.length).toBe(bars?.sub?.length);
    expect(bars?.rms.length).toBe(bars?.midFlux?.length);
    expect(bars?.rms.length).toBe(bars?.onsetDensity?.length);
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

  it("measures groove syncopation: straight two-step low, syncopated high", () => {
    // Straight: kick on 1, snare on 2/4 — backbone energy sits on the grid.
    const straight = dspAnalyzer.analyze(buildSyntheticDnbPcm({ bpm: 174 }));
    // Syncopated: extra kicks on the "a" of beats 2 and 4 (1.75 / 3.75
    // fractional beat positions) — the classic "boom bap boombap" DnB
    // backbone that gallops when blended with a straight groove.
    const syncopated = dspAnalyzer.analyze(
      buildSyntheticDnbPcm({ bpm: 174, extraKickOffbeats: [1.75, 3.75] }),
    );
    const straightSync = straight.descriptors?.grooveSyncopation ?? null;
    const syncopatedSync = syncopated.descriptors?.grooveSyncopation ?? null;
    expect(straightSync).not.toBeNull();
    expect(syncopatedSync).not.toBeNull();
    // The straight baseline is not ~0: the snare-band onset flux also
    // responds to off-beat 8th hats (measured baseline ≈ 0.37). Real-track
    // calibration matches: Somewhere (straight two-step) measures 0.44.
    expect(straightSync!).toBeLessThan(0.45);
    // The pair must clear the structural-conflict threshold (0.25): this
    // separation is what routes incompatible pairs to crossfade.
    expect(syncopatedSync! - straightSync!).toBeGreaterThan(0.25);
    // Backbeat concentration: snares sit on beats 2/4 in both fixtures.
    expect(straight.descriptors?.backbeatConcentration ?? 0).toBeGreaterThan(0.6);
    expect(syncopated.descriptors?.backbeatConcentration ?? 0).toBeGreaterThan(0.6);
    // Per-bar series: present and bar-aligned with the other series.
    const straightBarSync = straight.descriptors?.bars?.syncopation;
    const syncBarSync = syncopated.descriptors?.bars?.syncopation;
    expect(Array.isArray(straightBarSync)).toBe(true);
    expect(Array.isArray(syncBarSync)).toBe(true);
    expect(straightBarSync!.length).toBe(straight.descriptors?.bars?.rms.length);
    expect(syncBarSync!.length).toBe(syncopated.descriptors?.bars?.rms.length);
    // Locality: extra kicks land only in drop bars, so the syncopated
    // fixture's drop bars must exceed its intro bars, and its intro bars
    // must sit near the straight fixture's (which are uniformly low).
    const dropStartBar = 8; // default introBars
    const meanOf = (values: Array<number | null | undefined>): number => {
      const nums = values.filter((v): v is number => v != null);
      return nums.length === 0 ? NaN : nums.reduce((a, b) => a + b, 0) / nums.length;
    };
    const syncIntro = meanOf(syncBarSync!.slice(0, dropStartBar));
    const syncDrop = meanOf(syncBarSync!.slice(dropStartBar, dropStartBar + 16));
    const straightMean = meanOf(straightBarSync!);
    expect(syncDrop - syncIntro).toBeGreaterThan(0.15);
    expect(Math.abs(syncIntro - straightMean)).toBeLessThan(0.1);
  });

  it("locks a manual reference through 3:2 metrical ambiguity", () => {
    // The "Ghost" shape: a clean 174 backbone plus a loud triplet layer at
    // 116 (= 174 × 2/3). The free estimator leans toward the 116
    // periodicity, but a manual 174 reference must be able to lock — the
    // detected periodicity is the reference's exact metrical partner.
    const base = buildSyntheticDnbPcm({ bpm: 174 });
    const samples = base.samples.slice();
    const beatMs = 60_000 / 174;
    const triPeriod = Math.round((1.5 * beatMs * base.sampleRateHz) / 1000);
    const n = Math.round(0.05 * base.sampleRateHz);
    for (let at = 0; at < samples.length; at += triPeriod) {
      for (let j = 0; j < n && at + j < samples.length; j += 1) {
        const t = j / base.sampleRateHz;
        samples[at + j] =
          (samples[at + j] ?? 0) + Math.sin(2 * Math.PI * 220 * t) * Math.exp(-t * 30) * 0.9;
      }
    }
    const pcm = { ...base, samples };
    const locked = dspAnalyzer.analyze(pcm, { referenceBpm: 174 });
    expect(locked.gridRejected).toBe(false);
    expect(locked.bpm).not.toBeNull();
    expect(Math.abs((locked.bpm ?? 0) - 174)).toBeLessThan(1);
  });

  it("still rejects a reference that does not fit the onsets", () => {
    // Pad-only audio has no beat-grid content: a 174 reference cannot
    // produce a trustworthy grid, so it must stay rejected.
    const pcm = buildPadOnlyPcm({ key: "C", durationMs: 60_000 });
    const rejected = dspAnalyzer.analyze(pcm, { referenceBpm: 174 });
    expect(rejected.gridRejected).toBe(true);
    expect(rejected.bpm).toBeNull();
  });

  it("flags a drifting grid with gridPhaseSuspect and measures the error", () => {
    // First minute at exactly 174, second minute drifting to ~174.6: the
    // single fitted grid matches the first half and accumulates phase
    // error against the second — the WCHIA class.
    const sampleRateHz = 22_050;
    const totalMs = 120_000;
    const frameCount = Math.round((sampleRateHz * totalMs) / 1000);
    const samples = new Float32Array(frameCount);
    const clickFrames = Math.max(2, Math.round((sampleRateHz * 6) / 1000));
    let tMs = 0;
    let beatIndex = 0;
    while (tMs < totalMs) {
      const drift = 1 + (Math.max(0, tMs - 60_000) / 60_000) * 0.008; // up to +0.8%
      const beatMs = (60_000 / 174) * drift;
      const start = Math.round((tMs / 1000) * sampleRateHz);
      for (let i = 0; i < clickFrames && start + i < frameCount; i += 1) {
        samples[start + i] =
          Math.sin((2 * Math.PI * 2000 * i) / sampleRateHz) * (1 - i / clickFrames);
      }
      tMs += beatMs;
      beatIndex += 1;
    }
    expect(beatIndex).toBeGreaterThan(300);
    const result = dspAnalyzer.analyze({ samples, sampleRateHz, durationMs: totalMs, channels: 1 });
    expect(result.gridRejected).toBe(false);
    const maxErr = result.descriptors?.gridPhaseMaxErrorMs ?? 0;
    expect(maxErr).toBeGreaterThan(60);
    expect(result.descriptors?.gridPhaseSuspect).toBe(true);
  });

  it("records triplet content in the beat-phase histogram", () => {
    // The Ghost shape: straight 174 backbone plus a loud triplet layer at
    // 116 (= 174 × 2/3). The histogram must show substantial energy at the
    // ⅓/⅔ beat positions, not only on the beat.
    const base = buildSyntheticDnbPcm({ bpm: 174 });
    const samples = base.samples.slice();
    const beatMs = 60_000 / 174;
    // Triplet layer: a pulse every 2/3 beat cycles phases 0, 2/3, 1/3 —
    // the classic triplet chop placement (period 230 ms at 174).
    const triPeriod = Math.round(((2 / 3) * beatMs * base.sampleRateHz) / 1000);
    const n = Math.round(0.03 * base.sampleRateHz);
    for (let at = 0; at < samples.length; at += triPeriod) {
      for (let j = 0; j < n && at + j < samples.length; j += 1) {
        const t = j / base.sampleRateHz;
        samples[at + j] =
          (samples[at + j] ?? 0) + Math.sin(2 * Math.PI * 220 * t) * Math.exp(-t * 30) * 0.9;
      }
    }
    const result = dspAnalyzer.analyze({ ...base, samples }, { referenceBpm: 174 });
    const hist = result.descriptors?.beatPhaseHistogram;
    expect(Array.isArray(hist)).toBe(true);
    expect(hist!.length).toBe(20);
    const onBeat = hist![0] ?? 0;
    const third = Math.max(hist![6] ?? 0, hist![7] ?? 0);
    const twoThirds = Math.max(hist![13] ?? 0, hist![14] ?? 0);
    // Triplet zones must carry real energy (not just the on-beat peak).
    expect(Math.max(third, twoThirds)).toBeGreaterThan(0.3);
    expect(onBeat).toBeGreaterThan(0.3);
  });
});
