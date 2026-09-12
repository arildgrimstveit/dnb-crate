import { describe, expect, it } from "vitest";

import {
  applyAlignmentOffset,
  downbeatAlignmentOffsetMs,
  planAlignmentOffsetMs,
  wrapDelta,
} from "../src/downbeat-align.ts";

describe("downbeat alignment", () => {
  it("wraps deltas into ±half-period", () => {
    expect(wrapDelta(10, 100)).toBe(10);
    expect(wrapDelta(90, 100)).toBe(-10);
  });

  it("returns the phase difference at overlap start", () => {
    const aligned = downbeatAlignmentOffsetMs({
      outgoingDownbeatsMs: [0, 1379, 2758],
      incomingDownbeatsMs: [20, 1399, 2778],
      outgoingOverlapStartMs: 1379,
      incomingOverlapStartMs: 0,
      bpm: 174,
    });
    expect(aligned.mode).toBe("beat");
    expect(aligned.offsetMs).toBeGreaterThan(0);
    expect(Math.abs(aligned.offsetMs - 20)).toBeLessThan(5);
  });

  it("converts phases to output time before wrapping when rates differ", () => {
    const outgoingRate = 1.02;
    const incomingRate = 0.99;
    const targetBpm = 174;
    const period = 60_000 / targetBpm;
    const aligned = downbeatAlignmentOffsetMs({
      outgoingDownbeatsMs: [0, 1379, 2758],
      incomingDownbeatsMs: [50, 1429, 2808],
      outgoingOverlapStartMs: 1379,
      incomingOverlapStartMs: 0,
      bpm: 174,
      outgoingRate,
      incomingRate,
      targetBpm,
    });
    const outPhase = 0 / outgoingRate;
    const inPhase = 50 / incomingRate;
    const expected = wrapDelta(inPhase - outPhase, period) * incomingRate;
    expect(aligned.mode).toBe("beat");
    expect(Math.abs(aligned.offsetMs - expected)).toBeLessThan(1);
    expect(Math.abs(aligned.offsetMs)).toBeLessThanOrEqual(period / 2 + 1);
    expect(Math.sign(aligned.offsetMs)).toBe(Math.sign(expected) || 0);
  });

  it("keeps a 2-beat downbeat difference in bar mode", () => {
    const beatMs = 60_000 / 174;
    const barMs = beatMs * 4;
    const twoBeats = beatMs * 2;
    const aligned = downbeatAlignmentOffsetMs({
      outgoingDownbeatsMs: [0, barMs, barMs * 2],
      incomingDownbeatsMs: [twoBeats, twoBeats + barMs, twoBeats + barMs * 2],
      outgoingOverlapStartMs: 0,
      incomingOverlapStartMs: 0,
      bpm: 174,
      targetBpm: 174,
      outgoingDownbeatConfidence: 0.7,
      incomingDownbeatConfidence: 0.7,
    });
    expect(aligned.mode).toBe("bar");
    expect(aligned.periodMs).toBeCloseTo(barMs, 5);
    expect(Math.abs(Math.abs(aligned.offsetMs) - twoBeats)).toBeLessThan(5);
  });

  it("still wraps a 2-beat difference to 0 in beat mode", () => {
    const beatMs = 60_000 / 174;
    const barMs = beatMs * 4;
    const twoBeats = beatMs * 2;
    const aligned = downbeatAlignmentOffsetMs({
      outgoingDownbeatsMs: [0, barMs, barMs * 2],
      incomingDownbeatsMs: [twoBeats, twoBeats + barMs, twoBeats + barMs * 2],
      outgoingOverlapStartMs: 0,
      incomingOverlapStartMs: 0,
      bpm: 174,
      targetBpm: 174,
    });
    expect(aligned.mode).toBe("beat");
    expect(Math.abs(aligned.offsetMs)).toBeLessThan(5);
  });

  it("keeps |offset| within half a bar when rates are 1.02/0.99", () => {
    const outgoingRate = 1.02;
    const incomingRate = 0.99;
    const barMs = (4 * 60_000) / 174;
    const aligned = downbeatAlignmentOffsetMs({
      outgoingDownbeatsMs: [0, 1379, 2758],
      incomingDownbeatsMs: [50, 1429, 2808],
      outgoingOverlapStartMs: 1379,
      incomingOverlapStartMs: 0,
      bpm: 174,
      outgoingRate,
      incomingRate,
      targetBpm: 174,
      outgoingDownbeatConfidence: 0.8,
      incomingDownbeatConfidence: 0.8,
    });
    expect(aligned.mode).toBe("bar");
    expect(Math.abs(aligned.offsetMs)).toBeLessThanOrEqual(barMs / 2 + 1);
  });

  it("shifts the outgoing end instead of adding a period at source start 0", () => {
    const barMs = (4 * 60_000) / 174;
    const applied = applyAlignmentOffset({
      incomingStartMs: 0,
      incomingEndMs: 180_000,
      outgoingEndMs: 180_000,
      offsetMs: -20,
      periodMs: barMs,
      incomingRate: 1,
      outgoingRate: 1,
    });
    expect(applied.incomingStartMs).toBe(0);
    expect(applied.outgoingEndMs).toBe(180_020);
    expect(applied.appliedOffsetMs).toBe(-20);
    expect(Math.abs(applied.appliedOffsetMs)).not.toBeCloseTo(barMs, 0);
  });

  it("shifts the outgoing end when a period nudge would pass the incoming tail", () => {
    const applied = applyAlignmentOffset({
      incomingStartMs: 0,
      incomingEndMs: 1500,
      outgoingEndMs: 180_000,
      offsetMs: -20,
      periodMs: 1379,
      incomingRate: 1,
      outgoingRate: 1,
    });
    expect(applied.incomingStartMs).toBe(0);
    expect(applied.outgoingEndMs).toBe(180_020);
  });

  it("falls back from a multi-second phrase wrap to bar", () => {
    const beatMs = 60_000 / 174;
    const barMs = beatMs * 4;
    const phase = 2752;
    const aligned = planAlignmentOffsetMs({
      outgoingDownbeatsMs: [0, barMs, barMs * 2],
      incomingDownbeatsMs: [phase, phase + barMs, phase + barMs * 2],
      outgoingOverlapStartMs: 0,
      incomingOverlapStartMs: 0,
      bpm: 174,
      targetBpm: 174,
      outgoingPhraseOriginMs: 0,
      incomingPhraseOriginMs: phase,
      outgoingDownbeatConfidence: 1,
      incomingDownbeatConfidence: 1,
    });
    expect(aligned.mode).toBe("bar");
    expect(Math.abs(aligned.offsetMs)).toBeLessThan(beatMs / 2);
  });

  it("keeps a 360 ms bar residual instead of an 11 s phrase wrap", () => {
    const beatMs = 60_000 / 174;
    const barMs = beatMs * 4;
    const phase = 360;
    const aligned = planAlignmentOffsetMs({
      outgoingDownbeatsMs: [0, barMs, barMs * 2],
      incomingDownbeatsMs: [phase, phase + barMs, phase + barMs * 2],
      outgoingOverlapStartMs: 0,
      incomingOverlapStartMs: 0,
      bpm: 174,
      targetBpm: 174,
      outgoingPhraseOriginMs: 0,
      incomingPhraseOriginMs: phase,
      outgoingDownbeatConfidence: 1,
      incomingDownbeatConfidence: 1,
    });
    expect(aligned.mode).toBe("phrase");
    expect(Math.abs(aligned.offsetMs - phase)).toBeLessThan(5);
  });

  it("moves overlap start when outgoing-end fallback corrects phase", () => {
    const overlapMs = 8_000;
    const outgoingEndMs = 180_000;
    const applied = applyAlignmentOffset({
      incomingStartMs: 0,
      incomingEndMs: 180_000,
      outgoingEndMs,
      offsetMs: -20,
      periodMs: 1379,
      incomingRate: 1,
      outgoingRate: 1,
      overlapMs,
    });
    expect(applied.movedOutgoingEnd).toBe(true);
    expect(applied.incomingStartMs).toBe(0);
    expect(applied.outgoingEndMs).toBe(180_020);
    expect(applied.overlapMs).toBe(8_000);
    const oldStart = outgoingEndMs - overlapMs;
    const newStart = applied.outgoingEndMs - (applied.overlapMs ?? 0);
    expect(newStart).toBe(oldStart + 20);
  });

  it("compares source phrase periods at unequal rates in output time", () => {
    const phraseMs = 32 * 60_000 / 174;
    const aligned = downbeatAlignmentOffsetMs({
      outgoingDownbeatsMs: [0], incomingDownbeatsMs: [0],
      outgoingOverlapStartMs: phraseMs * 10,
      incomingOverlapStartMs: phraseMs * 10 * 1.02,
      outgoingRate: 1, incomingRate: 1.02, bpm: 174,
      outgoingPhraseOriginMs: 0, incomingPhraseOriginMs: 0,
    });
    expect(aligned.offsetMs).toBe(0);
  });

  it("converts incoming-source correction before moving the outgoing source", () => {
    const applied = applyAlignmentOffset({
      incomingStartMs: 0, incomingEndMs: 180_000,
      outgoingEndMs: 150_000, offsetMs: -102, periodMs: 1379,
      incomingRate: 1.02, outgoingRate: 0.98, overlapMs: 8000,
    });
    expect(applied.outgoingEndMs).toBe(150_098);
    expect(applied.overlapMs).toBe(8000);
  });
});
