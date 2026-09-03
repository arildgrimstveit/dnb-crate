import {
  DEFAULT_ARTIST_REPEAT_SPACING,
  DEFAULT_TARGET_DURATION_MS,
  DEFAULT_TRANSITION_OVERLAP_MS,
  DURATION_TOLERANCE_MS,
  PLANNER_CANDIDATE_CAP,
  genresMatchFilter,
  interpolateEnergy,
  matchesDescriptorFilters,
  normalizePersonName,
  scoreCandidate,
  type CreateSetPlanInput,
  type PlanExplanation,
  type RejectionExplanation,
  type SetPlanV1,
  type Track,
} from "@dnb-crate/domain";

import { buildEntries, planDurationMs, type TimelineAnalysis } from "./timeline.ts";

const DEFAULT_ARC = [
  { atFraction: 0, targetEnergy: 3 },
  { atFraction: 0.75, targetEnergy: 9 },
  { atFraction: 1, targetEnergy: 6 },
];

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

export function draftSetPlan(
  catalog: Track[],
  input: CreateSetPlanInput,
  analyses: Map<string, TimelineAnalysis> = new Map(),
): { plan: SetPlanV1; explanation: PlanExplanation; partial: boolean } {
  const seed = input.seed ?? 1;
  const targetDurationMs = input.targetDurationMs ?? DEFAULT_TARGET_DURATION_MS;
  const spacing = input.artistRepeatSpacing ?? DEFAULT_ARTIST_REPEAT_SPACING;
  const requestedArc = input.requestedArc ?? DEFAULT_ARC;
  const excludedIds = new Set(input.excludedTrackIds ?? []);
  const excludedArtists = new Set((input.excludedArtists ?? []).map((item) => item.toLowerCase()));
  const requiredIds = [...new Set(input.requiredTrackIds ?? [])];
  const harmonicImportance = input.harmonicImportance ?? 1;
  const explorationWeight = input.explorationWeight ?? 0.2;
  const now = new Date().toISOString();
  const rejected: RejectionExplanation[] = [];

  const pool = catalog.filter((track) => {
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
    const descriptorMatch = matchesDescriptorFilters(track, descriptors, input.descriptors);
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

  const byId = new Map(pool.map((track) => [track.id, track]));
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

  const reservedEnd = ending && ending.id !== start?.id ? ending : undefined;
  const remainingRequired = () =>
    requiredIds.filter((id) => !used.has(id) && id !== reservedEnd?.id);

  const scoreFor = (candidate: Track, source: Track | null, fraction: number) => {
    const candA = analyses.get(candidate.id);
    const srcA = source ? analyses.get(source.id) : undefined;
    return scoreCandidate({
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
    });
  };

  const avgPlayable = typicalPlayable(pool);
  let safety = 0;
  while (safety < PLANNER_CANDIDATE_CAP) {
    safety += 1;
    const currentDuration = planDurationMs(
      buildEntries(selected.map((track) => ({ ...track, analysis: analyses.get(track.id) ?? null }))),
    );
    const reservedDuration = reservedEnd
      ? Math.max(reservedEnd.durationMs - DEFAULT_TRANSITION_OVERLAP_MS, 0)
      : 0;
    if (
      currentDuration + reservedDuration >= targetDurationMs - DURATION_TOLERANCE_MS &&
      remainingRequired().length === 0
    ) {
      break;
    }
    const source = selected[selected.length - 1] ?? null;
    const fraction = Math.min(currentDuration / Math.max(targetDurationMs, 1), 1);
    let candidates = pool.filter((track) => {
      if (used.has(track.id) || track.id === reservedEnd?.id) {
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
    const requiredLeft = remainingRequired();
    const picksLeftEstimate = Math.max(
      requiredLeft.length,
      Math.ceil(Math.max(targetDurationMs - currentDuration - reservedDuration, 0) / avgPlayable),
    );
    if (requiredLeft.length > 0 && requiredLeft.length >= picksLeftEstimate) {
      candidates = candidates.filter((track) => requiredLeft.includes(track.id));
    }
    const spaced = candidates.filter((track) => respectsSpacing(track, selected, spacing));
    const usable = spaced.length > 0 ? spaced : candidates;
    usable.sort((a, b) => {
      const scoreA = scoreFor(a, source, fraction).total;
      const scoreB = scoreFor(b, source, fraction).total;
      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }
      return a.id.localeCompare(b.id);
    });
    const next = usable[0];
    if (!next) {
      break;
    }
    pick(next);
    if (reservedEnd && used.has(reservedEnd.id)) {
      break;
    }
  }

  if (reservedEnd && !used.has(reservedEnd.id)) {
    pick(reservedEnd);
  }

  for (const id of remainingRequired()) {
    const track = byId.get(id);
    if (track && !used.has(id)) {
      const insertAt =
        reservedEnd && selected[selected.length - 1]?.id === reservedEnd.id
          ? selected.length - 1
          : selected.length;
      selected.splice(insertAt, 0, track);
      used.add(id);
    }
  }

  const entries = buildEntries(
    selected.map((track) => ({ ...track, analysis: analyses.get(track.id) ?? null })),
    undefined,
    undefined,
    { dropAnchored: input.dropAnchored },
  );
  const duration = planDurationMs(entries);
  const partial =
    duration + DURATION_TOLERANCE_MS < targetDurationMs || remainingRequired().length > 0;

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
  };

  const explanation: PlanExplanation = {
    seed,
    selected: selected.map((track, order) => ({
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      order,
      score: scoreFor(
        track,
        selected[order - 1] ?? null,
        selected.length <= 1 ? 0 : order / (selected.length - 1),
      ),
    })),
    rejected: rejected.slice(0, 50),
  };

  return { plan, explanation, partial };
}
