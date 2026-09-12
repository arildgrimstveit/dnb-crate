import {
  DEFAULT_ARTIST_REPEAT_SPACING,
  DEFAULT_TRANSITION_OVERLAP_MS,
  DURATION_TOLERANCE_MS,
  DURATION_QUALITY_WINDOW_MS,
  resolveTargetDurationMs,
  MIN_PLAYABLE_DURATION_MS,
  PLANNER_CANDIDATE_CAP,
  PLANNER_POOL_MIN_TRACKS,
  PLANNER_POOL_RELAX_FACTOR,
  genresMatchFilter,
  interpolateEnergy,
  matchesDescriptorFilters,
  normalizePersonName,
  resolveDescriptorFilters,
  pairKey,
  DJ_HANDOFF_POLICY,
  harmonicRelation,
  isConservativeHarmonic,
  resolveCanonicalKeyConfidence,
  scoreCandidate,
  hashSeed,
  type CreateSetPlanInput,
  type DescriptorFilters,
  type DescriptorPercentiles,
  type FeedbackIndex,
  type PlanExplanation,
  type RejectionExplanation,
  type SelectionScoreBuckets,
  type SetPlanEntry,
  type SetPlanV1,
  type Track,
} from "@dnb-crate/domain";

import { buildEntries, planDurationMs, playableMs, type TimelineAnalysis } from "./timeline.ts";
import { compilePlanningConstraints, PlanningConstraintError } from "./constraints.ts";
import { verifiesAppliedRecipe } from "./applied-recipe.ts";
import { repairSequence } from "./repair-search.ts";
import type { RecipeRecallLookup } from "./recall.ts";

const DEFAULT_ARC = [
  { atFraction: 0, targetEnergy: 3 },
  { atFraction: 0.75, targetEnergy: 9 },
  { atFraction: 1, targetEnergy: 6 },
];

function hasShortPlayable(entries: SetPlanEntry[], tracks: Track[]): boolean {
  const durations = new Map(tracks.map((track) => [track.id, track.durationMs]));
  return entries.some((entry) => {
    const durationMs = durations.get(entry.trackId) ?? 0;
    return durationMs >= MIN_PLAYABLE_DURATION_MS && playableMs(entry) < MIN_PLAYABLE_DURATION_MS;
  });
}

function typicalPlayable(tracks: Track[]): number {
  if (tracks.length === 0) {
    return 240_000;
  }
  const avg = tracks.reduce((sum, track) => sum + track.durationMs, 0) / tracks.length;
  return Math.max(avg - DEFAULT_TRANSITION_OVERLAP_MS, 60_000);
}

function artistKey(track: Track): string | null {
  if (track.artistCanonical) {
    return track.artistCanonical;
  }
  return track.artist ? normalizePersonName(track.artist) : null;
}

function respectsSpacing(track: Track, recent: Track[], spacing: number): boolean {
  if (spacing <= 0) {
    return true;
  }
  const key = artistKey(track);
  if (key === null) {
    return true;
  }
  return !recent.slice(-spacing).some((item) => artistKey(item) === key);
}

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

function playableFromAnalysis(track: Track, analysis?: TimelineAnalysis): number {
  if (
    analysis?.mixInMs != null &&
    analysis.mixOutMs != null &&
    analysis.mixOutMs > analysis.mixInMs
  ) {
    return analysis.mixOutMs - analysis.mixInMs;
  }
  return Math.max(track.durationMs - DEFAULT_TRANSITION_OVERLAP_MS, 0);
}

function scoreBuckets(
  breakdown: {
    components: {
      mood: number;
      subgenre: number;
      joinLevel: number;
      joinStructure: number;
      joinAligned: number;
      structure: number;
      harmonic: number;
      joinHarmonic: number;
      bpm: number;
      feedback: number;
    };
  },
  lookahead: number,
): SelectionScoreBuckets {
  const { components } = breakdown;
  return {
    moodFit: components.mood + components.subgenre,
    joinQuality:
      components.joinLevel +
      components.joinStructure +
      components.joinAligned +
      components.structure,
    keyCoverage: components.harmonic + components.joinHarmonic,
    timeFit: components.bpm,
    lookahead,
    feedback: components.feedback,
  };
}

