import {
  DEFAULT_ARTIST_REPEAT_SPACING,
  DURATION_TOLERANCE_MS,
  MAX_BPM_JUMP,
  MAX_ENERGY_DEVIATION,
  MIN_PLAYABLE_DURATION_MS,
  isConfidentKeyClash,
  interpolateEnergy,
  normalizePersonName,
  recordingFamilyKeyFrom,
  type SetPlanV1,
  type Track,
  type ValidateSetPlanResult,
  type ValidationIssue,
} from "@dnb-crate/domain";

import { planDurationMs, playableMs } from "./timeline.ts";
import { lateDropMinPlayableMs } from "./windows.ts";

export function validateSetPlan(
  plan: SetPlanV1,
  tracksById: Map<string, Track>,
  options?: {
    artistRepeatSpacing?: number;
    audioEndMsByTrackId?: Map<string, number>;
    effectiveEnergyByTrackId?: Map<string, number>;
    keyConfidenceByTrackId?: Map<string, number>;
    firstDropStartMsByTrackId?: Map<string, number>;
  },
): ValidateSetPlanResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const seen = new Set<string>();
  const seenRecordings = new Set<string>();
  const seenFamilies = new Set<string>();
  const spacing = options?.artistRepeatSpacing ?? DEFAULT_ARTIST_REPEAT_SPACING;
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
    if (track.recordingKey) {
      if (seenRecordings.has(track.recordingKey)) {
        errors.push({
          code: "DUPLICATE_RECORDING",
          message: `Recording ${track.recordingKey} appears more than once`,
          entryId: entry.id,
          trackId: track.id,
        });
      }
      seenRecordings.add(track.recordingKey);
    }
    // Edition variants (extended/radio/version) share a family even when their
    // recording keys differ; one plan should not carry two editions of the
    // same production (2026-10: "Heartbeat Loud" radio + extended, 4 slots apart).
    const family = recordingFamilyKeyFrom({
      artist: track.artist,
      artistCanonical: track.artistCanonical,
      title: track.title,
    });
    if (seenFamilies.has(family)) {
      errors.push({
        code: "DUPLICATE_RECORDING_FAMILY",
        message: `Recording family ${family} appears more than once`,
        entryId: entry.id,
        trackId: track.id,
      });
    }
    seenFamilies.add(family);
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
    const minPlayable =
      lateDropMinPlayableMs(
        track.durationMs,
        options?.firstDropStartMsByTrackId?.get(entry.trackId),
      ) ?? MIN_PLAYABLE_DURATION_MS;
    const playable = playableMs(entry);
    if (playable < minPlayable && track.durationMs >= MIN_PLAYABLE_DURATION_MS) {
      errors.push({
        code: "INVALID_TRIM",
        message:
          `${track.title} plays ${playable}ms but needs at least ${minPlayable}ms ` +
          `(short by ${minPlayable - playable}ms; extend the source window or move the mix-in earlier)`,
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
    const energy = options?.effectiveEnergyByTrackId?.get(track.id) ?? track.energy;
    const missing: string[] = [];
    if (track.bpm === null) {
      missing.push("BPM");
    }
    if (track.camelotKey === null) {
      missing.push("key");
    }
    if (energy === null) {
      missing.push("energy");
    }
    if (missing.length > 0) {
      warnings.push({
        code: "MISSING_METADATA",
        message: `${track.title} is missing ${missing.join(", ")}`,
        entryId: entry.id,
        trackId: track.id,
      });
    }
    const artist =
      track.artistCanonical ?? (track.artist ? normalizePersonName(track.artist) : null);
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

  const durationMs = planDurationMs(plan.entries, plan);
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
    const actualEnergy =
      options?.effectiveEnergyByTrackId?.get(entry.trackId) ?? track?.energy ?? null;
    const deviation = actualEnergy === null ? null : actualEnergy - targetEnergy;
    return {
      entryId: entry.id,
      trackId: entry.trackId,
      atFraction: fraction,
      actualEnergy,
      targetEnergy,
      deviation,
    };
  });
  // Energy-arc diagnostics (2026-10 sessions): a per-entry warning for every
  // deviating track turned each render's warning list into noise — the
  // deviations were systematic (the pool simply lacks material as soft or as
  // hard as the arc requests), not per-track anomalies. Systematic runs
  // collapse into one summary per direction; isolated deviations stay
  // per-entry because those are signal.
  const deviating = energyByEntry.filter(
    (row) => row.deviation !== null && Math.abs(row.deviation) > MAX_ENERGY_DEVIATION,
  );
  for (const direction of [1, -1] as const) {
    const side = deviating.filter((row) => (row.deviation ?? 0) * direction > 0);
    if (side.length === 0) continue;
    const worst = side.reduce((max, row) =>
      Math.abs(row.deviation ?? 0) > Math.abs(max.deviation ?? 0) ? row : max,
    );
    const worstTrack = tracksById.get(worst.trackId);
    if (side.length >= 3) {
      warnings.push({
        code: "ENERGY_ARC_DEVIATION",
        message: `${side.length} of ${plan.entries.length} entries sit ${direction > 0 ? "above" : "below"} the requested energy arc (worst ${worst.actualEnergy} vs ${worst.targetEnergy.toFixed(1)} at ${worstTrack?.title ?? worst.trackId}) — the pool lacks ${direction > 0 ? "softer opening" : "harder closing"} material for this arc`,
      });
    } else {
      for (const row of side) {
        const track = tracksById.get(row.trackId);
        warnings.push({
          code: "ENERGY_ARC_DEVIATION",
          message: `${track?.title ?? row.trackId} energy ${row.actualEnergy} vs target ${row.targetEnergy.toFixed(1)}`,
          entryId: row.entryId,
          trackId: row.trackId,
        });
      }
    }
  }

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
    const leftConfidence =
      options?.keyConfidenceByTrackId?.get(a.id) ??
      (a.keySource === "manual" || a.keySource === "published" ? 1 : 0);
    const rightConfidence =
      options?.keyConfidenceByTrackId?.get(b.id) ??
      (b.keySource === "manual" || b.keySource === "published" ? 1 : 0);
    if (
      isConfidentKeyClash({
        leftKey: a.camelotKey,
        rightKey: b.camelotKey,
        leftConfidence,
        rightConfidence,
      })
    ) {
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
