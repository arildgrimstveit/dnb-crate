import { describe, expect, it } from "vitest";

import {
  evaluateDurationError,
  firstDropMs,
  fullRenderDurationFailure,
  freezeJoinEvidence,
  joinCamelotDistance,
  placedIncomingOverlapStartMs,
  plannedLevelStepLu,
  storedGridFromEvidence,
  storedGridResidualMs,
} from "../src/render/check-metrics.ts";

describe("render:check v2 metrics", () => {
  it("treats a whole-beat offset as phase-equivalent when the grids align", () => {
    // The renderer shifts the incoming start by downbeatOffsetMs, so a
    // 343ms (one-beat) offset with coincident beat phases is aligned;
    // the beat-train correlation — not an offset tripwire — decides.
    const outgoing = Array.from({ length: 32 }, (_, i) => 200_000 + i * 345);
    const incoming = Array.from({ length: 32 }, (_, i) => 343 + i * 345);
    const residual = storedGridResidualMs(343, outgoing, incoming, 200_000, 343, 1, 1, 345);
    expect(Math.abs(residual ?? 99)).toBeLessThan(20);
  });

  it("judges a deliberate lock slip by cross-correlation, not the period tripwire", () => {
    const outgoing = Array.from({ length: 64 }, (_, i) => 200_000 + i * 345);
    const incoming = Array.from({ length: 64 }, (_, i) => i * 345);
    const residual = storedGridResidualMs(1380, outgoing, incoming, 200_000, 0, 1, 1, 1380, 4);
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
    const checked = storedGridFromEvidence(frozen, 200_000, 343, 1, 1, 343, 345, 1);
    expect(Math.abs(checked.residualMs ?? 99)).toBeLessThan(20);
  });

  it("does not treat a phrase-mode 360ms nudge as a one-beat residual", () => {
    const outgoing = Array.from({ length: 64 }, (_, i) => 200_000 + i * 345);
    const incoming = Array.from({ length: 64 }, (_, i) => 360 + i * 345);
    const residual = storedGridResidualMs(360, outgoing, incoming, 200_000, 360, 1, 1, 10_971);
    expect(Math.abs(residual ?? 99)).toBeLessThan(20);
  });

  it("does not treat a bar-mode locked grid as a one-beat residual", () => {
    const outgoing = Array.from({ length: 64 }, (_, i) => 265_024 + i * 345);
    const incoming = Array.from({ length: 64 }, (_, i) => 2 + i * 345);
    const residual = storedGridResidualMs(-5, outgoing, incoming, 265_024, 2, 1, 1, 1379);
    expect(Math.abs(residual ?? 99)).toBeLessThan(20);
  });

  it("does not report a phrase nudge as residual when beat grids are missing", () => {
    const residual = storedGridResidualMs(573, [], [], 175_855, 1110, 1, 1, 10_971);
    expect(residual).toBeNull();
  });

  it("uses grid cross-correlation when the applied nudge is small", () => {
    const outgoing = Array.from({ length: 32 }, (_, i) => 10_000 + i * 345);
    const incoming = Array.from({ length: 32 }, (_, i) => i * 345);
    const residual = storedGridResidualMs(0, outgoing, incoming, 10_000, 0, 1, 1, 345);
    expect(residual).not.toBeNull();
    expect(Math.abs(residual ?? 99)).toBeLessThan(20);
  });

  it("reports an 80ms grid slip when the off-zero peak is clearly better", () => {
    const outgoing = Array.from({ length: 32 }, (_, i) => 10_000 + i * 345);
    const incoming = Array.from({ length: 32 }, (_, i) => 80 + i * 345);
    const residual = storedGridResidualMs(0, outgoing, incoming, 10_000, 0, 1, 1, 345);
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

describe("checker projects stored grids from placed manifest coordinates", () => {
  // F1 (repository review 2026-10-08): the manifest's sourceStartMs and
  // sourceEndMs are the renderer's PLACED coordinates — the alignment
  // transform is already baked into them. downbeatOffsetMs is provenance of
  // how alignment was achieved, never a transform to re-apply. These tests
  // pin the projection from placed intervals, not the old formula.

  function frozenBeats(outgoingBeatsMs: number[], incomingBeatsMs: number[]) {
    return freezeJoinEvidence({
      outgoingTrackId: "out",
      incomingTrackId: "in",
      outgoingAnalysisVersion: "3.12.0",
      incomingAnalysisVersion: "3.12.0",
      outgoingBeatsMs,
      incomingBeatsMs,
      outgoingSourceStartMs: outgoingBeatsMs[0] ?? 0,
      outgoingSourceEndMs: (outgoingBeatsMs.at(-1) ?? 0) + 4_000,
      incomingSourceStartMs: incomingBeatsMs[0] ?? 0,
      incomingSourceEndMs: (incomingBeatsMs.at(-1) ?? 0) + 4_000,
      outgoingCamelotKey: "8A",
      incomingCamelotKey: "8A",
      outgoingAudioEndMs: null,
      outgoingTailEnergy: 0.4,
      incomingHeadEnergy: 0.3,
      incomingDropMs: null,
      recipeVersion: null,
      intent: null,
    });
  }

  it("does not re-apply an offset already baked into the incoming start", () => {
    // Review probe: outgoing beats 10000+n*345, incoming beats 80+n*345,
    // outgoing overlap begins at 10000, the placed incoming start is 80 and
    // the manifest records downbeatOffsetMs 80 (baked at render). Projection
    // from the placed start reads 0; adding the offset again read -80.
    const outgoing = Array.from({ length: 32 }, (_, i) => 10_000 + i * 345);
    const incoming = Array.from({ length: 32 }, (_, i) => 80 + i * 345);
    const inOverlapStart = placedIncomingOverlapStartMs(80, 80);
    expect(inOverlapStart).toBe(80);
    const residual = storedGridFromEvidence(
      frozenBeats(outgoing, incoming),
      10_000,
      inOverlapStart,
      1,
      1,
      80,
      345,
    );
    expect(Math.abs(residual.residualMs ?? 99)).toBeLessThan(20);
  });

  it("does not re-apply an offset that moved the outgoing end instead", () => {
    // Negative-start fallback: applyAlignmentOffset kept the incoming start
    // at 80 and moved the outgoing end back by the output-equivalent of the
    // 80 ms offset, so the placed outgoing overlap starts at 9920. Both
    // decks' grids read aligned only from the placed intervals.
    const outgoing = Array.from({ length: 32 }, (_, i) => 9_920 + i * 345);
    const incoming = Array.from({ length: 32 }, (_, i) => 80 + i * 345);
    const residual = storedGridFromEvidence(
      frozenBeats(outgoing, incoming),
      9_920,
      placedIncomingOverlapStartMs(80, 80),
      1,
      1,
      80,
      345,
    );
    expect(Math.abs(residual.residualMs ?? 99)).toBeLessThan(20);
  });

  it("treats a whole-beat-equivalent baked shift as aligned", () => {
    const outgoing = Array.from({ length: 32 }, (_, i) => 10_000 + i * 345);
    const incoming = Array.from({ length: 32 }, (_, i) => 345 + i * 345);
    const residual = storedGridFromEvidence(
      frozenBeats(outgoing, incoming),
      10_000,
      placedIncomingOverlapStartMs(345, 345),
      1,
      1,
      345,
      345,
    );
    expect(Math.abs(residual.residualMs ?? 99)).toBeLessThan(20);
  });

  it("projects non-unit rates from the placed starts", () => {
    // 170 BPM outgoing and 178 BPM incoming both playing at 174: rates
    // 174/170 and 174/178. Each deck's source beat period maps to the same
    // 344.8 ms output period, so the placed grids coincide in output time.
    const outPeriod = 60_000 / 170;
    const inPeriod = 60_000 / 178;
    const outgoing = Array.from({ length: 32 }, (_, i) => 10_000 + i * outPeriod);
    const incoming = Array.from({ length: 32 }, (_, i) => 88 + i * inPeriod);
    const residual = storedGridFromEvidence(
      frozenBeats(outgoing, incoming),
      10_000,
      placedIncomingOverlapStartMs(88, 88),
      174 / 170,
      174 / 178,
      88,
      60_000 / 174,
    );
    expect(Math.abs(residual.residualMs ?? 99)).toBeLessThan(20);
  });

  it("still reports a genuinely misaligned placed grid", () => {
    // Control: the placed-coordinate projection must not blanket-zero. The
    // incoming start is placed at 80 but its beats sit 80 ms late relative to
    // the outgoing train — a real defect the checker must keep reporting.
    const outgoing = Array.from({ length: 32 }, (_, i) => 10_000 + i * 345);
    const incoming = Array.from({ length: 32 }, (_, i) => 160 + i * 345);
    const residual = storedGridFromEvidence(
      frozenBeats(outgoing, incoming),
      10_000,
      placedIncomingOverlapStartMs(80, 80),
      1,
      1,
      80,
      345,
    );
    expect(residual.residualMs).not.toBeNull();
    expect(Math.abs(residual.residualMs ?? 0)).toBeGreaterThanOrEqual(60);
  });
});
