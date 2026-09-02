import {
  DURATION_TOLERANCE_MS,
  MAX_BPM_JUMP,
  MAX_CAMELOT_DISTANCE_OK,
  MAX_ENERGY_DEVIATION,
  MIN_PLAYABLE_DURATION_MS,
  camelotDistance,
  interpolateEnergy,
  type SetPlanV1,
  type Track,
  type ValidateSetPlanResult,
  type ValidationIssue,
} from "@dnb-crate/domain";

import { planDurationMs, playableMs } from "./timeline.ts";

export function validateSetPlan(
  plan: SetPlanV1,
  tracksById: Map<string, Track>,
  options?: { artistRepeatSpacing?: number; audioEndMsByTrackId?: Map<string, number> },
): ValidateSetPlanResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const seen = new Set<string>();
  const spacing = options?.artistRepeatSpacing ?? 1;
  const recentArtists: Array<string | null> = [];

  for (const entry of plan.entries) {
    const track = tracksById.get(entry.trackId);
    if (!track) {
      errors.push({
        code: "TRACK_NOT_FOUND",
        message: `Entry references unknown track ${entry.trackId}`,
        entryId: entry.id,
        trackId: entry.trackId,
      });
      continue;
    }
    if (seen.has(entry.trackId)) {
      errors.push({
        code: "DUPLICATE_TRACK",
        message: `Track ${track.title} appears more than once`,
        entryId: entry.id,
        trackId: entry.trackId,
      });
    }
    seen.add(entry.trackId);
    if (entry.timelineStartMs < 0) {
      errors.push({
        code: "NEGATIVE_TIMELINE",
        message: "Timeline position is negative",
        entryId: entry.id,
      });
    }
    if (entry.sourceStartMs < 0 || entry.sourceEndMs <= entry.sourceStartMs) {
      errors.push({
        code: "INVALID_TRIM",
        message: "Source window is empty or inverted",
        entryId: entry.id,
        trackId: track.id,
      });
    }
    if (entry.sourceEndMs > track.durationMs) {
      errors.push({
        code: "INVALID_TRIM",
        message: `Source end ${entry.sourceEndMs} exceeds duration ${track.durationMs}`,
        entryId: entry.id,
        trackId: track.id,
      });
    }
    if (
      playableMs(entry) < MIN_PLAYABLE_DURATION_MS &&
      track.durationMs >= MIN_PLAYABLE_DURATION_MS
    ) {
      errors.push({
        code: "INVALID_TRIM",
        message: `Playable duration is below ${MIN_PLAYABLE_DURATION_MS}ms`,
        entryId: entry.id,
        trackId: track.id,
      });
    }
    const audioEnd = options?.audioEndMsByTrackId?.get(entry.trackId);
    if (audioEnd != null && entry.sourceEndMs > audioEnd + 250) {
      warnings.push({
        code: "WINDOW_IN_SILENCE",
        message: `${track.title} source end ${entry.sourceEndMs}ms is past audio end ${audioEnd}ms`,
        entryId: entry.id,
        trackId: track.id,
      });
    }
    if (track.fileMissing) {
      warnings.push({
        code: "AUDIO_FILE_UNAVAILABLE",
        message: `${track.title} is marked missing from disk`,
        entryId: entry.id,
        trackId: track.id,
      });
    }
    if (track.bpm === null || track.camelotKey === null || track.energy === null) {
      warnings.push({
        code: "MISSING_METADATA",
        message: `${track.title} is missing BPM, key, and/or energy`,
        entryId: entry.id,
        trackId: track.id,
      });
    }
    const artist = track.artist?.toLowerCase() ?? null;
    if (
      spacing > 0 &&
      artist !== null &&
      recentArtists.slice(-spacing).some((item) => item === artist)
    ) {
      warnings.push({
        code: "ARTIST_REPEAT",
        message: `${track.artist} repeats inside the configured spacing`,
        entryId: entry.id,
        trackId: track.id,
      });
    }
    recentArtists.push(artist);
  }

  const durationMs = planDurationMs(plan.entries);
  const durationDeltaMs = durationMs - plan.targetDurationMs;
  if (Math.abs(durationDeltaMs) > DURATION_TOLERANCE_MS) {
    warnings.push({
      code: "DURATION_OFF_TARGET",
      message: `Plan duration ${durationMs}ms is ${durationDeltaMs}ms from target ${plan.targetDurationMs}ms`,
    });
  }

  const energyByEntry = plan.entries.map((entry, index) => {
    const fraction = plan.entries.length <= 1 ? 0 : index / (plan.entries.length - 1);
    const targetEnergy = interpolateEnergy(plan.requestedArc, fraction);
    const track = tracksById.get(entry.trackId);
    const actualEnergy = track?.energy ?? null;
    const deviation = actualEnergy === null ? null : actualEnergy - targetEnergy;
    if (deviation !== null && Math.abs(deviation) > MAX_ENERGY_DEVIATION) {
      warnings.push({
        code: "ENERGY_ARC_DEVIATION",
        message: `${track?.title ?? entry.trackId} energy ${actualEnergy} vs target ${targetEnergy.toFixed(1)}`,
        entryId: entry.id,
        trackId: entry.trackId,
      });
    }
    return {
      entryId: entry.id,
      trackId: entry.trackId,
      atFraction: fraction,
      actualEnergy,
      targetEnergy,
      deviation,
    };
  });

  for (let i = 0; i < plan.entries.length - 1; i += 1) {
    const a = tracksById.get(plan.entries[i]!.trackId);
    const b = tracksById.get(plan.entries[i + 1]!.trackId);
    if (!a || !b) {
      continue;
    }
    if (a.bpm !== null && b.bpm !== null && Math.abs(a.bpm - b.bpm) > MAX_BPM_JUMP) {
      warnings.push({
        code: "BPM_JUMP",
        message: `BPM jump ${a.bpm} → ${b.bpm} between ${a.title} and ${b.title}`,
        entryId: plan.entries[i]!.id,
        trackId: a.id,
      });
    }
    const distance = camelotDistance(a.camelotKey, b.camelotKey);
    if (distance !== null && distance > MAX_CAMELOT_DISTANCE_OK) {
      warnings.push({
        code: "KEY_CLASH",
        message: `Camelot ${a.camelotKey} → ${b.camelotKey} between ${a.title} and ${b.title}`,
        entryId: plan.entries[i]!.id,
        trackId: a.id,
      });
    }
  }

  if (plan.entries.length === 0) {
    errors.push({ code: "EMPTY_PLAN", message: "Set plan has no entries" });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    diagnostics: { durationMs, durationDeltaMs, energyByEntry },
  };
}
