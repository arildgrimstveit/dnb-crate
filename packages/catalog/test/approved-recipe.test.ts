import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { createCatalogRuntime } from "../src/index.ts";
import { recallApprovedHandoff } from "../src/planning/recall.ts";
import { chooseTransition, type TimelineTrack } from "../src/planning/timeline.ts";
import {
  reusableRecipeFingerprint,
  reusableRecipeFromJoin,
  type AppConfig,
  type ReusableRecipePayload,
} from "@dnb-crate/domain";

function payload(overrides: Partial<ReusableRecipePayload> = {}): ReusableRecipePayload {
  return {
    ...reusableRecipeFromJoin({
      outgoingTrackId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      incomingTrackId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      outgoingSourceFingerprint: "out-fp",
      incomingSourceFingerprint: "in-fp",
      outgoingSourceStartMs: 1000,
      outgoingSourceEndMs: 90000,
      incomingSourceStartMs: 2000,
      incomingSourceEndMs: 100000,
      outgoingRate: 1,
      incomingRate: 1,
      outgoingGainDb: -10,
      incomingGainDb: -10,
      transition: {
        id: "11111111-1111-1111-1111-111111111111",
        type: "phrase_mix",
        durationMs: 22069,
        outgoingCuePointId: null,
        incomingCuePointId: null,
        parameters: {
          barCount: 16,
          phraseShape: "sequential",
          intent: "sustain",
          sequentialHandoff: "supported",
          mixInMs: 2000,
          mixOutMs: 67931,
          targetBpm: 174,
          rateRegionsVersion: 2,
        },
      },
      engine: { rendererVersion: "6.13.0", tempoEngine: "rubberband-r3", stretchScope: "overlap" },
    }),
    ...overrides,
  };
}

function gridTrack(id: string, title: string, fingerprint: string): TimelineTrack {
  return {
    id,
    title,
    fileFingerprint: fingerprint,
    durationMs: 180_000,
    energy: 7,
    bpm: 174,
    camelotKey: "8A",
    analysis: {
      gridOk: true,
      bpm: 174,
      canonicalBpm: 174,
      bpmHint: 174,
      bpmHintConfidence: 1,
      suggestedEnergy: 0.7,
      introStartMs: 0,
      outroStartMs: 150_000,
      outroEndMs: 180_000,
      introLenMs: 20_000,
      outroLenMs: 30_000,
      sections: [
        { type: "intro", startMs: 0, endMs: 20_000, startBar: 0, endBar: 16, confidence: 1, sectionEnergy: 0.2 },
        { type: "drop", startMs: 20_000, endMs: 150_000, startBar: 16, endBar: 120, confidence: 1, sectionEnergy: 0.8 },
        { type: "outro", startMs: 150_000, endMs: 180_000, startBar: 120, endBar: 144, confidence: 1, sectionEnergy: 0.2 },
      ],
      downbeatTimesMs: Array.from({ length: 145 }, (_, i) => i * ((4 * 60_000) / 174)),
      downbeatConfidence: 1,
      audioStartMs: 0,
      audioEndMs: 180_000,
      mixInMs: 20_000,
      mixOutMs: 150_000,
      headEnergy: 0.2,
      tailEnergy: 0.2,
      integratedLufs: -10,
      keyConfidence: 1,
    },
  };
}

