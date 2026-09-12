import { describe, expect, it } from "vitest";
import { outputPositionToSourceMs, resolveRateRegions, type SetPlanEntry } from "@dnb-crate/domain";
import { slicePreview } from "../src/render/coordinator.ts";
import { playableOutputMs } from "../src/planning/timeline.ts";

describe("contextual preview windows", () => {
  it("preserves full overlap and eight bars on each side at unequal rates", () => {
    const overlap = (128 * 60_000) / 174;
    const outgoing: SetPlanEntry = {
      id: "out",
      trackId: "a",
      order: 0,
      sourceStartMs: 0,
      sourceEndMs: 200_000,
      timelineStartMs: 0,
      playbackRate: 0.98,
      gainDb: -2,
      transitionToNext: {
        id: "join",
        type: "phrase_mix",
        durationMs: overlap,
        outgoingCuePointId: null,
        incomingCuePointId: null,
        parameters: { targetBpm: 174 },
      },
    };
    const incoming = {
      ...outgoing,
      id: "in",
      trackId: "b",
      playbackRate: 1.02,
      transitionToNext: null,
    };
    const preview = slicePreview({ outgoing, incoming }, 30_000);
    expect(preview.overlapMs).toBe(overlap);
    const context = (32 * 60_000) / 174;
    expect(
      (preview.outgoing.sourceEndMs - preview.outgoing.sourceStartMs) / 0.98 - overlap,
    ).toBeCloseTo(context, 6);
    expect(
      (preview.incoming.sourceEndMs - preview.incoming.sourceStartMs) / 1.02 - overlap,
    ).toBeCloseTo(context, 6);
    expect(preview.outgoing.sourceEndMs - overlap * 0.98).toBeCloseTo(
      outgoing.sourceEndMs - overlap * outgoing.playbackRate,
      6,
    );
    expect(preview.incoming.sourceStartMs).toBe(incoming.sourceStartMs);
  });

  it("uses piecewise mapping for a version-2 middle-pair preview", () => {
    const overlap = (128 * 60_000) / 174;
    const outgoing: SetPlanEntry = {
      id: "out",
      trackId: "a",
      order: 0,
      sourceStartMs: 0,
      sourceEndMs: 200_000,
      timelineStartMs: 0,
      playbackRate: 174 / 175,
      gainDb: 0,
      transitionToNext: {
        id: "join",
        type: "phrase_mix",
        durationMs: overlap,
        outgoingCuePointId: null,
        incomingCuePointId: null,
        parameters: { targetBpm: 174, rateRegionsVersion: 2 },
      },
    };
    const incoming = {
      ...outgoing,
      id: "in",
      trackId: "b",
      playbackRate: 1,
      transitionToNext: null,
    };
    const preview = slicePreview({ outgoing, incoming }, 30_000, 2);
    expect(preview.overlapMs).toBe(overlap);
    expect(preview.incoming.sourceStartMs).toBe(incoming.sourceStartMs);
    expect(preview.outgoing.sourceEndMs).toBe(outgoing.sourceEndMs);
  });

  it("agrees on the middle join coordinate between a three-track chain and the extracted pair", () => {
    const overlap = (16 * 60_000) / 174;
    const rate = 174 / 175;
    const sourceMs = 40_000;
    const b: SetPlanEntry = {
      id: "b",
      trackId: "b",
      order: 1,
      sourceStartMs: 0,
      sourceEndMs: sourceMs,
      timelineStartMs: 0,
      playbackRate: rate,
      gainDb: 0,
      transitionToNext: {
        id: "j1",
        type: "phrase_mix",
        durationMs: overlap,
        outgoingCuePointId: null,
        incomingCuePointId: null,
        parameters: { rateRegionsVersion: 2 },
      },
    };
    const full = resolveRateRegions(sourceMs, rate, overlap, overlap);
    const preview = slicePreview(
      {
        outgoing: b,
        incoming: { ...b, id: "c", trackId: "c", playbackRate: 1, transitionToNext: null },
      },
      30_000,
      2,
    );
    const slicedSource = preview.outgoing.sourceEndMs - preview.outgoing.sourceStartMs;
    const sliced = resolveRateRegions(slicedSource, rate, 0, overlap);
    const previewTailSource =
      preview.outgoing.sourceStartMs +
      outputPositionToSourceMs(sliced, sliced.at(-1)!.outputEndMs - overlap);
    expect(previewTailSource).toBeCloseTo(full.at(-1)!.sourceStartMs, 6);
    expect(playableOutputMs(b, overlap, 2)).toBeCloseTo(full.at(-1)!.outputEndMs, 6);
  });
});
