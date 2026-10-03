import type { PlanQualityReport, SetPlanV1, Track, ValidateSetPlanResult } from "@dnb-crate/domain";
import {
  effectiveEnergy as effectiveEnergyOf,
  resolveCanonicalBpm,
  resolveCanonicalKeyConfidence,
} from "@dnb-crate/domain";
import { sha256Json } from "@dnb-crate/audio-renderer";
import type { HourFeedbackRepository } from "../hour-feedback-repository.ts";
import type { ApprovedRecipeRepository } from "../approved-recipe-repository.ts";
import type { AnalysisRepository } from "../analysis-repository.ts";
import type { TrackRepository } from "../repository.ts";
import type { FrozenRenderRequest } from "../render-job-repository.ts";
import { analysisForTimeline, isFrozenSnapshot, resolveTrackEvidence } from "../evidence.ts";
import { reportSetPlanQuality, type TrackQualityEvidence } from "../planning/quality.ts";
import { validateSetPlan } from "../planning/validate.ts";
import type { TimelineAnalysis } from "../planning/timeline.ts";

/** Everything the quality/evidence helpers need from the owning service. */
export type QualityEvidenceContext = {
  repository: TrackRepository;
  analyses: AnalysisRepository;
  recipes: ApprovedRecipeRepository;
  hourFeedback: HourFeedbackRepository;
  /** Timeline view of one track's selected evidence (service.toTimeline). */
  toTimeline: (track: Track) => TimelineAnalysis | null;
};

export function keyConfidenceByTrackId(ctx: QualityEvidenceContext): Map<string, number> {
  const out = new Map<string, number>();
  for (const track of ctx.repository.listAll()) {
    const keyRow = ctx.analyses.findKeyAnalysis(track.id);
    out.set(track.id, resolveCanonicalKeyConfidence(track, keyRow));
  }
  return out;
}

export function qualityEvidenceByTrackId(
  ctx: QualityEvidenceContext,
): Map<string, TrackQualityEvidence> {
  const out = new Map<string, TrackQualityEvidence>();
  for (const track of ctx.repository.listAll()) {
    const rhythm = ctx.analyses.findByTrackId(track.id);
    const keyRow = ctx.analyses.findKeyAnalysis(track.id) ?? rhythm;
    const timeline = ctx.toTimeline(track);
    out.set(track.id, {
      musicalKey:
        track.keySource === "manual" || track.keySource === "published"
          ? track.musicalKey
          : (keyRow?.musicalKey ?? track.musicalKey),
      camelotKey:
        track.keySource === "manual" || track.keySource === "published"
          ? track.camelotKey
          : (keyRow?.camelotKey ?? track.camelotKey),
      keySource: track.keySource,
      keyConfidence: resolveCanonicalKeyConfidence(track, keyRow),
      keyAnalyzerName: keyRow?.analyzerName ?? null,
      nativeBpm: resolveCanonicalBpm(track, rhythm).bpm,
      gridOk: timeline?.gridOk ?? false,
      gridEngine: rhythm?.analyzerName ?? null,
    });
  }
  return out;
}

export function qualityForPlan(
  ctx: QualityEvidenceContext,
  plan: SetPlanV1,
  evidence?: FrozenRenderRequest["evidence"],
): PlanQualityReport {
  const tracksById = new Map(ctx.repository.listAll().map((track) => [track.id, track]));
  const audioEnd = audioEndMsByTrackId(ctx);
  const keyConfidence = keyConfidenceByTrackId(ctx);
  const firstDropStart = firstDropStartMsByTrackId(ctx);
  const evidenceByTrackId = qualityEvidenceByTrackId(ctx);
  if (evidence) {
    for (const [trackId, row] of Object.entries(evidence)) {
      if (!isFrozenSnapshot(row)) {
        continue;
      }
      if (typeof row.audioEndMs === "number") {
        audioEnd.set(trackId, row.audioEndMs);
      }
      if (typeof row.keyConfidence === "number") {
        keyConfidence.set(trackId, row.keyConfidence);
      }
      const drops = row.sections.filter((section) => section.type === "drop");
      const drop = drops[0];
      if (drop && Number.isFinite(drop.startMs)) {
        firstDropStart.set(trackId, drop.startMs);
      }
      const track = tracksById.get(trackId);
      evidenceByTrackId.set(trackId, {
        musicalKey: row.musicalKey ?? track?.musicalKey ?? null,
        camelotKey: row.camelotKey ?? track?.camelotKey ?? null,
        keySource: track?.keySource ?? null,
        keyConfidence: row.keyConfidence ?? 0,
        keyAnalyzerName: row.keyEngine ?? null,
        nativeBpm: row.bpm,
        gridOk: row.present && !row.gridRejected,
        gridEngine: row.rhythmEngine ?? null,
      });
    }
  }
  const validation = validateSetPlan(plan, tracksById, {
    artistRepeatSpacing: plan.planningConstraints?.artistRepeatSpacing,
    audioEndMsByTrackId: audioEnd,
    effectiveEnergyByTrackId: effectiveEnergyByTrackId(ctx),
    keyConfidenceByTrackId: keyConfidence,
    firstDropStartMsByTrackId: firstDropStart,
  });
  return qualityFor(ctx, plan, { validation, evidenceByTrackId });
}

export function qualityFor(
  ctx: QualityEvidenceContext,
  plan: SetPlanV1,
  options: {
    validation: ValidateSetPlanResult;
    partial?: boolean;
    partialReasons?: string[];
    evidenceByTrackId?: Map<string, TrackQualityEvidence>;
  },
): PlanQualityReport {
  return reportSetPlanQuality({
    plan,
    tracksById: new Map(ctx.repository.listAll().map((track) => [track.id, track])),
    evidenceByTrackId: options.evidenceByTrackId ?? qualityEvidenceByTrackId(ctx),
    validation: options.validation,
    recipes: ctx.recipes,
    constraints: plan.planningConstraints ?? null,
    partial: options.partial,
    partialReasons: options.partialReasons,
    hourAccepted: ctx.hourFeedback.acceptedPlan(plan.id, sha256Json(plan)),
  });
}

export function audioEndMsByTrackId(ctx: QualityEvidenceContext): Map<string, number> {
  const map = new Map<string, number>();
  for (const track of ctx.repository.listAll()) {
    const end = ctx.analyses.findByTrackId(track.id)?.descriptors?.audioEndMs;
    if (typeof end === "number") {
      map.set(track.id, end);
    }
  }
  return map;
}

export function firstDropStartMsByTrackId(ctx: QualityEvidenceContext): Map<string, number> {
  const map = new Map<string, number>();
  for (const track of ctx.repository.listAll()) {
    const drop = analysisForTimeline(resolveTrackEvidence(ctx.analyses, track.id))?.sections?.find(
      (section) => section.type === "drop",
    );
    if (drop && Number.isFinite(drop.startMs)) {
      map.set(track.id, drop.startMs);
    }
  }
  return map;
}

export function effectiveEnergyByTrackId(ctx: QualityEvidenceContext): Map<string, number> {
  const out = new Map<string, number>();
  for (const track of ctx.repository.listAll()) {
    const energy = effectiveEnergyOf(
      track,
      ctx.analyses.findByTrackId(track.id)?.descriptors ?? null,
    );
    if (energy != null) {
      out.set(track.id, energy);
    }
  }
  return out;
}
