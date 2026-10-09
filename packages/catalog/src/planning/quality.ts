import {
  DEFAULT_ARTIST_REPEAT_SPACING,
  DURATION_QUALITY_WINDOW_MS,
  harmonicClass,
  harmonicRelation,
  normalizePersonName,
  type JoinConstraintSatisfaction,
  type JoinKeyEvidence,
  type JoinQualityReport,
  type JoinRecipeStatus,
  type PlanQualityReport,
  type PlanningConstraints,
  type SetPlanV1,
  type Track,
  type TransitionType,
  type ValidateSetPlanResult,
} from "@dnb-crate/domain";

import { verifiesAppliedRecipe } from "./applied-recipe.ts";
import type { RecipeRecallLookup } from "./recall.ts";
import { artistKey, isEnergyDeathContinuity } from "./shared.ts";

export type TrackQualityEvidence = {
  musicalKey: string | null;
  camelotKey: string | null;
  keySource: string | null;
  keyConfidence: number;
  keyAnalyzerName: string | null;
  nativeBpm: number | null;
  gridOk: boolean;
  gridEngine: string | null;
};

export type ReportSetPlanQualityInput = {
  plan: SetPlanV1;
  tracksById: Map<string, Track>;
  evidenceByTrackId: Map<string, TrackQualityEvidence>;
  validation: ValidateSetPlanResult;
  recipes?: RecipeRecallLookup | null;
  constraints?: PlanningConstraints | null;
  partial?: boolean;
  partialReasons?: string[];
  hourAccepted?: boolean;
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function keyEvidence(
  track: Track | undefined,
  evidence: TrackQualityEvidence | undefined,
): JoinKeyEvidence {
  return {
    musicalKey: evidence?.musicalKey ?? track?.musicalKey ?? null,
    camelotKey: evidence?.camelotKey ?? track?.camelotKey ?? null,
    source: evidence?.keySource ?? track?.keySource ?? null,
    confidence: evidence?.keyConfidence ?? 0,
    analyzerName: evidence?.keyAnalyzerName ?? null,
  };
}

function constraintSatisfactionForJoin(input: {
  outgoingId: string;
  incomingId: string;
  constraints: PlanningConstraints | null | undefined;
  recipeStatus: JoinRecipeStatus;
  appliedRecipeId: string | null;
  adjacent: boolean;
}): JoinConstraintSatisfaction {
  const match = (input.constraints?.requiredTransitions ?? []).find(
    (row) => row.outgoingTrackId === input.outgoingId && row.incomingTrackId === input.incomingId,
  );
  if (!match) {
    return "none";
  }
  if (!input.adjacent) {
    return match.strength === "preferred" ? "preferred-dropped" : "unsatisfied";
  }
  if (
    match.reuse === "recipe" &&
    (input.recipeStatus !== "applied" ||
      (match.recipeId && match.recipeId !== input.appliedRecipeId))
  ) {
    return "unsatisfied";
  }
  if (match.allowQualityException) return "exception";
  return "satisfied";
}

export function reportSetPlanQuality(input: ReportSetPlanQualityInput): PlanQualityReport {
  const entries = [...input.plan.entries].sort((a, b) => a.order - b.order);
  const constraints = input.constraints ?? input.plan.planningConstraints ?? null;
  const spacing =
    constraints?.artistRepeatSpacing ??
    input.plan.planningConstraints?.artistRepeatSpacing ??
    DEFAULT_ARTIST_REPEAT_SPACING;
  const typeCounts: Record<TransitionType, number> = {
    crossfade: 0,
    phrase_mix: 0,
    bass_swap: 0,
  };
  const harmonicCounts = { compatible: 0, risky: 0, unknown: 0 };
  const joins: JoinQualityReport[] = [];
  const adjacentPairs = new Set<string>();

  for (let i = 0; i < entries.length - 1; i += 1) {
    const outgoingEntry = entries[i]!;
    const incomingEntry = entries[i + 1]!;
    const outgoing = input.tracksById.get(outgoingEntry.trackId);
    const incoming = input.tracksById.get(incomingEntry.trackId);
    const outEvidence = input.evidenceByTrackId.get(outgoingEntry.trackId);
    const inEvidence = input.evidenceByTrackId.get(incomingEntry.trackId);
    const transition = outgoingEntry.transitionToNext;
    const type = transition?.type ?? "crossfade";
    typeCounts[type] += 1;
    const outKey = keyEvidence(outgoing, outEvidence);
    const inKey = keyEvidence(incoming, inEvidence);
    const relation = harmonicRelation(outKey.camelotKey, inKey.camelotKey);
    const klass = harmonicClass(relation);
    harmonicCounts[klass] += 1;
    const params = transition?.parameters ?? {};
    const fallbackReason = str(params.reason);
    let recipeStatus: JoinRecipeStatus = "none";
    const appliedId = str(params.appliedRecipeId);
    if (appliedId && input.recipes && outgoing && incoming) {
      const record = input.recipes
        .listForPair(outgoing.id, incoming.id)
        .find((row) => row.id === appliedId);
      recipeStatus =
        record && verifiesAppliedRecipe(record, outgoingEntry, incomingEntry, outgoing, incoming)
          ? "applied"
          : "stale";
    }
    const pairKey = `${outgoingEntry.trackId}->${incomingEntry.trackId}`;
    adjacentPairs.add(pairKey);
    const constraintSatisfaction = constraintSatisfactionForJoin({
      outgoingId: outgoingEntry.trackId,
      incomingId: incomingEntry.trackId,
      constraints,
      recipeStatus,
      appliedRecipeId: appliedId,
      adjacent: true,
    });
    const explained = recipeStatus === "applied" || constraintSatisfaction === "exception";
    const riskyOrUnknown = klass === "risky" || klass === "unknown";
    const evidenceInvalid =
      !outEvidence?.gridOk ||
      !inEvidence?.gridOk ||
      outKey.confidence < 0.5 ||
      inKey.confidence < 0.5;
    const unexplainedQualityIssue =
      (type === "crossfade" || riskyOrUnknown || evidenceInvalid) && !explained;
    const valleyBars =
      typeof params.continuityValleyBars === "number" ? params.continuityValleyBars : null;
    const coexistenceBars =
      typeof params.continuityCoexistenceBars === "number"
        ? params.continuityCoexistenceBars
        : null;
    const energyContinuityIssue = isEnergyDeathContinuity({ valleyBars, coexistenceBars });
    const joinTargetBpm = num(params.targetBpm);
    joins.push({
      order: i,
      outgoingTrackId: outgoingEntry.trackId,
      incomingTrackId: incomingEntry.trackId,
      outgoingTitle: outgoing?.title ?? outgoingEntry.trackId,
      incomingTitle: incoming?.title ?? incomingEntry.trackId,
      outgoingKey: outKey,
      incomingKey: inKey,
      harmonicRelation: relation,
      harmonicClass: klass,
      outgoingSourceStartMs: outgoingEntry.sourceStartMs,
      outgoingSourceEndMs: outgoingEntry.sourceEndMs,
      incomingSourceStartMs: incomingEntry.sourceStartMs,
      incomingSourceEndMs: incomingEntry.sourceEndMs,
      barCount: num(params.barCount),
      overlapMs: transition?.durationMs ?? 0,
      ...(str(params.continuityEvidence)
        ? {
            continuity: {
              evidence: str(params.continuityEvidence)!,
              energyFloor:
                typeof params.continuityEnergyFloor === "number"
                  ? params.continuityEnergyFloor
                  : null,
              valleyBars,
              coexistenceBars,
            },
          }
        : {}),
      phraseShape: str(params.phraseShape),
      sequentialHandoff: str(params.sequentialHandoff),
      intent: str(params.intent),
      type,
      fallbackReason: type === "crossfade" ? fallbackReason : null,
      nativeOutgoingBpm: outEvidence?.nativeBpm ?? outgoing?.bpm ?? null,
      nativeIncomingBpm: inEvidence?.nativeBpm ?? incoming?.bpm ?? null,
      joinTargetBpm,
      planTargetBpm: input.plan.targetBpm,
      outgoingRate: outgoingEntry.playbackRate,
      incomingRate: incomingEntry.playbackRate,
      rateRegionsVersion: num(params.rateRegionsVersion) ?? input.plan.rateRegionsVersion ?? null,
      gridOkOutgoing: outEvidence?.gridOk ?? false,
      gridOkIncoming: inEvidence?.gridOk ?? false,
      gridEngineOutgoing: outEvidence?.gridEngine ?? null,
      gridEngineIncoming: inEvidence?.gridEngine ?? null,
      recipeStatus,
      constraintSatisfaction,
      unexplainedQualityIssue,
      energyContinuityIssue,
    });
  }

  const unsatisfiedRequired: string[] = [];
  const trackIds = new Set(entries.map((entry) => entry.trackId));
  const boundaryOrExclusionViolation = Boolean(
    (constraints?.startTrackId && entries[0]?.trackId !== constraints.startTrackId) ||
    (constraints?.endTrackId && entries.at(-1)?.trackId !== constraints.endTrackId) ||
    constraints?.requiredTrackIds?.some((id) => !trackIds.has(id)) ||
    constraints?.excludedTrackIds?.some((id) => trackIds.has(id)) ||
    entries.some((entry) => {
      const track = input.tracksById.get(entry.trackId);
      return (
        track &&
        constraints?.excludedArtists?.some(
          (artist) => normalizePersonName(artist) === artistKey(track),
        )
      );
    }),
  );
  for (const constraint of constraints?.requiredTransitions ?? []) {
    const key = `${constraint.outgoingTrackId}->${constraint.incomingTrackId}`;
    const join = joins.find(
      (row) =>
        row.outgoingTrackId === constraint.outgoingTrackId &&
        row.incomingTrackId === constraint.incomingTrackId,
    );
    const exactSatisfied =
      constraint.reuse !== "recipe" ||
      (join?.recipeStatus === "applied" &&
        (!constraint.recipeId ||
          entries[join.order]?.transitionToNext?.parameters.appliedRecipeId ===
            constraint.recipeId));
    if (adjacentPairs.has(key) && exactSatisfied) {
      continue;
    }
    if (constraint.strength !== "preferred") {
      unsatisfiedRequired.push(key);
    }
  }

  const lastByArtist = new Map<string, number>();
  const artistGaps: PlanQualityReport["artistGaps"] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const track = input.tracksById.get(entries[i]!.trackId);
    if (!track) {
      continue;
    }
    const artist = artistKey(track);
    if (!artist) {
      continue;
    }
    const previous = lastByArtist.get(artist);
    if (previous != null) {
      artistGaps.push({
        artist,
        leftOrder: previous,
        rightOrder: i,
        gap: i - previous - 1,
      });
    }
    lastByArtist.set(artist, i);
  }
  const artistSpacingViolations = artistGaps.filter((row) => row.gap < spacing);

  // Renderer parity (2026-10 listening sessions): resolveRateRegions refuses a
  // deck whose head + tail join regions consume the whole body. That is
  // knowable at planning time; surface it before audio is cut.
  const entryBodyWarnings: PlanQualityReport["entryBodyWarnings"] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const previousJoinMs = i > 0 ? (entries[i - 1]!.transitionToNext?.durationMs ?? 0) : 0;
    const ownJoinMs = entry.transitionToNext?.durationMs ?? 0;
    const rate = entry.playbackRate > 0 ? entry.playbackRate : 1;
    const joinRegionsMs = Math.round((previousJoinMs + ownJoinMs) * rate);
    const bodyMs = entry.sourceEndMs - entry.sourceStartMs;
    if (bodyMs <= joinRegionsMs) {
      entryBodyWarnings.push({
        order: entry.order,
        title: input.tracksById.get(entry.trackId)?.title ?? null,
        bodyMs,
        joinRegionsMs,
      });
    }
  }

  const durationMs = input.validation.diagnostics.durationMs;
  const durationDeltaMs = input.validation.diagnostics.durationDeltaMs;
  const durationPartial = Math.abs(durationDeltaMs) > DURATION_QUALITY_WINDOW_MS;
  const partialReasons = [...(input.partialReasons ?? [])];
  if (durationPartial && !partialReasons.includes("DURATION")) {
    partialReasons.push("DURATION");
  }
  if (
    unsatisfiedRequired.length > 0 &&
    !partialReasons.includes("REQUIRED_TRANSITION_UNSATISFIED")
  ) {
    partialReasons.push("REQUIRED_TRANSITION_UNSATISFIED");
  }
  if (boundaryOrExclusionViolation) partialReasons.push("CONSTRAINT_UNSATISFIED");
  const partial =
    input.partial === true ||
    durationPartial ||
    unsatisfiedRequired.length > 0 ||
    boundaryOrExclusionViolation;
  if (
    input.plan.qualityPolicy === "strict" &&
    artistSpacingViolations.length > 0 &&
    !partialReasons.includes("ARTIST_SPACING")
  )
    partialReasons.push("ARTIST_SPACING");
  if (entryBodyWarnings.length > 0 && !partialReasons.includes("ENTRY_BODY")) {
    partialReasons.push("ENTRY_BODY");
  }
  if (
    input.plan.qualityPolicy === "strict" &&
    joins.some((join) => join.energyContinuityIssue) &&
    !partialReasons.includes("JOIN_CONTINUITY")
  ) {
    partialReasons.push("JOIN_CONTINUITY");
  }
  const qualityChecksPassed =
    joins.every((join) => !join.unexplainedQualityIssue) &&
    unsatisfiedRequired.length === 0 &&
    !boundaryOrExclusionViolation &&
    entryBodyWarnings.length === 0 &&
    (input.plan.qualityPolicy !== "strict" ||
      (artistSpacingViolations.length === 0 && joins.every((join) => !join.energyContinuityIssue)));
  if (joins.some((join) => join.unexplainedQualityIssue)) partialReasons.push("JOIN_QUALITY");
  const durationReady = !durationPartial;
  const readyForAudition =
    input.validation.valid && qualityChecksPassed && !partial && durationReady;

  return {
    joins,
    typeCounts,
    harmonicCounts,
    durationMs,
    durationDeltaMs,
    targetDurationMs: input.plan.targetDurationMs,
    artistRepeatSpacingRequested: spacing,
    artistGaps,
    artistSpacingViolations,
    entryBodyWarnings,
    partial,
    partialReasons: [...new Set(partialReasons)],
    unsatisfiedRequiredTransitions: unsatisfiedRequired,
    structurallyValid: input.validation.valid,
    qualityChecksPassed,
    readyForAudition,
    userAccepted: input.hourAccepted === true,
    qualityPolicy: input.plan.qualityPolicy ?? null,
  };
}
