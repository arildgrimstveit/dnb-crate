import { describe, expect, it } from "vitest";

import { downbeatAlignmentOffsetMs, wrapDelta } from "../src/downbeat-align.ts";

describe("downbeat alignment", () => {
  it("wraps deltas into ±half-period", () => {
    expect(wrapDelta(10, 100)).toBe(10);
    expect(wrapDelta(90, 100)).toBe(-10);
  });

  it("returns the phase difference at overlap start", () => {
    const offset = downbeatAlignmentOffsetMs({
      outgoingDownbeatsMs: [0, 1379, 2758],
      incomingDownbeatsMs: [20, 1399, 2778],
      outgoingOverlapStartMs: 1379,
      incomingOverlapStartMs: 0,
      bpm: 174,
    });
    expect(offset).toBeGreaterThan(0);
    expect(Math.abs(offset - 20)).toBeLessThan(5);
  });

  it("converts phases to output time before wrapping when rates differ", () => {
    const outgoingRate = 1.02;
    const incomingRate = 0.99;
    const targetBpm = 174;
    const period = 60_000 / targetBpm;
    const offset = downbeatAlignmentOffsetMs({
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
    expect(Math.abs(offset - expected)).toBeLessThan(1);
    expect(Math.abs(offset)).toBeLessThanOrEqual(period / 2 + 1);
    expect(Math.sign(offset)).toBe(Math.sign(expected) || 0);
  });
});
