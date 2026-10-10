import type {
  CreateSetPlanInput,
  DescriptorFilters,
  DescriptorPercentiles,
  RejectionExplanation,
  Track,
} from "@dnb-crate/domain";
import {
  PLANNER_MIN_POOL_ESTIMATE,
  PLANNER_MIN_TEMPO_STABILITY,
  PLANNER_POOL_MIN_TRACKS,
  PLANNER_POOL_RELAX_FACTOR,
  genresMatchFilter,
  matchesDescriptorFilters,
  resolveDescriptorFilters,
} from "@dnb-crate/domain";

import { PlanningConstraintError } from "./constraints.ts";
import { typicalPlayable } from "./selection.ts";
import type { TimelineAnalysis } from "./timeline.ts";
import { artistKey } from "./shared.ts";

export function relaxDescriptorFilters(
  original: DescriptorFilters | undefined,
  step: number,
): DescriptorFilters | undefined {
  if (!original) {
    return original;
  }
  const delta = 0.08 * step;
  const loosened: DescriptorFilters = {};
  for (const key of Object.keys(original) as Array<keyof DescriptorFilters>) {
    const range = original[key];
    if (!range) {
      continue;
    }
    loosened[key] = {
      min: range.min != null ? range.min - delta : undefined,
      max: range.max != null ? range.max + delta : undefined,
    };
  }
  return loosened;
}

export type PlanningPool = {
  pool: Track[];
  byId: Map<string, Track>;
  /** Rejection explanations; callers keep appending selection rejections. */
  rejected: RejectionExplanation[];
  originalDescriptorFilters: DescriptorFilters | undefined;
  descriptorFilters: DescriptorFilters | undefined;
  relaxationSteps: number;
};

/** Filter the catalog into the planning pool: file/exclusion/rating/BPM/
 * descriptor/genre filters with bounded relaxation, the pool-too-small stop,
 * and pin readmission for required tracks and named start/end. */
