import { describe, expect, it } from "vitest";
import {
  approvedPairKey,
  exactRecipeFingerprint,
  pickApprovedRecipe,
  recipeApplicability,
  recipeFeasibility,
  resolvePlanRateRegionsVersion,
  reusableRecipeFingerprint,
  reusableRecipeFromJoin,
  type ApprovedRecipeRecord,
  type RecipeLiveIdentity,
  type ReusableRecipePayload,
} from "../src/index.ts";
import { outputPositionToSourceMs, resolveRateRegions, sourcePositionToOutputMs } from "../src/rate-regions.ts";

function payload(overrides: Partial<ReusableRecipePayload> = {}): ReusableRecipePayload {
  const transition = {
    id: "11111111-1111-1111-1111-111111111111",
    type: "phrase_mix" as const,
    durationMs: 22069,
    outgoingCuePointId: null,
    incomingCuePointId: null,
    parameters: {
      barCount: 16,
      phraseShape: "sequential",
      intent: "sustain",
      sequentialHandoff: "supported",
      mixInMs: 1000,
      mixOutMs: 2000,
      rateRegionsVersion: 2,
    },
  };
  return {
    ...reusableRecipeFromJoin({
      outgoingTrackId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      incomingTrackId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      outgoingSourceFingerprint: "out-fp",
      incomingSourceFingerprint: "in-fp",
      outgoingSourceStartMs: 0,
      outgoingSourceEndMs: 40000,
      incomingSourceStartMs: 1000,
      incomingSourceEndMs: 50000,
      outgoingRate: 1,
      incomingRate: 1,
      outgoingGainDb: -10,
      incomingGainDb: -10,
      transition,
      automation: [
        {
          target: "incoming_mid",
          action: "ramp",
          atBar: 0,
          durationBars: 16,
          atMs: 0,
          durationMs: 22069,
          fromDb: null,
          toDb: 0,
        },
      ],
      engine: { rendererVersion: "6.13.0", tempoEngine: "rubberband-r3", stretchScope: "overlap" },
    }),
    ...overrides,
  };
}

function liveFrom(approved: ReusableRecipePayload, overrides: Partial<RecipeLiveIdentity> = {}): RecipeLiveIdentity {
  return {
    outgoingTrackId: approved.outgoingTrackId,
    incomingTrackId: approved.incomingTrackId,
    outgoingSourceFingerprint: approved.outgoingSourceFingerprint,
    incomingSourceFingerprint: approved.incomingSourceFingerprint,
    outgoingRate: approved.outgoingRate,
    incomingRate: approved.incomingRate,
    outgoingDurationMs: 200_000,
    incomingDurationMs: 200_000,
    engine: approved.engine,
    selectedEvidence: approved.selectedEvidence,
    ...overrides,
  };
}