export function draftSetPlan(
  catalog: Track[],
  input: CreateSetPlanInput,
  analyses: Map<string, TimelineAnalysis> = new Map(),
  options: {
    percentiles?: DescriptorPercentiles | null;
    feedback?: FeedbackIndex | null;
    recipes?: RecipeRecallLookup | null;
    varietyHistory?: {
      trackIds: string[];
      pairs: Array<{ outgoingTrackId: string; incomingTrackId: string }>;
    };
    /** Internal single retry with complete-chain candidates; keeps the user's brief and seed. */
    chainSearch?: boolean;
    /** Bounded alternate opener attempt; never changes the user's seed or constraints. */
    openerAttempt?: number;
  } = {},
): { plan: SetPlanV1; explanation: PlanExplanation; partial: boolean; partialReasons: string[] } {
  const seed = input.seed ?? 1;
  const targetDurationMs = resolveTargetDurationMs(input);
  const spacing = input.artistRepeatSpacing ?? DEFAULT_ARTIST_REPEAT_SPACING;
  const requestedArc = input.requestedArc ?? DEFAULT_ARC;
  const excludedIds = new Set(input.excludedTrackIds ?? []);
  const excludedArtists = new Set((input.excludedArtists ?? []).map((item) => item.toLowerCase()));
  const compiled = compilePlanningConstraints(input.requiredTransitions, {
    startTrackId: input.startTrackId,
    endTrackId: input.endTrackId,
  });
  const requiredIds = [...new Set([...(input.requiredTrackIds ?? []), ...compiled.lockedTrackIds])];
  const qualityPolicy = input.qualityPolicy ?? "strict";
  const partialReasons: string[] = [];
  const harmonicImportance = input.harmonicImportance ?? 1;
  const explorationWeight = input.explorationWeight ?? 0.65;
  const now = new Date().toISOString();
  const timingPlan = { rateRegionsVersion: 2 } as const;
  const varietyStrength = input.variety?.strength ?? 0.7;
  const historyIds = new Set(options.varietyHistory?.trackIds ?? []);
  const recordingOf = (id: string) => catalog.find((track) => track.id === id)?.recordingKey ?? id;
  const historyRecordings = new Set([...historyIds].map(recordingOf));
  const historyPairs = new Set(
    (options.varietyHistory?.pairs ?? []).map((pair) =>
      pairKey(recordingOf(pair.outgoingTrackId), recordingOf(pair.incomingTrackId)),
    ),
  );
  const rejected: RejectionExplanation[] = [];
  const needed = Math.max(16, Math.ceil(targetDurationMs / typicalPlayable(catalog)));
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
      if (
        input.minRating !== undefined &&
        (track.rating === null || track.rating < input.minRating)
      ) {
        rejected.push({ trackId: track.id, title: track.title, reason: "BELOW_MIN_RATING" });
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
  for (const id of compiled.lockedTrackIds) {
    const found = catalog.find((track) => track.id === id);
    if (
      found &&
      (found.fileMissing || excludedIds.has(id) || excludedArtists.has(artistKey(found) ?? ""))
    ) {
      throw new PlanningConstraintError(`Required track ${id} is excluded or missing`);
    }
    if (found && !byId.has(id)) {
      byId.set(id, found);
      pool = [...pool, found];
    }
  }
  const recipeLookup: RecipeRecallLookup = {
    listForPair: (outgoingTrackId, incomingTrackId) =>
      options.recipes?.listForPair(outgoingTrackId, incomingTrackId) ?? [],
    recipeIdForPair: (outgoingTrackId, incomingTrackId) =>
      compiled.recipeIdForPair(outgoingTrackId, incomingTrackId),
    reuseForPair: (outgoingTrackId, incomingTrackId) =>
      compiled.reuseForPair(outgoingTrackId, incomingTrackId),
  };
  const selectionQualityFailure = (tracks: Track[]): string | null => {
    if (qualityPolicy === "off" || tracks.length < 2) {
      return null;
    }
    const recordings = tracks.flatMap((track) => (track.recordingKey ? [track.recordingKey] : []));
    if (new Set(recordings).size !== recordings.length) return "DUPLICATE_RECORDING";
    const entries = rebuildEntriesOrNull(tracks);
    if (!entries) {
      return "TIMELINE";
    }
    if (tracks.some((track, i) => !respectsSpacing(track, tracks.slice(0, i), spacing)))
      return "ARTIST_SPACING";
    for (let i = 0; i < entries.length - 1; i += 1) {
      const outgoing = tracks[i]!;
      const incoming = tracks[i + 1]!;
      const requirement = compiled.constraintFor(outgoing.id, incoming.id);
      const record = recipeLookup
        .listForPair(outgoing.id, incoming.id)
        .find((row) => row.id === entries[i]?.transitionToNext?.parameters.appliedRecipeId);
      const applied =
        record != null &&
        verifiesAppliedRecipe(record, entries[i]!, entries[i + 1]!, outgoing, incoming);
      if (
        requirement?.reuse === "recipe" &&
        requirement.strength === "required" &&
        (!applied || (requirement.recipeId && requirement.recipeId !== record?.id))
      )
        return "EXACT_RECIPE";
      if (requirement?.allowQualityException) {
        continue;
      }
      const transition = entries[i]?.transitionToNext;
      if (applied) {
        continue;
      }
      if (!analyses.get(outgoing.id)?.gridOk || !analyses.get(incoming.id)?.gridOk)
        return "GRID_EVIDENCE";
      if (
        [outgoing, incoming].some(
          (track) =>
            resolveCanonicalKeyConfidence(track, {
              musicalKey: track.musicalKey,
              keyConfidence: analyses.get(track.id)?.keyConfidence ?? null,
            }) < 0.5,
        )
      )
        return "KEY_CONFIDENCE";
      if (transition?.type === "crossfade") {
        return "CROSSFADE";
      }
      if (!isConservativeHarmonic(harmonicRelation(outgoing.camelotKey, incoming.camelotKey))) {
        return "HARMONY";
      }
    }
    return null;
  };
  const selectionQualityOk = (tracks: Track[]) => selectionQualityFailure(tracks) === null;
  const joinAllowed = (source: Track | null, candidate: Track): boolean => {
    if (qualityPolicy === "off" || source == null) {
      return true;
    }
    const sourceIndex = selected.findLastIndex((track) => track.id === source.id);
    const base = sourceIndex >= 0 ? selected.slice(0, sourceIndex + 1) : [...selected];
    return selectionQualityOk([...base, candidate]);
  };
  const requireTrack = (id: string | undefined, label: string): Track | undefined => {
    if (!id) {
      return undefined;
    }
    const found = byId.get(id) ?? catalog.find((track) => track.id === id);
    if (!found) {
      throw new Error(`TRACK_NOT_FOUND:${id}:${label}`);
    }
    if (!byId.has(id)) {
      throw new Error(`TRACK_NOT_FOUND:${id}:${label}`);
    }
    return found;
  };

  const start = requireTrack(input.startTrackId, "start");
  const ending = requireTrack(input.endTrackId, "end");
  for (const id of requiredIds) {
    requireTrack(id, "required");
  }

  const selected: Track[] = [];
  const used = new Set<string>();
  const usedRecordings = new Set<string>();
  const pick = (track: Track) => {
    selected.push(track);
    used.add(track.id);
    if (track.recordingKey) {
      usedRecordings.add(track.recordingKey);
    }
  };

  if (start) {
    pick(start);
  }

  const lookaheadById = new Map<string, number>();
  const requiredProgressById = new Map<string, number>();
  const reservedEnd = ending && ending.id !== start?.id ? ending : undefined;
  const remainingRequired = () =>
    requiredIds.filter((id) => !used.has(id) && id !== reservedEnd?.id);

  const chainFrom = (track: Track): Track[] => {
    const chain = [track];
    let row = compiled.successorOf.get(track.id);
    while (row) {
      const next = byId.get(row.incomingTrackId);
      if (!next) break;
      chain.push(next);
      row = compiled.successorOf.get(next.id);
    }
    return chain;
  };
  // Key reachability is a ranking hint only; actual timeline/evidence gates still decide.
  const keyDistances = new Map<string, Map<string, number>>();
  for (const id of requiredIds.filter((id) => !compiled.reservedIncoming.has(id))) {
    const key = byId.get(id)?.camelotKey;
    if (!key) continue;
    const distance = new Map<string, number>([[key, 0]]);
    const keys = [
      ...new Set(pool.flatMap((track) => (track.camelotKey ? [track.camelotKey] : []))),
    ];
    const queue = [key];
    for (let i = 0; i < queue.length; i++) {
      for (const candidate of keys) {
        if (
          !distance.has(candidate) &&
          isConservativeHarmonic(harmonicRelation(queue[i]!, candidate))
        ) {
          distance.set(candidate, distance.get(queue[i]!)! + 1);
          queue.push(candidate);
        }
      }
    }
    keyDistances.set(id, distance);
  }
  const requiredProgressBonus = (track: Track) => {
    if (!options.chainSearch) return 0;
    const distances = remainingRequired()
      .filter((id) => !compiled.reservedIncoming.has(id))
      .map((id) => keyDistances.get(id)?.get(track.camelotKey ?? "") ?? Infinity);
    return distances.length
      ? (remainingRequired().includes(track.id) ? 100 : 0) + 100 / (1 + Math.min(...distances))
      : 0;
  };

  const scoreFor = (candidate: Track, source: Track | null, fraction: number) => {
    const candA = analyses.get(candidate.id);
    const srcA = source ? analyses.get(source.id) : undefined;
    const dropBars =
      candA?.sections
        ?.filter((section) => section.type === "drop")
        .reduce((max, section) => {
          const bars =
            section.startBar != null && section.endBar != null
              ? section.endBar - section.startBar
              : 0;
          return Math.max(max, bars);
        }, 0) ?? 0;
    const quietTail = (srcA?.sections ?? []).some(
      (section) =>
        (section.type === "outro" || section.type === "breakdown") && section.sectionEnergy <= 0.5,
    );
    const score = scoreCandidate({
      source,
      candidate,
      targetEnergy: interpolateEnergy(requestedArc, fraction),
      direction: "any",
      preferredMoods: input.preferredMoods ?? [],
      preferredSubgenres: input.preferredSubgenres ?? [],
      preferredTags: input.preferredTags ?? [],
      preferredArtists: input.preferredArtists ?? [],
      recentArtistIds: selected.map(artistKey),
      artistRepeatSpacing: spacing,
      harmonicImportance,
      explorationWeight,
      seed,
      alreadyUsed: used.has(candidate.id),
      suggestedEnergy: candA?.suggestedEnergy ?? candA?.descriptors?.suggestedEnergy ?? null,
      sourceSuggestedEnergy: srcA?.suggestedEnergy ?? srcA?.descriptors?.suggestedEnergy ?? null,
      outgoingOutroMs: srcA?.outroLenMs ?? null,
      incomingIntroMs: candA?.introLenMs ?? null,
      bpmHint: candA?.bpmHint ?? null,
      sourceBpmHint: srcA?.bpmHint ?? null,
      descriptors: candA?.descriptors ?? null,
      sourceDescriptors: srcA?.descriptors ?? null,
      candidateLufs: candA?.integratedLufs ?? null,
      sourceLufs: srcA?.integratedLufs ?? null,
      candidateKeyConfidence: resolveCanonicalKeyConfidence(candidate, {
        musicalKey: candidate.musicalKey,
        keyConfidence: candA?.keyConfidence ?? null,
      }),
      sourceKeyConfidence: source
        ? resolveCanonicalKeyConfidence(source, {
            musicalKey: source.musicalKey,
            keyConfidence: srcA?.keyConfidence ?? null,
          })
        : 0,
      feedbackBonus:
        source && options.feedback
          ? Math.min(0, options.feedback.byPair.get(pairKey(source.id, candidate.id))?.bonus ?? 0)
          : 0,
      candidateGridOk: candA?.gridOk ?? false,
      sourceGridOk: srcA?.gridOk ?? false,
      candidateDropBars: dropBars,
      sourceQuietTail: quietTail,
      candidateGenres: candidate.genres,
    });
    const repeatedTrack = historyRecordings.has(candidate.recordingKey ?? candidate.id);
    const repeatedPair =
      source != null &&
      historyPairs.has(
        pairKey(source.recordingKey ?? source.id, candidate.recordingKey ?? candidate.id),
      );
    const cost = varietyStrength * ((repeatedTrack ? 8 : 0) + (repeatedPair ? 4 : 0));
    score.components.recentlyUsed -= cost;
    score.total -= cost;
    if (repeatedTrack) score.reasons.push("RECENT_MIX_RECORDING");
    if (repeatedPair) score.reasons.push("RECENT_MIX_PAIR");
    return score;
  };

  const rebuildEntries = (tracks: Track[]) =>
    buildEntries(
      tracks.map((track) => ({
        ...track,
        analysis: analyses.get(track.id) ?? null,
        fileFingerprint: track.fileFingerprint,
        title: track.title,
      })),
      undefined,
      undefined,
      {
        dropAnchored: input.dropAnchored,
        targetBpm: input.targetBpm,
        recall: recipeLookup,
      },
    );
  const rebuildEntriesOrNull = (tracks: Track[]) => {
    try {
      return rebuildEntries(tracks);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("native body") || error.message.includes("Invalid rate-region"))
      ) {
        return null;
      }
      throw error;
    }
  };
  const avgPlayable = typicalPlayable(pool);
  let safety = 0;
  while (safety < PLANNER_CANDIDATE_CAP) {
    safety += 1;
    const currentDuration = planDurationMs(rebuildEntries(selected), timingPlan);
    const reservedDuration = reservedEnd
      ? playableFromAnalysis(reservedEnd, analyses.get(reservedEnd.id))
      : 0;
    if (
      currentDuration + reservedDuration >= targetDurationMs - DURATION_TOLERANCE_MS &&
      remainingRequired().length === 0
    ) {
      break;
    }
    const source = selected[selected.length - 1] ?? null;
    if (source) {
      const requiredNext = compiled.successorOf.get(source.id);
      if (requiredNext) {
        const incoming =
          byId.get(requiredNext.incomingTrackId) ??
          catalog.find((track) => track.id === requiredNext.incomingTrackId);
        const allowed =
          incoming != null &&
          !used.has(incoming.id) &&
          !incoming.fileMissing &&
          !excludedIds.has(incoming.id) &&
          !excludedArtists.has(artistKey(incoming) ?? "") &&
          joinAllowed(source, incoming);
        if (!incoming || used.has(incoming.id) || !allowed) {
          partialReasons.push("REQUIRED_TRANSITION_UNSATISFIED");
          rejected.push({
            trackId: requiredNext.incomingTrackId,
            title: incoming?.title ?? requiredNext.incomingTrackId,
            reason: "REQUIRED_TRANSITION_UNSATISFIED",
          });
          break;
        }
        const trial = [...selected, incoming];
        const requiredEntries = rebuildEntriesOrNull(trial);
        if (!requiredEntries || hasShortPlayable(requiredEntries, trial)) {
          partialReasons.push("REQUIRED_TRANSITION_UNSATISFIED");
          rejected.push({ trackId: incoming.id, title: incoming.title, reason: "SHORT_WINDOW" });
          break;
        }
        pick(incoming);
        continue;
      }
      const preferredNext = compiled.preferredSuccessorOf.get(source.id);
      if (preferredNext) {
        const incoming =
          byId.get(preferredNext.incomingTrackId) ??
          catalog.find((track) => track.id === preferredNext.incomingTrackId);
        const allowed =
          incoming != null &&
          !used.has(incoming.id) &&
          byId.has(incoming.id) &&
          !compiled.reservedIncoming.has(incoming.id) &&
          joinAllowed(source, incoming);
        if (incoming && allowed) {
          const trial = [...selected, incoming];
          const preferredEntries = rebuildEntriesOrNull(trial);
          if (preferredEntries && !hasShortPlayable(preferredEntries, trial)) {
            pick(incoming);
            continue;
          }
        }
        rejected.push({
          trackId: preferredNext.incomingTrackId,
          title: incoming?.title ?? preferredNext.incomingTrackId,
          reason: "PREFERRED_TRANSITION_DROPPED",
        });
      }
    }
    const fraction = Math.min(currentDuration / Math.max(targetDurationMs, 1), 1);
    let candidates = pool.filter((track) => {
      if (used.has(track.id) || track.id === reservedEnd?.id) {
        return false;
      }
      if (compiled.reservedIncoming.has(track.id)) {
        return false;
      }
      if (track.recordingKey && usedRecordings.has(track.recordingKey)) {
        rejected.push({ trackId: track.id, title: track.title, reason: "DUPLICATE_RECORDING" });
        return false;
      }
      return true;
    });
    if (candidates.length === 0) {
      break;
    }
    const requiredLeft = remainingRequired().filter((id) => !compiled.reservedIncoming.has(id));
    const picksLeftEstimate = Math.max(
      requiredLeft.length,
      Math.ceil(Math.max(targetDurationMs - currentDuration - reservedDuration, 0) / avgPlayable),
    );
    if (requiredLeft.length > 0 && requiredLeft.length >= picksLeftEstimate) {
      const forced = candidates.filter((track) => {
        if (!requiredLeft.includes(track.id)) return false;
        return options.chainSearch
          ? chainFrom(track).every((item) => !used.has(item.id)) &&
              selectionQualityOk([...selected, ...chainFrom(track)])
          : joinAllowed(source, track);
      });
      if (forced.length > 0) {
        candidates = forced;
      } else if (!options.chainSearch) {
        candidates = candidates.filter((track) => requiredLeft.includes(track.id));
      }
    }
    const spaced = candidates.filter((track) => respectsSpacing(track, selected, spacing));
    if (qualityPolicy === "strict" && spaced.length === 0) {
      partialReasons.push("ARTIST_SPACING");
      rejected.push({ trackId: "pool", title: "pool", reason: "ARTIST_SPACING" });
      break;
    }
    const qualityFiltered =
      qualityPolicy === "strict"
        ? spaced.filter((track) =>
            options.chainSearch
              ? chainFrom(track).every((item) => !used.has(item.id)) &&
                selectionQualityOk([...selected, ...chainFrom(track)])
              : joinAllowed(source, track),
          )
        : spaced.length > 0
          ? spaced
          : candidates;
    if (qualityPolicy === "strict" && qualityFiltered.length === 0) {
      partialReasons.push("QUALITY_JOIN");
      rejected.push({ trackId: "pool", title: "pool", reason: "QUALITY_JOIN" });
      break;
    }
    const usable = qualityFiltered;
    const ranked = usable
      .filter(
        (track) =>
          source != null ||
          qualityPolicy !== "strict" ||
          requiredIds.includes(track.id) ||
          (analyses.get(track.id)?.gridOk &&
            track.camelotKey != null &&
            resolveCanonicalKeyConfidence(track, {
              musicalKey: track.musicalKey,
              keyConfidence: analyses.get(track.id)?.keyConfidence ?? null,
            }) >= 0.5),
      )
      .map((track) => ({
        track,
        breakdown: scoreFor(track, source, fraction),
        lookahead: 0,
        requiredProgress: requiredProgressBonus(track),
      }))
      .sort(
        (a, b) =>
          b.breakdown.total + b.requiredProgress - a.breakdown.total - a.requiredProgress ||
          a.track.id.localeCompare(b.track.id),
      );
    const top = ranked.slice(0, 12);
    const nextFraction = Math.min(
      (currentDuration + avgPlayable) / Math.max(targetDurationMs, 1),
      1,
    );
    for (const item of top) {
      const nextCandidates = usable
        .filter((track) => {
          if (track.id === item.track.id) {
            return false;
          }
          if (track.recordingKey && track.recordingKey === item.track.recordingKey) {
            return false;
          }
          return true;
        })
        .map((track) => ({ track, score: scoreFor(track, item.track, nextFraction).total }))
        .sort((a, b) => b.score - a.score);
      if (qualityPolicy === "strict") {
        // Score a continuation that can actually host both joins, rather than metadata alone.
        const continuation = nextCandidates
          .slice(0, 8)
          .find(({ track }) =>
            selectionQualityOk([...selected, ...chainFrom(item.track), ...chainFrom(track)]),
          );
        item.lookahead = continuation?.score ?? 0;
      } else item.lookahead = nextCandidates[0]?.score ?? 0;
    }
    top.sort(
      (a, b) =>
        b.breakdown.total +
          b.requiredProgress +
          0.35 * (b.lookahead ?? 0) -
          (a.breakdown.total + a.requiredProgress + 0.35 * (a.lookahead ?? 0)) ||
        a.track.id.localeCompare(b.track.id),
    );
    if (explorationWeight > 0 && top.length > 1) {
      const merit = (item: (typeof top)[number]) =>
        item.breakdown.total + item.requiredProgress + 0.35 * item.lookahead;
      const best = merit(top[0]!);
      const near = top.filter((item) => best - merit(item) <= 4 * explorationWeight);
      const draw = (item: (typeof top)[number]) =>
        -Math.log(
          Math.max(
            1e-9,
            hashSeed(seed, `${selected.length}:${source?.id ?? "opener"}:${item.track.id}`),
          ),
        ) / Math.exp((merit(item) - best) / Math.max(0.1, explorationWeight));
      near.sort((a, b) => draw(a) - draw(b) || a.track.id.localeCompare(b.track.id));
      top.splice(0, top.length, ...near, ...top.filter((item) => !near.includes(item)));
    }
    const ordered = [
      ...top,
      ...ranked.filter((item) => !top.some((lead) => lead.track.id === item.track.id)),
    ];
    if (!source && options.openerAttempt && ordered[options.openerAttempt]) {
      ordered.unshift(...ordered.splice(options.openerAttempt, 1));
    }
    let next: (typeof ordered)[number] | undefined;
    for (const item of ordered) {
      const trial = [...selected, ...(options.chainSearch ? chainFrom(item.track) : [item.track])];
      const trialEntries = rebuildEntriesOrNull(trial);
      if (!trialEntries || hasShortPlayable(trialEntries, trial)) {
        rejected.push({ trackId: item.track.id, title: item.track.title, reason: "SHORT_WINDOW" });
        continue;
      }
      next = item;
      break;
    }
    if (!next) {
      break;
    }
    lookaheadById.set(next.track.id, next.lookahead ?? 0);
    requiredProgressById.set(next.track.id, next.requiredProgress);
    for (const track of options.chainSearch ? chainFrom(next.track) : [next.track]) pick(track);
    if (reservedEnd && used.has(reservedEnd.id)) {
      break;
    }
  }

  if (reservedEnd && !used.has(reservedEnd.id)) {
    const trial = [...selected, reservedEnd];
    if (selectionQualityOk(trial)) pick(reservedEnd);
    else partialReasons.push("ENDING_INFEASIBLE");
  }

  for (const id of remainingRequired()) {
    if (compiled.reservedIncoming.has(id) && !used.has(id)) {
      partialReasons.push("REQUIRED_TRANSITION_UNSATISFIED");
      continue;
    }
    const track = byId.get(id);
    if (track && !used.has(id)) {
      const insertAt =
        reservedEnd && selected[selected.length - 1]?.id === reservedEnd.id
          ? selected.length - 1
          : selected.length;
      const trial = [...selected];
      trial.splice(insertAt, 0, track);
      if (selectionQualityOk(trial)) {
        selected.splice(insertAt, 0, track);
        used.add(id);
      } else partialReasons.push("REQUIRED_TRANSITION_UNSATISFIED");
    }
  }

  const requiredSet = new Set([...requiredIds, ...compiled.lockedTrackIds]);
  let entries = rebuildEntries(selected);
  let duration = planDurationMs(entries, timingPlan);
  const trimOvershoot = () => {
    while (duration > targetDurationMs + DURATION_TOLERANCE_MS && selected.length > 2) {
      const dropIndex = selected.findLastIndex(
        (track, index) =>
          index > 0 &&
          track.id !== reservedEnd?.id &&
          !requiredSet.has(track.id) &&
          track.id !== start?.id &&
          selectionQualityOk(selected.filter((_, candidateIndex) => candidateIndex !== index)),
      );
      if (dropIndex <= 0) {
        break;
      }
      const removed = selected.splice(dropIndex, 1)[0];
      if (removed) {
        used.delete(removed.id);
        if (removed.recordingKey) {
          usedRecordings.delete(removed.recordingKey);
        }
      }
      entries = rebuildEntries(selected);
      duration = planDurationMs(entries, timingPlan);
    }
  };
  trimOvershoot();
  if (duration + DURATION_TOLERANCE_MS < targetDurationMs) {
    const extras = pool.filter((track) => {
      if (used.has(track.id) || track.id === reservedEnd?.id) {
        return false;
      }
      if (compiled.reservedIncoming.has(track.id)) {
        return false;
      }
      if (track.recordingKey && usedRecordings.has(track.recordingKey)) {
        return false;
      }
      if (qualityPolicy === "strict") {
        const neighbor =
          selected[selected.length - (reservedEnd && used.has(reservedEnd.id) ? 2 : 1)] ?? null;
        if (!respectsSpacing(track, selected, spacing) || !joinAllowed(neighbor, track)) {
          return false;
        }
      }
      return true;
    });
    const source =
      selected[selected.length - (reservedEnd && used.has(reservedEnd.id) ? 2 : 1)] ?? null;
    extras.sort(
      (a, b) =>
        scoreFor(b, source, 1).total - scoreFor(a, source, 1).total || a.id.localeCompare(b.id),
    );
    const insertAt =
      reservedEnd && selected[selected.length - 1]?.id === reservedEnd.id
        ? selected.length - 1
        : selected.length;
    for (const extra of extras) {
      if (duration + DURATION_TOLERANCE_MS >= targetDurationMs) {
        break;
      }
      const trial = [...selected];
      trial.splice(insertAt, 0, extra);
      const trialEntries = rebuildEntriesOrNull(trial);
      if (!trialEntries || hasShortPlayable(trialEntries, trial)) {
        rejected.push({ trackId: extra.id, title: extra.title, reason: "SHORT_WINDOW" });
        continue;
      }
      if (!selectionQualityOk(trial)) {
        rejected.push({ trackId: extra.id, title: extra.title, reason: "QUALITY_JOIN" });
        continue;
      }
      selected.splice(insertAt, 0, extra);
      entries = trialEntries;
      duration = planDurationMs(entries, timingPlan);
      if (duration > targetDurationMs + DURATION_TOLERANCE_MS) {
        selected.splice(insertAt, 1);
        entries = rebuildEntries(selected);
        duration = planDurationMs(entries, timingPlan);
        break;
      }
      used.add(extra.id);
      if (extra.recordingKey) {
        usedRecordings.add(extra.recordingKey);
      }
    }
  }
  trimOvershoot();
  const minDuration = targetDurationMs - DURATION_TOLERANCE_MS;
  const maxDuration = targetDurationMs + DURATION_TOLERANCE_MS;
  const requiredSatisfied = (tracks: Track[]) =>
    requiredIds.every((id) => tracks.some((track) => track.id === id)) &&
    [...compiled.successorOf].every(([id, row]) => {
      const index = tracks.findIndex((track) => track.id === id);
      return index >= 0 && tracks[index + 1]?.id === row.incomingTrackId;
    });
  let repairSearch: ReturnType<typeof repairSequence>["diagnostics"] | undefined;
  if (
    qualityPolicy === "strict" &&
    (duration < minDuration || duration > maxDuration || !requiredSatisfied(selected))
  ) {
    const units: string[][] = [];
    for (const track of pool) {
      if (compiled.reservedIncoming.has(track.id)) continue;
      if (
        !requiredIds.includes(track.id) &&
        (!analyses.get(track.id)?.gridOk ||
          resolveCanonicalKeyConfidence(track, {
            musicalKey: track.musicalKey,
            keyConfidence: analyses.get(track.id)?.keyConfidence ?? null,
          }) < 0.5)
      )
        continue;
      const unit = [track.id];
      let next = compiled.successorOf.get(track.id);
      while (next) {
        unit.push(next.incomingTrackId);
        next = compiled.successorOf.get(next.incomingTrackId);
      }
      units.push(unit);
    }
    const repaired = repairSequence({
      initial: selected.map((track) => track.id),
      units,
      required: new Set([
        ...requiredIds,
        ...(start ? [start.id] : []),
        ...(ending ? [ending.id] : []),
      ]),
      start: start?.id,
      end: ending?.id,
      minDurationMs: minDuration,
      maxDurationMs: maxDuration,
      evaluate(ids) {
        const tracks = ids.map((id) => byId.get(id)!);
        const recordings = tracks.flatMap((track) =>
          track.recordingKey ? [track.recordingKey] : [],
        );
        if (new Set(recordings).size !== recordings.length) return "DUPLICATE_RECORDING";
        const failure = selectionQualityFailure(tracks);
        if (failure) return failure;
        const trial = rebuildEntriesOrNull(tracks);
        if (!trial || hasShortPlayable(trial, tracks)) return "SHORT_WINDOW";
        return planDurationMs(trial, timingPlan);
      },
      rankOptional(unit, ids) {
        const first = byId.get(unit[0]!);
        let harmonic = 0;
        for (const id of ids) {
          const neighbor = byId.get(id);
          if (
            neighbor &&
            isConservativeHarmonic(harmonicRelation(neighbor.camelotKey, first?.camelotKey ?? null))
          ) {
            harmonic += 2;
          }
        }
        const missingRoots = requiredIds.filter(
          (id) => !ids.includes(id) && !compiled.reservedIncoming.has(id),
        );
        let progress = 0;
        for (const id of missingRoots) {
          const dist =
            keyDistances.get(id)?.get(first?.camelotKey ?? "") ?? Number.POSITIVE_INFINITY;
          progress += 50 / (1 + dist);
        }
        return harmonic + progress;
      },
      musicalScore(ids) {
        const tracks = ids
          .map((id) => byId.get(id))
          .filter((track): track is Track => track != null);
        let total = 0;
        for (let i = 0; i < tracks.length; i += 1) {
          const fraction = tracks.length <= 1 ? 0 : i / (tracks.length - 1);
          total += scoreFor(tracks[i]!, tracks[i - 1] ?? null, fraction).total;
        }
        return total;
      },
      compatible(leftId, rightId) {
        return isConservativeHarmonic(
          harmonicRelation(
            byId.get(leftId)?.camelotKey ?? null,
            byId.get(rightId)?.camelotKey ?? null,
          ),
        );
      },
    });
    repairSearch = repaired.diagnostics;
    const trial = repaired.ids.map((id) => byId.get(id)!);
    // Preserve the old result unless the repair actually improves hard requirements or duration.
    const oldMissing = requiredIds.filter(
      (id) => !selected.some((track) => track.id === id),
    ).length;
    const newMissing = requiredIds.filter((id) => !repaired.ids.includes(id)).length;
    const oldDistance = Math.max(minDuration - duration, duration - maxDuration, 0);
    if (
      repairSearch.status === "ready" ||
      newMissing < oldMissing ||
      (newMissing === oldMissing &&
        repairSearch.durationDistanceMs != null &&
        repairSearch.durationDistanceMs < oldDistance)
    ) {
      selected.splice(0, selected.length, ...trial);
      used.clear();
      usedRecordings.clear();
      for (const track of selected) {
        used.add(track.id);
        if (track.recordingKey) usedRecordings.add(track.recordingKey);
      }
      entries = rebuildEntries(selected);
      duration = planDurationMs(entries, timingPlan);
      if (requiredSatisfied(selected) && duration >= minDuration && duration <= maxDuration)
        partialReasons.length = 0;
    }
  }
  const durationOffQuality =
    duration + DURATION_QUALITY_WINDOW_MS < targetDurationMs ||
    duration > targetDurationMs + DURATION_QUALITY_WINDOW_MS;
  const partial = durationOffQuality || remainingRequired().length > 0 || partialReasons.length > 0;

  let chainRetry: PlanExplanation["chainRetry"];
  if (!options.chainSearch && qualityPolicy === "strict" && !requiredSatisfied(selected)) {
    const retry = draftSetPlan(catalog, input, analyses, { ...options, chainSearch: true });
    const retryDuration = planDurationMs(retry.plan.entries, timingPlan);
    chainRetry = {
      durationMs: retryDuration,
      partialReasons: retry.partialReasons,
      missingRequiredTransitions: [...compiled.successorOf]
        .filter(([id, row]) => {
          const index = retry.plan.entries.findIndex((entry) => entry.trackId === id);
          return index < 0 || retry.plan.entries[index + 1]?.trackId !== row.incomingTrackId;
        })
        .map(([id, row]) => `${id}->${row.incomingTrackId}`),
      trackIds: retry.plan.entries.map((entry) => entry.trackId),
      repairSearch: retry.explanation.repairSearch,
      priorRepairSearch: repairSearch,
    };
    if (
      (!retry.partial && retryDuration >= minDuration && retryDuration <= maxDuration) ||
      (chainRetry.missingRequiredTransitions.length === 0 &&
        requiredIds.every((id) => chainRetry!.trackIds.includes(id)))
    ) {
      retry.explanation.chainRetry = chainRetry;
      return retry;
    }
  }

  const plan: SetPlanV1 = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: input.name,
    targetDurationMs,
    targetBpm: input.targetBpm ?? null,
    requestedArc,
    entries,
    createdAt: now,
    updatedAt: now,
    handoffPolicy: DJ_HANDOFF_POLICY,
    rateRegionsVersion: 2,
    qualityPolicy,
    planningConstraints: {
      startTrackId: input.startTrackId,
      endTrackId: input.endTrackId,
      requiredTrackIds: input.requiredTrackIds,
      excludedTrackIds: input.excludedTrackIds,
      excludedArtists: input.excludedArtists,
      requiredTransitions: compiled.requiredTransitions,
      artistRepeatSpacing: spacing,
    },
  };

  const totalJoins = Math.max(selected.length - 1, 0);
  let knownJoins = 0;
  for (let i = 0; i < totalJoins; i += 1) {
    if (selected[i]?.camelotKey && selected[i + 1]?.camelotKey) {
      knownJoins += 1;
    }
  }
  const explanation: PlanExplanation = {
    ...(input.variety
      ? {
          variety: {
            referencePlanIds: input.variety.referencePlanIds,
            strength: varietyStrength,
            trackIds: [...historyIds],
            pairs: options.varietyHistory?.pairs ?? [],
            repeatedTracks: selected.filter((track) =>
              historyRecordings.has(track.recordingKey ?? track.id),
            ).length,
            repeatedPairs: selected
              .slice(1)
              .filter((track, i) =>
                historyPairs.has(
                  pairKey(
                    selected[i]!.recordingKey ?? selected[i]!.id,
                    track.recordingKey ?? track.id,
                  ),
                ),
              ).length,
          },
        }
      : {}),
    seed,
    selected: selected.map((track, order) => {
      const score = scoreFor(
        track,
        selected[order - 1] ?? null,
        selected.length <= 1 ? 0 : order / (selected.length - 1),
      );
      const lookahead = lookaheadById.get(track.id) ?? 0;
      return {
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        order,
        score,
        lookahead,
        requiredProgress: requiredProgressById.get(track.id) ?? 0,
        buckets: scoreBuckets(score, lookahead),
      };
    }),
    rejected: rejected.slice(0, 50),
    harmonicCoverage: { knownJoins, totalJoins },
    originalDescriptors: originalDescriptorFilters ?? null,
    resolvedDescriptors: descriptorFilters ?? null,
    relaxationSteps,
    repairSearch,
    chainRetry,
  };

  let result = { plan, explanation, partial, partialReasons };
  if (
    qualityPolicy === "strict" &&
    !input.startTrackId &&
    !options.openerAttempt &&
    !options.chainSearch &&
    (partial || duration < minDuration || duration > maxDuration)
  ) {
    const distance = (candidate: typeof result) => {
      const actual = planDurationMs(candidate.plan.entries, timingPlan);
      const missing = requiredIds.filter(
        (id) => !candidate.plan.entries.some((entry) => entry.trackId === id),
      ).length;
      const missingPairs = [...compiled.successorOf].filter(([id, requirement]) => {
        const index = candidate.plan.entries.findIndex((entry) => entry.trackId === id);
        return (
          index < 0 || candidate.plan.entries[index + 1]?.trackId !== requirement.incomingTrackId
        );
      }).length;
      return (
        (missing + missingPairs) * targetDurationMs +
        Math.max(minDuration - actual, actual - maxDuration, 0)
      );
    };
    const attempts = [{ openerTrackId: plan.entries[0]?.trackId ?? null, durationMs: duration }];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const alternative = draftSetPlan(catalog, input, analyses, {
        ...options,
        openerAttempt: attempt,
      });
      const actual = planDurationMs(alternative.plan.entries, timingPlan);
      attempts.push({
        openerTrackId: alternative.plan.entries[0]?.trackId ?? null,
        durationMs: actual,
      });
      if (
        distance(alternative) < distance(result) ||
        (distance(alternative) === distance(result) && result.partial && !alternative.partial)
      )
        result = alternative;
      if (!result.partial && distance(result) === 0) break;
    }
    result.explanation.openerSearch = attempts;
  }
  return result;
}
