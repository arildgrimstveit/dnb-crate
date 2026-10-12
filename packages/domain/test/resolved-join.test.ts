import { describe, expect, it } from "vitest";

import {
  JOIN_RESOLUTION_POLICY_VERSION,
  resolveJoinInputs,
  type JoinInputs,
} from "../src/contracts/resolved-join.ts";

/** 174 BPM fixture: bar = 1379.31 ms; a 16-bar phrase overlap = 22,069 ms.
 * Windows comfortably cover the overlap with native bodies. */
function baseInputs(): JoinInputs {
  return {
    outgoingEntryId: "entry-out",
    incomingEntryId: "entry-in",
    transitionId: "join-1",
    geometry: {
      outgoingSourceStartMs: 0,
      outgoingSourceEndMs: 100_000,
      incomingSourceStartMs: 4_000,
      incomingSourceEndMs: 104_000,
      joinOutputAnchorMs: 8_000,
      overlapMs: 22_069,
      outgoingRate: 1,
      incomingRate: 1,
      phraseBarCount: 16,
    },
    outgoingDurationMs: 110_000,
    incomingDurationMs: 120_000,
    alignment: {
      mode: "bar",
      periodMs: 1379.3103448275863,
      downbeatOffsetMs: 0,
      onsetLockBeats: null,
      confidence: null,
      coverage: null,
    },
    evidence: {
      outgoingFingerprint: "fp-out",
      incomingFingerprint: "fp-in",
      analyzerVersion: "3.13.0",
      gridSource: "analyzed",
    },
    treatment: { type: "phrase_mix", params: { targetBpm: 174 } },
    gain: { gainDb: -1.5, source: "derived" },
  };
}

describe("resolved join contract (Q03)", () => {
  it("resolves a well-formed unequal-rate join with the pinned policy version", () => {
    const inputs = baseInputs();
    inputs.geometry.outgoingRate = 174 / 175;
    inputs.geometry.incomingRate = 175 / 178;
    const resolution = resolveJoinInputs(inputs);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.context.policyVersion).toBe(JOIN_RESOLUTION_POLICY_VERSION);
    expect(resolution.context.schemaVersion).toBe(1);
    expect(resolution.context.geometry.joinOutputAnchorMs).toBe(8_000);
    // Unknown stays unknown: null confidence/coverage/onset lock pass
    // through unchanged rather than being guessed.
    expect(resolution.context.alignment.confidence).toBeNull();
    expect(resolution.context.alignment.coverage).toBeNull();
    expect(resolution.context.alignment.onsetLockBeats).toBeNull();
  });

  it("returns bounds-exceed-source instead of clamping when a window overruns the source", () => {
    const inputs = baseInputs();
    inputs.geometry.incomingSourceEndMs = 130_000; // beyond the 120 s source
    const resolution = resolveJoinInputs(inputs);
    expect(resolution.status).toBe("unresolved");
    if (resolution.status !== "unresolved") return;
    expect(resolution.reason).toBe("bounds-exceed-source");
    expect(resolution.detail).toContain("130000");
  });

  it("rejects a pinned gain without a value", () => {
    const inputs: JoinInputs = baseInputs();
    inputs.gain = { gainDb: null, source: "pinned" };
    expect(resolveJoinInputs(inputs)).toMatchObject({
      status: "unresolved",
      reason: "invalid-gain",
    });
  });

  it("keeps a null derived gain unknown rather than substituting zero", () => {
    const inputs = baseInputs();
    inputs.gain = { gainDb: null, source: "derived" };
    const resolution = resolveJoinInputs(inputs);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.context.gain).toEqual({ gainDb: null, source: "derived" });
  });

  it("uses the piecewise rate map for overlap coverage: a slowed outgoing window still fits", () => {
    // Whole-window arithmetic would call 100,000/0.9943 - 22,069 a
    // failure boundary; the piecewise map (native body + stretched tail)
    // accepts it because the stretch CONSUMES LESS source than output.
    const inputs = baseInputs();
    inputs.geometry.outgoingRate = 174 / 175;
    const resolution = resolveJoinInputs(inputs);
    expect(resolution.status).toBe("resolved");
  });

  it("rejects an incoming window too small to cover the overlap", () => {
    const inputs = baseInputs();
    // 21,000 ms of incoming against a 22,069 ms overlap: the overlap IS
    // the incoming deck's head region, which cannot exceed the window.
    inputs.geometry.incomingSourceStartMs = 4_000;
    inputs.geometry.incomingSourceEndMs = 25_000;
    const resolution = resolveJoinInputs(inputs);
    expect(
      resolution.status === "unresolved" &&
        (resolution.reason === "no-native-body" || resolution.reason === "overlap-exceeds-window"),
    ).toBe(true);
  });

  it("rejects geometry that leaves no native body", () => {
    const inputs = baseInputs();
    // Overlap consumes the entire outgoing slice: nothing native remains.
    inputs.geometry.outgoingSourceEndMs = 22_069;
    const resolution = resolveJoinInputs(inputs);
    expect(
      resolution.status === "unresolved" &&
        (resolution.reason === "no-native-body" || resolution.reason === "overlap-exceeds-window"),
    ).toBe(true);
  });

  it("rejects non-positive rates and missing fingerprints", () => {
    const zeroRate = baseInputs();
    zeroRate.geometry.incomingRate = 0;
    expect(resolveJoinInputs(zeroRate)).toMatchObject({
      status: "unresolved",
      reason: "invalid-rate",
    });
    const noEvidence = baseInputs();
    noEvidence.evidence.outgoingFingerprint = "";
    expect(resolveJoinInputs(noEvidence)).toMatchObject({
      status: "unresolved",
      reason: "missing-evidence",
    });
  });

  it("rejects invalid alignment periods", () => {
    const inputs = baseInputs();
    inputs.alignment.periodMs = 0;
    expect(resolveJoinInputs(inputs)).toMatchObject({
      status: "unresolved",
      reason: "invalid-alignment",
    });
  });
});
