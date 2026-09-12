import { describe, expect, it } from "vitest";

import {
  clickTrack,
  clipPcm,
  diagnoseOverlapAudio,
  expectedBeatsMs,
  fadePcm,
  insertSilence,
  mixPcm,
} from "../src/render/audio-diagnostics.ts";

const SR = 8_000;
const OVERLAP = 8_000;
const BPM = 174;

function alignedDecks(options: { incomingOffsetMs?: number; incomingBpm?: number; outgoingBpm?: number } = {}) {
  const outgoingBpm = options.outgoingBpm ?? BPM;
  const incomingBpm = options.incomingBpm ?? BPM;
  const incomingOffsetMs = options.incomingOffsetMs ?? 0;
  return {
    outgoingPcm: clickTrack({ sampleRate: SR, durationMs: OVERLAP, bpm: outgoingBpm }),
    incomingPcm: clickTrack({
      sampleRate: SR,
      durationMs: OVERLAP,
      bpm: incomingBpm,
      offsetMs: incomingOffsetMs,
    }),
    outgoingBeatsMs: expectedBeatsMs(OVERLAP, outgoingBpm),
    incomingBeatsMs: expectedBeatsMs(OVERLAP, incomingBpm, incomingOffsetMs),
  };
}

describe("independent overlap audio diagnostics", () => {
  it("passes aligned click decks and does not treat two kits as a truth oracle", () => {
    const decks = alignedDecks();
    const result = diagnoseOverlapAudio({
      sampleRate: SR,
      overlapMs: OVERLAP,
      ...decks,
    });
    expect(result.status).toBe("pass");
    expect(result.worstDeckResidualMs).not.toBeNull();
    expect(Math.abs(result.worstDeckResidualMs ?? 99)).toBeLessThan(20);
  });

  it("detects a 1-BPM mismatch by the end of the overlap", () => {
    const outgoing = clickTrack({ sampleRate: SR, durationMs: OVERLAP, bpm: 174 });
    const incoming = clickTrack({ sampleRate: SR, durationMs: OVERLAP, bpm: 175 });
    const result = diagnoseOverlapAudio({
      sampleRate: SR,
      overlapMs: OVERLAP,
      outgoingPcm: outgoing,
      incomingPcm: incoming,
      outgoingBeatsMs: expectedBeatsMs(OVERLAP, 174),
      incomingBeatsMs: expectedBeatsMs(OVERLAP, 174),
    });
    const end = result.incoming.regions.find((region) => region.region === "end");
    expect(end?.residualMs ?? 0).toBeGreaterThan(20);
    expect(result.status === "review" || result.status === "fail").toBe(true);
  });

  it("detects a skipped 174.3→174 stretch over a long overlap", () => {
    const durationMs = 32 * 4 * (60_000 / 174);
    const played = clickTrack({ sampleRate: SR, durationMs, bpm: 174.3 });
    const result = diagnoseOverlapAudio({
      sampleRate: SR,
      overlapMs: durationMs,
      outgoingPcm: played,
      incomingPcm: clickTrack({ sampleRate: SR, durationMs, bpm: 174 }),
      outgoingBeatsMs: expectedBeatsMs(durationMs, 174),
      incomingBeatsMs: expectedBeatsMs(durationMs, 174),
    });
    const end = result.outgoing.regions.find((region) => region.region === "end");
    expect(end?.residualMs ?? 0).toBeGreaterThan(40);
    expect(result.status === "review" || result.status === "fail").toBe(true);
  });

  it("detects a one-beat slip", () => {
    const decks = alignedDecks({ incomingOffsetMs: 60_000 / BPM });
    const result = diagnoseOverlapAudio({
      sampleRate: SR,
      overlapMs: OVERLAP,
      outgoingPcm: decks.outgoingPcm,
      incomingPcm: decks.incomingPcm,
      outgoingBeatsMs: decks.outgoingBeatsMs,
      incomingBeatsMs: expectedBeatsMs(OVERLAP, BPM),
    });
    expect(result.worstDeckResidualMs ?? 0).toBeGreaterThan(200);
    expect(result.status).toBe("fail");
  });

  it("detects a one-bar slip", () => {
    const decks = alignedDecks({ incomingOffsetMs: 4 * (60_000 / BPM) });
    const result = diagnoseOverlapAudio({
      sampleRate: SR,
      overlapMs: OVERLAP,
      outgoingPcm: decks.outgoingPcm,
      incomingPcm: decks.incomingPcm,
      outgoingBeatsMs: decks.outgoingBeatsMs,
      incomingBeatsMs: expectedBeatsMs(OVERLAP, BPM),
    });
    expect(result.worstDeckResidualMs ?? 0).toBeGreaterThan(200);
    expect(result.status).toBe("fail");
  });

  it("keeps dense aligned kit overlap as a pass", () => {
    const decks = alignedDecks();
    const result = diagnoseOverlapAudio({
      sampleRate: SR,
      overlapMs: OVERLAP,
      outgoingPcm: decks.outgoingPcm,
      incomingPcm: decks.incomingPcm,
      mixPcm: mixPcm(decks.outgoingPcm, decks.incomingPcm),
      outgoingBeatsMs: decks.outgoingBeatsMs,
      incomingBeatsMs: decks.incomingBeatsMs,
    });
    expect(result.status).toBe("pass");
  });

  it("flags a quiet hole unless it is a recorded breather", () => {
    const decks = alignedDecks();
    const holed = insertSilence(mixPcm(decks.outgoingPcm, decks.incomingPcm), SR, 3_000, 800);
    const accidental = diagnoseOverlapAudio({
      sampleRate: SR,
      overlapMs: OVERLAP,
      ...decks,
      mixPcm: holed,
    });
    expect(accidental.mix.bassAbsence).toBe("accidental");
    expect(accidental.status === "review" || accidental.status === "fail").toBe(true);
    const breather = diagnoseOverlapAudio({
      sampleRate: SR,
      overlapMs: OVERLAP,
      ...decks,
      mixPcm: holed,
      intent: "breather",
    });
    expect(breather.mix.bassAbsence).toBe("expected-breather");
    expect(breather.reasons.includes("overlap hole 800 ms") || breather.reasons.some((reason) => reason.includes("hole"))).toBe(
      false,
    );
  });

  it("detects a late incoming landing", () => {
    const decks = alignedDecks({ incomingOffsetMs: 2_000 });
    const result = diagnoseOverlapAudio({
      sampleRate: SR,
      overlapMs: OVERLAP,
      outgoingPcm: decks.outgoingPcm,
      incomingPcm: decks.incomingPcm,
      outgoingBeatsMs: decks.outgoingBeatsMs,
      incomingBeatsMs: expectedBeatsMs(OVERLAP, BPM),
    });
    expect(result.status).toBe("fail");
    expect(result.worstDeckResidualMs ?? 0).toBeGreaterThan(40);
  });

  it("flags clipped transients as distortion", () => {
    const decks = alignedDecks();
    const result = diagnoseOverlapAudio({
      sampleRate: SR,
      overlapMs: OVERLAP,
      outgoingPcm: clipPcm(decks.outgoingPcm, 0.15),
      incomingPcm: decks.incomingPcm,
      outgoingBeatsMs: decks.outgoingBeatsMs,
      incomingBeatsMs: decks.incomingBeatsMs,
    });
    expect(result.reasons.some((reason) => /distortion/.test(reason))).toBe(true);
    expect(result.status === "review" || result.status === "fail").toBe(true);
  });

  it("does not false-fail a liked slow complementary join", () => {
    const outgoing = clickTrack({ sampleRate: SR, durationMs: OVERLAP, bpm: BPM });
    const incoming = fadePcm(
      clickTrack({ sampleRate: SR, durationMs: OVERLAP, bpm: BPM, amplitude: 0.5 }),
      SR,
      0.05,
      1,
    );
    const result = diagnoseOverlapAudio({
      sampleRate: SR,
      overlapMs: OVERLAP,
      outgoingPcm: outgoing,
      incomingPcm: incoming,
      mixPcm: mixPcm(outgoing, incoming),
      outgoingBeatsMs: expectedBeatsMs(OVERLAP, BPM),
      incomingBeatsMs: expectedBeatsMs(OVERLAP, BPM),
      intent: "sustain",
    });
    expect(result.mix.bassAbsence).not.toBe("accidental");
    expect(result.status === "fail").toBe(false);
  });

  it("detects a skip/reset in the prefix", () => {
    const decks = alignedDecks();
    const sustained = new Float32Array(decks.outgoingPcm.length);
    for (let i = 0; i < sustained.length; i += 1) {
      sustained[i] = 0.25 * Math.sin((2 * Math.PI * 80 * i) / SR);
    }
    const stuttered = insertSilence(sustained, SR, 400, 80);
    const result = diagnoseOverlapAudio({
      sampleRate: SR,
      overlapMs: OVERLAP,
      outgoingPcm: stuttered,
      incomingPcm: fadePcm(decks.incomingPcm, SR, 0, 0.3),
      mixPcm: mixPcm(stuttered, fadePcm(decks.incomingPcm, SR, 0, 0.2)),
      outgoingBeatsMs: decks.outgoingBeatsMs,
      incomingBeatsMs: decks.incomingBeatsMs,
    });
    expect(result.mix.stutterScore).toBeGreaterThan(0.4);
    expect(result.status).toBe("fail");
    expect(result.reasons.some((reason) => /stutter/.test(reason))).toBe(true);
  });
});
