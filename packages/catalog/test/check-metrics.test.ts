import { describe, expect, it } from "vitest";

import {
  alignmentResidualMs,
  evaluateDurationError,
  firstDropMs,
  fullRenderDurationFailure,
  freezeJoinEvidence,
  joinCamelotDistance,
  plannedLevelStepLu,
  storedGridFromEvidence,
  storedGridResidualMs,
} from "../src/render/check-metrics.ts";

describe("render:check v2 metrics", () => {
  it("reports a one-beat applied nudge as residual", () => {
    const beats = Array.from({ length: 32 }, (_, i) => i * 345);
    const residual = alignmentResidualMs(343, beats, beats, 200_000, 343, 1, 1, 345);
    expect(residual).toBe(343);
  });

  it("judges a deliberate lock slip by cross-correlation, not the period tripwire", () => {
    const outgoing = Array.from({ length: 64 }, (_, i) => 200_000 + i * 345);
    const incoming = Array.from({ length: 64 }, (_, i) => i * 345);
    // A +4-beat lock slip lands one bar period away: without drum evidence the
    // tripwire reports it, with onsetLockBeats it judges the grids instead.
    expect(storedGridResidualMs(1380, outgoing, incoming, 200_000, 0, 1, 1, 1380)).toBe(1380);
    const residual = storedGridResidualMs(1380, outgoing, incoming, 200_000, 0, 1, 1, 1380, 4);
    expect(residual).not.toBe(1380);
    expect(Math.abs(residual ?? 99)).toBeLessThan(20);
  });

  it("passes onset-lock attribution through the frozen-evidence check", () => {
    const outBeats = Array.from({ length: 64 }, (_, i) => 200_000 + i * 345);
    const inBeats = Array.from({ length: 64 }, (_, i) => 343 + i * 345);
    const frozen = freezeJoinEvidence({
      outgoingTrackId: "out",
      incomingTrackId: "in",
      outgoingAnalysisVersion: "3.2.0",
      incomingAnalysisVersion: "3.2.0",
      outgoingBeatsMs: outBeats,
      incomingBeatsMs: inBeats,
      outgoingSourceStartMs: 200_000,
      outgoingSourceEndMs: 220_000,
      incomingSourceStartMs: 343,
      incomingSourceEndMs: 20_343,
      outgoingCamelotKey: "8A",
      incomingCamelotKey: "8A",
      outgoingAudioEndMs: 240_000,
      outgoingTailEnergy: 0.4,
      incomingHeadEnergy: 0.3,
      incomingDropMs: 8_000,
      recipeVersion: 1,
      intent: null,
    });
    const tripped = storedGridFromEvidence(frozen, 200_000, 343, 1, 1, 343, 345);
    expect(tripped.residualMs).toBe(343);
    const locked = storedGridFromEvidence(frozen, 200_000, 343, 1, 1, 343, 345, 1);
    expect(locked.residualMs).not.toBe(343);
    expect(Math.abs(locked.residualMs ?? 99)).toBeLessThan(20);
  });

  it("does not treat a phrase-mode 360ms nudge as a one-beat residual", () => {
    const outgoing = Array.from({ length: 64 }, (_, i) => 200_000 + i * 345);
    const incoming = Array.from({ length: 64 }, (_, i) => 360 + i * 345);
    const residual = alignmentResidualMs(360, outgoing, incoming, 200_000, 360, 1, 1, 10_971);
    expect(Math.abs(residual ?? 99)).toBeLessThan(20);
  });

  it("does not treat a bar-mode locked grid as a one-beat residual", () => {
    const outgoing = Array.from({ length: 64 }, (_, i) => 265_024 + i * 345);
    const incoming = Array.from({ length: 64 }, (_, i) => 2 + i * 345);
    const residual = alignmentResidualMs(-5, outgoing, incoming, 265_024, 2, 1, 1, 1379);
    expect(Math.abs(residual ?? 99)).toBeLessThan(20);
  });

  it("does not report a phrase nudge as residual when beat grids are missing", () => {
    const residual = alignmentResidualMs(573, [], [], 175_855, 1110, 1, 1, 10_971);
    expect(residual).toBeNull();
  });

  it("uses grid cross-correlation when the applied nudge is small", () => {
    const outgoing = Array.from({ length: 32 }, (_, i) => 10_000 + i * 345);
    const incoming = Array.from({ length: 32 }, (_, i) => i * 345);
    const residual = alignmentResidualMs(0, outgoing, incoming, 10_000, 0, 1, 1, 345);
    expect(residual).not.toBeNull();
    expect(Math.abs(residual ?? 99)).toBeLessThan(20);
  });

  it("reports an 80ms grid slip when the off-zero peak is clearly better", () => {
    const outgoing = Array.from({ length: 32 }, (_, i) => 10_000 + i * 345);
    const incoming = Array.from({ length: 32 }, (_, i) => 80 + i * 345);
    const residual = alignmentResidualMs(0, outgoing, incoming, 10_000, 0, 1, 1, 345);
    expect(residual).toBe(80);
  });

  it("uses gain-corrected LUFS for the level-match gate", () => {
    expect(plannedLevelStepLu(-8, -12, -4, 0)).toBe(0);
    expect(plannedLevelStepLu(-7.7, -8.4, 0, 0.7)).toBe(0);
    expect(plannedLevelStepLu(null, -8, 0, 0)).toBeNull();
  });

  it("computes camelot distance and first drop", () => {
    expect(joinCamelotDistance("5A", "5B")).toBe(1);
    expect(joinCamelotDistance("5A", "6A")).toBe(1);
    expect(
      firstDropMs([
        { type: "intro", startMs: 0 },
        { type: "drop", startMs: 64_000 },
      ]),
    ).toBe(64_000);
  });

  it("does not compute a stored-grid residual without frozen beats", () => {
    expect(storedGridFromEvidence(undefined, 10_000, 0, 1, 1, 0, 345)).toEqual({
      residualMs: null,
      source: "missing",
      kind: "stored-grid-consistency",
    });
  });

  it("uses frozen beats and ignores a later catalog mutation", () => {
    const beats = Array.from({ length: 32 }, (_, i) => 10_000 + i * 345);
    const frozen = freezeJoinEvidence({
      outgoingTrackId: "out",
      incomingTrackId: "in",
      outgoingAnalysisVersion: "3.2.0",
      incomingAnalysisVersion: "3.2.0",
      outgoingBeatsMs: beats,
      incomingBeatsMs: Array.from({ length: 32 }, (_, i) => i * 345),
      outgoingSourceStartMs: 10_000,
      outgoingSourceEndMs: 30_000,
      incomingSourceStartMs: 0,
      incomingSourceEndMs: 20_000,
      outgoingCamelotKey: "8A",
      incomingCamelotKey: "8A",
      outgoingAudioEndMs: 40_000,
      outgoingTailEnergy: 0.4,
      incomingHeadEnergy: 0.3,
      incomingDropMs: 8_000,
      recipeVersion: 1,
      intent: null,
    });
    const liveBeats = beats.map((time) => time + 80);
    expect(frozen.outgoingBeatsMs.includes(10_000 + 80)).toBe(false);
    const residual = storedGridFromEvidence(frozen, 10_000, 0, 1, 1, 0, 345);
    expect(residual.source).toBe("frozen-manifest");
    expect(Math.abs(residual.residualMs ?? 99)).toBeLessThan(20);
    const mutated = storedGridFromEvidence(
      { ...frozen, outgoingBeatsMs: liveBeats },
      10_000,
      0,
      1,
      1,
      0,
      345,
    );
    expect(Math.abs(mutated.residualMs ?? 0)).toBe(80);
  });

  it("fails a full-hour duration error over 1 s and only warns a preview or short fixture", () => {
    expect(evaluateDurationError(3_513_513, 3_515_154, "full")).toEqual({
      errorMs: -1_641,
      status: "fail",
    });
    expect(evaluateDurationError(58_000, 60_000, "preview").status).toBe("warning");
    expect(evaluateDurationError(1_000, 90_000, "full").status).toBe("warning");
    expect(evaluateDurationError(3_515_400, 3_515_154, "full").status).toBe("pass");
  });

  it("treats any full-render miss over 1000 ms as a duration failure message", () => {
    expect(fullRenderDurationFailure(1_000, 15_000)).toMatch(/tolerance 1000ms/);
    expect(fullRenderDurationFailure(15_000, 15_400)).toBeNull();
  });
});