describe("approved recipe recall", () => {
  it("retrieves the approved recipe when the audible payload still matches", () => {
    const approved = payload();
    const current = {
      ...approved,
      trackDurationMs: { outgoing: 200_000, incoming: 200_000 },
    };
    expect(recipeFeasibility(approved, current)).toEqual({ ok: true, mode: "exact" });
    expect(reusableRecipeFingerprint(approved)).toMatch(/^v2:[a-f0-9]{64}$/);
    expect(approvedPairKey(approved.outgoingTrackId, approved.incomingTrackId)).toContain(":");
  });

  it("does not inherit exact approval after automation, source or evidence change", () => {
    const approved = payload();
    const current = {
      ...approved,
      trackDurationMs: { outgoing: 200_000, incoming: 200_000 },
    };
    expect(
      recipeFeasibility(approved, { ...current, outgoingSourceFingerprint: "changed" }),
    ).toEqual({ ok: false, reason: "SOURCE_FINGERPRINT_CHANGED" });
    expect(recipeFeasibility(approved, { ...current, mixInMs: 999 })).toEqual({
      ok: false,
      reason: "WINDOWS_CHANGED",
    });
    expect(
      recipeFeasibility(approved, {
        ...current,
        automation: [{ ...approved.automation[0]!, durationMs: 1 }],
      }),
    ).toEqual({ ok: false, reason: "AUTOMATION_CHANGED" });
    expect(
      recipeFeasibility(approved, {
        ...current,
        selectedEvidence: { outgoing: "a", incoming: "b" },
      }),
    ).toEqual({ ok: false, reason: "EVIDENCE_CHANGED" });
    expect(recipeFeasibility(approved, { ...current, incomingGainDb: 0 })).toEqual({
      ok: false,
      reason: "GAINS_CHANGED",
    });
    expect(
      recipeFeasibility(approved, { ...current, outgoingGainDb: -12, incomingGainDb: -12 }),
    ).toEqual({ ok: true, mode: "common-gain-offset" });
  });

  it("prefers a protected reference over a weaker pair preference", () => {
    const shared = payload();
    const recipes: ApprovedRecipeRecord[] = [
      {
        id: "pref",
        status: "explicit_pair_preference",
        pairKey: approvedPairKey(shared.outgoingTrackId, shared.incomingTrackId),
        reusableFingerprint: reusableRecipeFingerprint(shared),
        payload: shared,
        heardRenderFingerprint: null,
        renderJobId: null,
        transitionId: null,
        setPlanId: null,
        outgoingTitle: "A",
        incomingTitle: "B",
        note: "pair",
        createdAt: "2026-09-09T00:00:00.000Z",
      },
      {
        id: "gold",
        status: "protected_reference",
        pairKey: approvedPairKey(shared.outgoingTrackId, shared.incomingTrackId),
        reusableFingerprint: reusableRecipeFingerprint(shared),
        payload: shared,
        heardRenderFingerprint: "heard",
        renderJobId: null,
        transitionId: null,
        setPlanId: null,
        outgoingTitle: "A",
        incomingTitle: "B",
        note: "landing",
        createdAt: "2026-09-08T00:00:00.000Z",
      },
    ];
    expect(pickApprovedRecipe(recipes, liveFrom(shared))?.recipe.id).toBe("gold");
    expect(recipeApplicability(shared, liveFrom(shared, { outgoingSourceFingerprint: "stale" })).ok).toBe(
      false,
    );
    const unreviewed: ApprovedRecipeRecord[] = [
      {
        ...recipes[0]!,
        id: "draft",
        status: "unreviewed_candidate",
      },
    ];
    expect(pickApprovedRecipe(unreviewed, liveFrom(shared))).toBeNull();
  });

});

describe("plan-level rate region resolution", () => {
  it("maps inverse positions and rejects mixed unknown versions while preserving legacy any-2", () => {
    const overlap = (16 * 60_000) / 174;
    const rate = 175 / 174;
    const regions = resolveRateRegions(40_000, rate, overlap, overlap / 2);
    const mid = regions[1]!.sourceStartMs + 10;
    expect(outputPositionToSourceMs(regions, sourcePositionToOutputMs(regions, mid))).toBeCloseTo(mid, 8);
    expect(resolvePlanRateRegionsVersion({ entries: [{ transitionToNext: { parameters: {} } }] }).version).toBe(1);
    expect(
      resolvePlanRateRegionsVersion({
        entries: [
          { transitionToNext: { parameters: { rateRegionsVersion: 2 } } },
          { transitionToNext: { parameters: {} } },
        ],
      }),
    ).toEqual({ version: 2, source: "legacy-any-marker", unknownVersions: [] });
    expect(
      resolvePlanRateRegionsVersion({
        rateRegionsVersion: 2,
        entries: [{ transitionToNext: { parameters: {} } }],
      }).source,
    ).toBe("plan");
    expect(
      resolvePlanRateRegionsVersion({
        entries: [
          { transitionToNext: { parameters: { rateRegionsVersion: 2 } } },
          { transitionToNext: { parameters: { rateRegionsVersion: 2 } } },
        ],
      }).source,
    ).toBe("uniform-transitions");
    expect(
      resolvePlanRateRegionsVersion({
        rateRegionsVersion: 3,
        entries: [{ transitionToNext: { parameters: { rateRegionsVersion: 4 } } }],
      }).unknownVersions,
    ).toEqual([3, 4]);
  });

  it("does not treat output checksum as interchangeable with a reusable recipe", () => {
    const recipe = payload();
    expect(reusableRecipeFingerprint(recipe)).not.toBe(
      exactRecipeFingerprint({ ...recipe, outputChecksum: "abc" }),
    );
  });
});
