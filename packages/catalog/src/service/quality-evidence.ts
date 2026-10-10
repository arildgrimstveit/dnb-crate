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
  // R9: null-capable so a frozen "absent" can be recorded distinctly from
  // "no information" — validation treats a recorded null as unknown energy
  // instead of falling back to live metadata.
  const effectiveEnergy = new Map<string, number | null>(effectiveEnergyByTrackId(ctx));
  // Frozen camelot keys/sources for the clash check: only populated from
  // snapshot rows, so the live path is untouched.
  const camelotKey = new Map<string, string | null>();
  const keySource = new Map<string, string | null>();
  if (evidence) {
    for (const [trackId, row] of Object.entries(evidence)) {
      if (!isFrozenSnapshot(row)) {
        continue;
      }
      // Absent stays absent (R9): a frozen null is RECORDED absence, not
      // permission to fall through to later live analysis. Number values
      // override live; null values delete the live entry so validation's
      // optional lookups see "unknown", matching what the queue-time
      // snapshot actually knew.
      if (typeof row.audioEndMs === "number") {
        audioEnd.set(trackId, row.audioEndMs);
      } else {
        audioEnd.delete(trackId);
      }
      const frozenKeyConfidence =
        typeof row.canonical?.keyConfidence === "number"
          ? row.canonical.keyConfidence
          : typeof row.keyConfidence === "number"
            ? row.keyConfidence
            : null;
      if (frozenKeyConfidence != null) {
        keyConfidence.set(trackId, frozenKeyConfidence);
      } else {
        keyConfidence.delete(trackId);
      }
      if (typeof row.canonical?.effectiveEnergy === "number") {
        effectiveEnergy.set(trackId, row.canonical.effectiveEnergy);
      } else if (row.canonical != null) {
        effectiveEnergy.set(trackId, null);
      }
      const drops = row.sections.filter((section) => section.type === "drop");
      const drop = drops[0];
      if (drop && Number.isFinite(drop.startMs)) {
        firstDropStart.set(trackId, drop.startMs);
      } else {
        firstDropStart.delete(trackId);
      }
      // F4b/R9: the frozen CANONICAL block governs queued quality when
      // present — including its nulls. A canonical musicalKey of null means
      // "unknown at queue time" and must not resurrect later live metadata.
      // Legacy requests without the block keep the previous row-derived
      // values.
      const canonical = row.canonical ?? null;
      const track = tracksById.get(trackId);
      // The clash check reads the same frozen values: a canonical block
      // (present) owns camelot/source including nulls; legacy rows fall
      // back to the row, then to the live track as before.
      camelotKey.set(
        trackId,
        canonical != null ? canonical.camelotKey : (row.camelotKey ?? track?.camelotKey ?? null),
      );
      keySource.set(trackId, canonical != null ? canonical.keySource : (track?.keySource ?? null));
      evidenceByTrackId.set(trackId, {
        musicalKey:
          canonical != null ? canonical.musicalKey : (row.musicalKey ?? track?.musicalKey ?? null),
        camelotKey:
          canonical != null ? canonical.camelotKey : (row.camelotKey ?? track?.camelotKey ?? null),
        keySource: canonical != null ? canonical.keySource : (track?.keySource ?? null),
        keyConfidence: frozenKeyConfidence ?? 0,
        keyAnalyzerName: canonical?.keyAnalyzerName ?? row.keyEngine ?? null,
        nativeBpm: canonical != null ? canonical.nativeBpm : row.bpm,
        gridOk: row.present && !row.gridRejected,
        gridEngine: canonical?.gridEngine ?? row.rhythmEngine ?? null,
      });
    }
  }
  const validation = validateSetPlan(plan, tracksById, {
    artistRepeatSpacing: plan.planningConstraints?.artistRepeatSpacing,
    audioEndMsByTrackId: audioEnd,
    effectiveEnergyByTrackId: effectiveEnergy,
    keyConfidenceByTrackId: keyConfidence,
    firstDropStartMsByTrackId: firstDropStart,
    camelotKeyByTrackId: camelotKey,
    keySourceByTrackId: keySource,
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
