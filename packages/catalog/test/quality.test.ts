import { describe, expect, it } from "vitest";

import {
  harmonicClass,
  harmonicRelation,
  isConservativeHarmonic,
  type SetPlanV1,
  type Track,
} from "@dnb-crate/domain";
import { reportSetPlanQuality, type TrackQualityEvidence } from "../src/planning/quality.ts";
import { validateSetPlan } from "../src/planning/validate.ts";

function track(id: string, title: string, camelot: string | null, extras: Partial<Track> = {}): Track {
  return {
    id,
    filePath: `${title}.wav`,
    fileFingerprint: title,
    artist: extras.artist ?? title,
    title,
    album: null,
    durationMs: 180_000,
    sampleRateHz: 44100,
    channels: 2,
    bpm: 174,
    bpmSource: "manual",
    musicalKey: camelot?.endsWith("A") ? "Am" : "C",
    camelotKey: camelot,
    keySource: "manual",
    energy: 5,
    rating: 4,
    subgenres: [],
    moods: [],
    tags: [],
    notes: null,
    analysisStatus: "complete",
    fileMissing: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extras,
  };
}

function evidence(trackRow: Track, gridOk = true): TrackQualityEvidence {
  return {
    musicalKey: trackRow.musicalKey,
    camelotKey: trackRow.camelotKey,
    keySource: trackRow.keySource,
    keyConfidence: trackRow.keySource === "manual" ? 1 : 0.8,
    keyAnalyzerName: "keyfinder",
    nativeBpm: trackRow.bpm,
    gridOk,
    gridEngine: "dnb-crate-dsp",
  };
}