export function buildPlanningPool(
  catalog: Track[],
  input: CreateSetPlanInput,
  options: {
    analyses: Map<string, TimelineAnalysis>;
    percentiles?: DescriptorPercentiles | null;
    requiredIds: string[];
    targetDurationMs: number;
  },
): PlanningPool {
  const { analyses } = options;
  const rejected: RejectionExplanation[] = [];
  const excludedIds = new Set(input.excludedTrackIds ?? []);
  const excludedArtists = new Set((input.excludedArtists ?? []).map((item) => item.toLowerCase()));
  const needed = Math.max(
    PLANNER_MIN_POOL_ESTIMATE,
    Math.ceil(options.targetDurationMs / typicalPlayable(catalog)),
  );
  const originalDescriptorFilters = resolveDescriptorFilters(
    input.descriptors,
    options.percentiles,
  );
  let descriptorFilters = originalDescriptorFilters;
  let relaxationSteps = 0;
  const filterCatalog = (filters: DescriptorFilters | undefined) =>
    catalog.filter((track) => {
      if (track.fileMissing) {
        rejected.push({ trackId: track.id, title: track.title, reason: "FILE_MISSING" });
        return false;
      }
      if (excludedIds.has(track.id)) {
        rejected.push({ trackId: track.id, title: track.title, reason: "EXCLUDED_ID" });
        return false;
      }
      const artist = artistKey(track);
      if (artist !== null && excludedArtists.has(artist)) {
        rejected.push({ trackId: track.id, title: track.title, reason: "EXCLUDED_ARTIST" });
        return false;
      }
      // minRating excludes explicitly-rated-bad material; UNRATED tracks pass.
      // The 2026-10 sessions showed the old null-rejecting semantics was a
      // footgun: a mostly-unrated crate emptied the pool on any minRating.
      // Search keeps rated-only browsing; the pool wants "exclude known bad".
      if (
        input.minRating !== undefined &&
        track.rating !== null &&
        track.rating < input.minRating
      ) {
        rejected.push({ trackId: track.id, title: track.title, reason: "BELOW_MIN_RATING" });
        return false;
      }
      // The owner's explicit "unmixable" verdict (rated after audition:
      // joins fine, song doesn't work in mixes). Unconditional — no brief
      // should have to opt out of a verdict the owner recorded by ear.
      if ((track.tags ?? []).some((tag) => tag.toLowerCase() === "unmixable")) {
        rejected.push({ trackId: track.id, title: track.title, reason: "UNMIXABLE_TAG" });
        return false;
      }
      const analysis = analyses.get(track.id);
      const bpm = track.bpm ?? analysis?.bpmHint ?? null;
      if (input.bpmMin !== undefined && (bpm === null || bpm < input.bpmMin)) {
        rejected.push({ trackId: track.id, title: track.title, reason: "BPM_BELOW_RANGE" });
        return false;
      }
      if (input.bpmMax !== undefined && (bpm === null || bpm > input.bpmMax)) {
        rejected.push({ trackId: track.id, title: track.title, reason: "BPM_ABOVE_RANGE" });
        return false;
      }
      // 2026-10 listening sessions: unstable grids (Half Light 0.175, Break
      // The Cycle 0.131) flamed every join despite clean stored residuals.
      // Explicit pins (start/end/required) still override this below.
      const stability = analysis?.tempoStability ?? null;
      if (stability != null && stability < PLANNER_MIN_TEMPO_STABILITY) {
        rejected.push({ trackId: track.id, title: track.title, reason: "UNSTABLE_GRID" });
        return false;
      }
      // DSP 3.12 grid-phase diagnostics: a suspect flag means the stored
      // grid phase disagrees with the track's own audio somewhere by more
      // than the trust threshold (measured October 2026: canuhearmenow? at
      // 55 ms and Pool Hopping - VIP at 82 ms both landed in one variety
      // plan and produced corroborated 60-140 ms join misalignments — the
      // stored-grid residual AND the deck-probe verifier agreed). Aligned
      // blends on such grids flammed. Confidence-aware: only exclude when
      // the catalog is large enough to be selective; a small library (or
      // one where every track is suspect) admits them rather than refusing
      // to plan. Explicit pins always pass.
      if (
        analysis?.descriptors?.gridPhaseSuspect === true &&
        catalog.length >= PLANNER_POOL_MIN_TRACKS * 2
      ) {
        rejected.push({ trackId: track.id, title: track.title, reason: "GRID_PHASE_SUSPECT" });
        return false;
      }
      const descriptors = analysis?.descriptors ?? null;
      const descriptorMatch = matchesDescriptorFilters(track, descriptors, filters);
      if (!descriptorMatch.ok) {
        rejected.push({
          trackId: track.id,
          title: track.title,
          reason: descriptorMatch.reason ?? "DESCRIPTOR_OUT_OF_RANGE",
        });
        return false;
      }
      const genreMatch = genresMatchFilter(track.genres, input.genres);
      if (!genreMatch.ok) {
        rejected.push({
          trackId: track.id,
          title: track.title,
          reason: genreMatch.reason ?? "GENRE_EXCLUDED",
        });
        return false;
      }
      return true;
    });

  let pool = filterCatalog(descriptorFilters);
  if (
    descriptorFilters &&
    catalog.length >= needed * PLANNER_POOL_RELAX_FACTOR &&
    pool.length < needed * PLANNER_POOL_RELAX_FACTOR
  ) {
    for (let step = 1; step <= 3 && pool.length < needed * PLANNER_POOL_RELAX_FACTOR; step += 1) {
      descriptorFilters = relaxDescriptorFilters(originalDescriptorFilters, step);
      relaxationSteps = step;
      pool = filterCatalog(descriptorFilters);
    }
    rejected.push({ trackId: "pool", title: "pool", reason: "POOL_RELAXED" });
  }
  if (pool.length <= PLANNER_POOL_MIN_TRACKS && catalog.length > PLANNER_POOL_MIN_TRACKS) {
    rejected.push({ trackId: "pool", title: "pool", reason: "POOL_TOO_SMALL" });
    pool = [];
  }

  const byId = new Map(pool.map((track) => [track.id, track]));
  // Explicit pins — required tracks, locked transition ends, and the named
  // start/end — override brief filters. Naming a closer must survive a
  // descriptor, mood, or genre filter that would otherwise drop it; only a
  // missing file or an explicit exclusion still rejects the pin.
  const pinLabels = new Map<string, string>();
  if (input.startTrackId) pinLabels.set(input.startTrackId, "start");
  if (input.endTrackId) pinLabels.set(input.endTrackId, "end");
  for (const id of options.requiredIds) pinLabels.set(id, "required");
  for (const [id, label] of pinLabels) {
    const found = catalog.find((track) => track.id === id);
    if (!found) {
      throw new Error(`TRACK_NOT_FOUND:${id}:${label}`);
    }
    if (found.fileMissing || excludedIds.has(id) || excludedArtists.has(artistKey(found) ?? "")) {
      throw new PlanningConstraintError(`Required ${label} track ${id} is excluded or missing`);
    }
    // An explicitly excluded genre contradicts the brief; a missing include
    // match (GENRE_MISMATCH) does not — the pin overrides it.
    if (genresMatchFilter(found.genres, input.genres).reason === "GENRE_EXCLUDED") {
      throw new PlanningConstraintError(`Required ${label} track ${id} is excluded or missing`);
    }
    if (!byId.has(id)) {
      byId.set(id, found);
      pool = [...pool, found];
    }
  }

  return {
    pool,
    byId,
    rejected,
    originalDescriptorFilters,
    descriptorFilters,
    relaxationSteps,
  };
}