describe("approved recipe registry", () => {
  it("ignores repeated imports of the same payload and note", () => {
    const root = path.join(
      os.tmpdir(),
      `dnb-recipes-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const config: AppConfig = {
      databasePath: path.join(root, "catalog.sqlite"),
      libraryRoots: [path.join(root, "library")],
      outputRoot: path.join(root, "output"),
      logLevel: "error",
      supportedExtensions: [".wav", ".flac", ".mp3", ".m4a", ".aiff", ".aif"],
    };
    const catalog = createCatalogRuntime(config, undefined, { useFakeFfmpeg: true });
    try {
      const body = payload();
      const row = {
        status: "explicit_pair_preference" as const,
        pairKey: `${body.outgoingTrackId}:${body.incomingTrackId}`,
        reusableFingerprint: reusableRecipeFingerprint(body),
        payload: body,
        heardRenderFingerprint: null,
        renderJobId: null,
        transitionId: null,
        setPlanId: null,
        outgoingTitle: "Been Dreaming",
        incomingTitle: "Sounds Of Life",
        note: "supported preference",
      };
      expect(catalog.service.importApprovedRecipe(row).inserted).toBe(true);
      expect(catalog.service.importApprovedRecipe(row).inserted).toBe(false);
      expect(catalog.service.listApprovedRecipes(body.outgoingTrackId, body.incomingTrackId)).toHaveLength(1);
    } finally {
      catalog.close();
    }
  });

  it("recalls an exact supported recipe and falls back when the fingerprint is stale", () => {
    const approved = payload();
    const lookup = {
      listForPair: () => [
        {
          id: "1",
          status: "explicit_pair_preference" as const,
          pairKey: `${approved.outgoingTrackId}:${approved.incomingTrackId}`,
          reusableFingerprint: reusableRecipeFingerprint(approved),
          payload: approved,
          heardRenderFingerprint: "heard",
          renderJobId: null,
          transitionId: null,
          setPlanId: null,
          outgoingTitle: "Been Dreaming",
          incomingTitle: "Sounds Of Life",
          note: "supported",
          createdAt: "2026-09-09T00:00:00.000Z",
        },
      ],
    };
    const outgoing = gridTrack(approved.outgoingTrackId, "Been Dreaming", "out-fp");
    const incoming = gridTrack(approved.incomingTrackId, "Sounds Of Life", "in-fp");
    const live = {
      outgoingTrackId: approved.outgoingTrackId,
      incomingTrackId: approved.incomingTrackId,
      outgoingSourceFingerprint: "out-fp",
      incomingSourceFingerprint: "in-fp",
      outgoingRate: 1,
      incomingRate: 1,
      outgoingDurationMs: 180_000,
      incomingDurationMs: 180_000,
      engine: approved.engine,
      selectedEvidence: null,
    };
    const hit = recallApprovedHandoff(outgoing, incoming, live, lookup);
    expect(hit?.fallback).toBe(false);
    expect(hit?.chosen?.transition.parameters.sequentialHandoff).toBe("supported");
    expect(hit?.chosen?.transition.parameters.mixInMs).toBe(2000);
    const fresh = chooseTransition(outgoing, incoming, { recall: lookup, liveIdentity: live });
    expect(fresh.transition.parameters.appliedRecipeId).toBeUndefined();
    const requested = chooseTransition(outgoing, incoming, {
      recall: { ...lookup, reuseForPair: () => "recipe" }, liveIdentity: live });
    expect(requested.transition.parameters.appliedRecipeId).toBe("1");
    const stale = recallApprovedHandoff(outgoing, incoming, { ...live, outgoingSourceFingerprint: "other" }, lookup);
    expect(stale?.fallback).toBe(true);
    expect(stale?.reason).toBe("SOURCE_FINGERPRINT_CHANGED");
  });

  it("does not special-case titles when choosing a handoff", () => {
    const namedOut = gridTrack("caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Moment to Moment", "c-out");
    const namedIn = gridTrack("cbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "Colour Me In", "c-in");
    const genericOut = gridTrack("daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Hot Out", "d-out");
    const genericIn = gridTrack("dbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "Hot In", "d-in");
    const named = chooseTransition(namedOut, namedIn, { chainTargetBpm: 174 });
    const generic = chooseTransition(genericOut, genericIn, { chainTargetBpm: 174 });
    expect(named.transition.parameters.appliedRecipeId).toBeUndefined();
    expect(named.transition.parameters.barCount).toBe(generic.transition.parameters.barCount);
    expect(named.transition.parameters.phraseShape).toBe(generic.transition.parameters.phraseShape);
  });

  it("emits supported sequential and timing version 2 on new joins", () => {
    const outgoing = gridTrack("eaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Hot Out", "e-out");
    outgoing.analysis!.sections[2]!.sectionEnergy = 0.7;
    outgoing.analysis!.tailEnergy = 0.7;
    const incoming = gridTrack("ebbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "Hot In", "e-in");
    incoming.analysis!.sections[0]!.sectionEnergy = 0.7;
    incoming.analysis!.headEnergy = 0.7;
    const chosen = chooseTransition(outgoing, incoming, { chainTargetBpm: 174 });
    if (chosen.transition.parameters.phraseShape === "sequential") {
      expect(chosen.transition.parameters.sequentialHandoff).toBe("supported");
    }
    expect(chosen.transition.parameters.rateRegionsVersion).toBe(2);
  });

  it("keeps a 16-bar or longer join on a complementary pair", () => {
    const outgoing = gridTrack("faaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "The Fountain", "f-out");
    const incoming = gridTrack("fbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "Lotus Flower", "f-in");
    const chosen = chooseTransition(outgoing, incoming, { chainTargetBpm: 174 });
    expect(["landing", "complementary"]).toContain(chosen.transition.parameters.phraseShape);
    expect(chosen.transition.parameters.barCount).toBeGreaterThanOrEqual(16);
    expect(chosen.transition.parameters.rateRegionsVersion).toBe(2);
  });

  it("uses a 16-bar or longer supported join when incoming kit is already on", () => {
    const outgoing = gridTrack("gaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Kit Out", "g-out");
    outgoing.analysis!.sections[2]!.sectionEnergy = 0.4;
    outgoing.analysis!.tailEnergy = 0.4;
    const incoming = gridTrack("gbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "Kit In", "g-in");
    incoming.analysis!.sections[0]!.sectionEnergy = 0.7;
    incoming.analysis!.headEnergy = 0.7;
    const chosen = chooseTransition(outgoing, incoming, { chainTargetBpm: 174 });
    expect(chosen.transition.parameters.barCount).toBeGreaterThanOrEqual(16);
    expect(chosen.transition.parameters.sequentialHandoff).toBe("supported");
    expect(chosen.transition.parameters.rateRegionsVersion).toBe(2);
  });

  it("defaults new joins to timing version 2", () => {
    const outgoing = gridTrack("haaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Float Out", "h-out");
    const incoming = gridTrack("hbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "Float In", "h-in");
    incoming.analysis!.sections[0]!.sectionEnergy = 0.7;
    incoming.analysis!.headEnergy = 0.7;
    outgoing.analysis!.sections[2]!.sectionEnergy = 0.4;
    outgoing.analysis!.tailEnergy = 0.4;
    const chosen = chooseTransition(outgoing, incoming);
    expect(chosen.transition.parameters.rateRegionsVersion).toBe(2);
    expect(chosen.transition.parameters.appliedRecipeId).toBeUndefined();
  });
});