function twoTrackPlan(
  left: Track,
  right: Track,
  type: "phrase_mix" | "crossfade" = "phrase_mix",
  relationBars = 16,
): SetPlanV1 {
  return {
    schemaVersion: 1,
    id: "plan",
    name: "fixture",
    targetDurationMs: 300_000,
    targetBpm: null,
    requestedArc: [{ atFraction: 0, targetEnergy: 5 }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    entries: [
      {
        id: "e1",
        trackId: left.id,
        order: 0,
        sourceStartMs: 0,
        sourceEndMs: 120_000,
        timelineStartMs: 0,
        playbackRate: 1,
        gainDb: 0,
        transitionToNext: {
          id: "t1",
          type,
          durationMs: type === "crossfade" ? 30_000 : 22_000,
          outgoingCuePointId: null,
          incomingCuePointId: null,
          parameters: {
            barCount: relationBars,
            reason: type === "crossfade" ? "outgoing-grid-rejected" : "matched-grid-phrase",
            targetBpm: 174,
            phraseShape: "sequential",
            sequentialHandoff: "supported",
            intent: "sustain",
          },
        },
      },
      {
        id: "e2",
        trackId: right.id,
        order: 1,
        sourceStartMs: 0,
        sourceEndMs: 120_000,
        timelineStartMs: 90_000,
        playbackRate: 1,
        gainDb: 0,
        transitionToNext: null,
      },
    ],
  };
}

describe("plan quality report", () => {
  it("never clears derived constraint blockers with caller partial=false", () => {
    const a = track("a", "A", "8A"), b = track("b", "B", "8A");
    const plan = twoTrackPlan(a, b); plan.targetDurationMs = 218000;
    plan.planningConstraints = {requiredTransitions: [{outgoingTrackId: b.id, incomingTrackId: a.id, strength: "required", reuse: "pair"}]};
    const tracksById = new Map([[a.id,a],[b.id,b]]);
    const q = reportSetPlanQuality({plan,tracksById,evidenceByTrackId:new Map([[a.id,evidence(a)],[b.id,evidence(b)]]),validation:validateSetPlan(plan,tracksById),partial:false});
    expect(q.partial).toBe(true); expect(q.readyForAudition).toBe(false);
  });

  it("requires actual application of an exact recipe, even on a compatible pair", () => {
    const a = track("a", "A", "8A"), b = track("b", "B", "8A");
    const plan = twoTrackPlan(a,b); plan.targetDurationMs=218000;
    plan.planningConstraints={requiredTransitions:[{outgoingTrackId:a.id,incomingTrackId:b.id,strength:"required",reuse:"recipe",recipeId:"missing"}]};
    plan.entries[0]!.transitionToNext!.parameters.selectionReason="approved protected_reference exact";
    const tracksById=new Map([[a.id,a],[b.id,b]]);
    const q=reportSetPlanQuality({plan,tracksById,evidenceByTrackId:new Map([[a.id,evidence(a)],[b.id,evidence(b)]]),validation:validateSetPlan(plan,tracksById)});
    expect(q.joins[0]!.recipeStatus).toBe("none"); expect(q.qualityChecksPassed).toBe(false); expect(q.readyForAudition).toBe(false);
  });

  it.each(["grid", "confidence", "spacing"])("blocks invalid %s in strict edited plans", (kind) => {
    const a=track("a","A","8A"),b=track("b","B","8A",kind==="spacing"?{artist:"A"}:{});
    const plan=twoTrackPlan(a,b); plan.targetDurationMs=218000;plan.qualityPolicy="strict";
    const ea=evidence(a);if(kind==="grid")ea.gridOk=false;if(kind==="confidence")ea.keyConfidence=0;
    const tracksById=new Map([[a.id,a],[b.id,b]]);
    const q=reportSetPlanQuality({plan,tracksById,evidenceByTrackId:new Map([[a.id,ea],[b.id,evidence(b)]]),validation:validateSetPlan(plan,tracksById)});
    expect(q.qualityChecksPassed).toBe(false); expect(q.readyForAudition).toBe(false);
  });
  it("treats an hour request like any other length (±5 min)", () => {
    const a = track("a", "A", "8A");
    const b = track("b", "B", "8A");
    const plan = twoTrackPlan(a, b);
    plan.targetDurationMs = 3_600_000;
    const tracksById = new Map([
      [a.id, a],
      [b.id, b],
    ]);
    const validation = validateSetPlan(plan, tracksById);
    const inside = reportSetPlanQuality({
      plan,
      tracksById,
      evidenceByTrackId: new Map([
        [a.id, evidence(a)],
        [b.id, evidence(b)],
      ]),
      validation: {
        ...validation,
        valid: true,
        errors: [],
        diagnostics: {
          ...validation.diagnostics,
          durationMs: 3_330_000,
          durationDeltaMs: -270_000,
        },
      },
    });
    expect(inside.hourAuditionWindow).toBeNull();
    expect(inside.partial).toBe(false);
    expect(inside.readyForAudition).toBe(true);

    const outside = reportSetPlanQuality({
      plan,
      tracksById,
      evidenceByTrackId: new Map([
        [a.id, evidence(a)],
        [b.id, evidence(b)],
      ]),
      validation: {
        ...validation,
        valid: true,
        errors: [],
        diagnostics: {
          ...validation.diagnostics,
          durationMs: 3_240_000,
          durationDeltaMs: -360_000,
        },
      },
    });
    expect(outside.partial).toBe(true);
    expect(outside.readyForAudition).toBe(false);
  });

  it("classifies the five harmonic relations", () => {
    expect(harmonicRelation("5A", "5A")).toBe("same");
    expect(harmonicRelation("5A", "5B")).toBe("relative");
    expect(harmonicRelation("5A", "6A")).toBe("adjacent_same_mode");
    expect(harmonicRelation("3B", "4A")).toBe("other");
    expect(harmonicRelation(null, "5A")).toBe("unknown");
    expect(harmonicClass("same")).toBe("compatible");
    expect(harmonicClass("relative")).toBe("compatible");
    expect(harmonicClass("adjacent_same_mode")).toBe("compatible");
    expect(harmonicClass("other")).toBe("risky");
    expect(harmonicClass("unknown")).toBe("unknown");
    expect(isConservativeHarmonic("other")).toBe(false);
  });

  it("passes quality when every join is a conservative phrase mix", () => {
    const left = track("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1", "Same Left", "8A");
    const right = track("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2", "Same Right", "8A");
    const plan = twoTrackPlan(left, right);
    const tracksById = new Map([
      [left.id, left],
      [right.id, right],
    ]);
    const validation = validateSetPlan(plan, tracksById);
    const quality = reportSetPlanQuality({
      plan,
      tracksById,
      evidenceByTrackId: new Map([
        [left.id, evidence(left)],
        [right.id, evidence(right)],
      ]),
      validation,
    });
    expect(quality.harmonicCounts).toEqual({ compatible: 1, risky: 0, unknown: 0 });
    expect(quality.typeCounts.phrase_mix).toBe(1);
    expect(quality.qualityChecksPassed).toBe(true);
    expect(quality.joins[0]?.harmonicRelation).toBe("same");
  });

  it("fails quality for unexplained risky and unknown joins, including 3B→4A", () => {
    const left = track("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3", "Picton", "3B");
    const right = track("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4", "True Believer", "4A");
    const plan = twoTrackPlan(left, right);
    const tracksById = new Map([
      [left.id, left],
      [right.id, right],
    ]);
    const validation = validateSetPlan(plan, tracksById);
    const quality = reportSetPlanQuality({
      plan,
      tracksById,
      evidenceByTrackId: new Map([
        [left.id, evidence(left)],
        [right.id, evidence(right)],
      ]),
      validation,
    });
    expect(quality.joins[0]?.harmonicRelation).toBe("other");
    expect(quality.joins[0]?.harmonicClass).toBe("risky");
    expect(quality.qualityChecksPassed).toBe(false);

    const unknownRight = track("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5", "Unknown", null);
    const unknownPlan = twoTrackPlan(left, unknownRight);
    const unknownTracks = new Map([
      [left.id, left],
      [unknownRight.id, unknownRight],
    ]);
    const unknownQuality = reportSetPlanQuality({
      plan: unknownPlan,
      tracksById: unknownTracks,
      evidenceByTrackId: new Map([
        [left.id, evidence(left)],
        [unknownRight.id, evidence(unknownRight)],
      ]),
      validation: validateSetPlan(unknownPlan, unknownTracks),
    });
    expect(unknownQuality.joins[0]?.harmonicClass).toBe("unknown");
    expect(unknownQuality.qualityChecksPassed).toBe(false);
  });

  it("treats an allowQualityException constraint as an explained risk", () => {
    const left = track("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6", "Out", "10A");
    const right = track("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa7", "In", "1A");
    const plan = twoTrackPlan(left, right);
    plan.planningConstraints = {
      requiredTransitions: [
        {
          outgoingTrackId: left.id,
          incomingTrackId: right.id,
          strength: "required",
          reuse: "pair",
          allowQualityException: true,
        },
      ],
    };
    const tracksById = new Map([
      [left.id, left],
      [right.id, right],
    ]);
    const quality = reportSetPlanQuality({
      plan,
      tracksById,
      evidenceByTrackId: new Map([
        [left.id, evidence(left)],
        [right.id, evidence(right)],
      ]),
      validation: validateSetPlan(plan, tracksById),
    });
    expect(quality.joins[0]?.constraintSatisfaction).toBe("exception");
    expect(quality.qualityChecksPassed).toBe(true);
  });

  it("fires KEY_CLASH for analyzed keys when confidence is supplied", () => {
    const left = track("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa8", "Far Left", "11A", {
      keySource: "analyzed",
    });
    const right = track("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa9", "Far Right", "5A", {
      keySource: "analyzed",
    });
    const plan = twoTrackPlan(left, right);
    const tracksById = new Map([
      [left.id, left],
      [right.id, right],
    ]);
    const withoutConfidence = validateSetPlan(plan, tracksById);
    expect(withoutConfidence.warnings.some((issue) => issue.code === "KEY_CLASH")).toBe(false);
    const withConfidence = validateSetPlan(plan, tracksById, {
      keyConfidenceByTrackId: new Map([
        [left.id, 0.8],
        [right.id, 0.8],
      ]),
    });
    expect(withConfidence.warnings.some((issue) => issue.code === "KEY_CLASH")).toBe(true);
  });
});
