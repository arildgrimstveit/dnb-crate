import { DEFAULT_SCORE_WEIGHTS } from "./constants.ts";
import {
  effectiveEnergy,
  moodPresetScore,
  type DescriptorValues,
} from "./descriptor-filters.ts";
import { normalizeGenre } from "./genres.ts";
import { normalizePersonName } from "./identity.ts";
import { camelotDistance, camelotNumberDistance } from "./keys.ts";
import type { EnergyDirection, ScoreBreakdown, ScoreComponents } from "./planning.ts";
import type { Track } from "./track.ts";

export type ScoreContext = {
  source: Track | null;
  candidate: Track;
  targetEnergy: number | null;
  direction: EnergyDirection;
  preferredMoods: string[];
  preferredSubgenres: string[];
  preferredTags: string[];
  preferredArtists: string[];
  recentArtistIds: Array<string | null>;
  artistRepeatSpacing: number;
  harmonicImportance: number;
  explorationWeight: number;
  seed: number;
  alreadyUsed: boolean;
  suggestedEnergy?: number | null;
  sourceSuggestedEnergy?: number | null;
  outgoingOutroMs?: number | null;
  incomingIntroMs?: number | null;
  bpmHint?: number | null;
  sourceBpmHint?: number | null;
  descriptors?: DescriptorValues | null;
  sourceDescriptors?: DescriptorValues | null;
  candidateLufs?: number | null;
  sourceLufs?: number | null;
  candidateGridOk?: boolean;
  sourceGridOk?: boolean;
  candidateKeyConfidence?: number | null;
  sourceKeyConfidence?: number | null;
  candidateDropBars?: number | null;
  sourceQuietTail?: boolean;
  candidateGenres?: string[];
};

function overlapScore(left: string[], right: string[]): number {
  if (right.length === 0) {
    return 0;
  }
  const set = new Set(left.map((item) => item.toLowerCase()));
  let hits = 0;
  for (const item of right) {
    if (set.has(item.toLowerCase())) {
      hits += 1;
    }
  }
  return hits / right.length;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function hashSeed(seed: number, trackId: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < trackId.length; i += 1) {
    h ^= trackId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

function bpmScore(
  sourceBpm: number | null,
  candidateBpm: number | null,
  targetBpm: number | null,
): number {
  const reference = targetBpm ?? sourceBpm;
  if (reference === null || candidateBpm === null) {
    return 0;
  }
  return clamp01(1 - Math.abs(reference - candidateBpm) / 8);
}

function energyScore(
  candidateEnergy: number | null,
  targetEnergy: number | null,
  sourceEnergy: number | null,
  direction: EnergyDirection,
): number {
  if (candidateEnergy === null) {
    return 0;
  }
  const target = targetEnergy ?? sourceEnergy;
  const proximity = target === null ? 0.5 : clamp01(1 - Math.abs(candidateEnergy - target) / 9);
  if (direction === "any" || sourceEnergy === null) {
    return proximity;
  }
  if (direction === "up") {
    return candidateEnergy >= sourceEnergy ? 0.55 + 0.45 * proximity : 0.2 * proximity;
  }
  return candidateEnergy <= sourceEnergy ? 0.55 + 0.45 * proximity : 0.2 * proximity;
}

function harmonicScore(
  sourceKey: string | null,
  candidateKey: string | null,
  importance: number,
  sourceConf = 1,
  candidateConf = 1,
): number {
  if (importance <= 0) {
    return 0;
  }
  const distance = camelotNumberDistance(sourceKey, candidateKey) ?? camelotDistance(sourceKey, candidateKey);
  if (distance === null) {
    return 0;
  }
  const raw =
    distance === 0 ? 1 : distance === 1 ? 0.85 : distance === 2 ? 0.45 : distance === 3 ? 0.15 : 0;
  return raw * clamp01(importance) * Math.min(clamp01(sourceConf), clamp01(candidateConf));
}

/**
 * Deterministic weighted score. Components are independently inspectable.
 */
export function scoreCandidate(
  ctx: ScoreContext,
  weights: typeof DEFAULT_SCORE_WEIGHTS = DEFAULT_SCORE_WEIGHTS,
): ScoreBreakdown {
  const { candidate, source } = ctx;
  const reasons: string[] = [];
  const moodResult = moodPresetScore(
    ctx.preferredMoods,
    candidate.moods,
    candidate,
    ctx.descriptors,
  );
  const mood = moodResult.score;
  const candidateSubgenres =
    candidate.subgenres.length > 0
      ? candidate.subgenres
      : (candidate.genres ?? []).map(normalizeGenre);
  const subgenreScale = candidate.subgenres.length === 0 && candidateSubgenres.length > 0 ? 0.5 : 1;
  const subgenre = overlapScore(candidateSubgenres, ctx.preferredSubgenres.map(normalizeGenre));
  const tagBonus = overlapScore(candidate.tags, ctx.preferredTags);
  const candidateEnergy = effectiveEnergy(candidate, {
    energy: ctx.descriptors?.energy ?? null,
    suggestedEnergy: ctx.suggestedEnergy ?? ctx.descriptors?.suggestedEnergy ?? null,
  });
  const sourceEnergy = source
    ? effectiveEnergy(source, {
        energy: ctx.sourceDescriptors?.energy ?? null,
        suggestedEnergy: ctx.sourceSuggestedEnergy ?? ctx.sourceDescriptors?.suggestedEnergy ?? null,
      })
    : null;
  const energy = energyScore(
    candidateEnergy,
    ctx.targetEnergy,
    sourceEnergy,
    ctx.direction,
  );
  const energyWeightScale = candidate.energy === null && candidateEnergy != null ? 0.6 : 1;
  const candidateBpm = candidate.bpm ?? ctx.bpmHint ?? null;
  const sourceBpm = source?.bpm ?? ctx.sourceBpmHint ?? null;
  const bpmScale = candidate.bpm == null && ctx.bpmHint != null ? 0.5 : 1;
  const bpm = bpmScore(sourceBpm, candidateBpm, null);
  const harmonic = harmonicScore(
    source?.camelotKey ?? null,
    candidate.camelotKey,
    ctx.harmonicImportance,
    ctx.sourceKeyConfidence ?? (source?.camelotKey ? 1 : 0),
    ctx.candidateKeyConfidence ?? (candidate.camelotKey ? 1 : 0),
  );
  const deltaLufs =
    ctx.sourceLufs != null && ctx.candidateLufs != null
      ? Math.abs(ctx.candidateLufs - ctx.sourceLufs)
      : 0;
  const joinLevelRaw = source ? -Math.max(0, deltaLufs - 3) / 6 : 0;
  const joinStructureRaw =
    source && (ctx.candidateDropBars ?? 0) >= 16 && ctx.sourceQuietTail
      ? 1
      : source && ((ctx.candidateDropBars ?? 0) >= 16 || ctx.sourceQuietTail)
        ? 0.45
        : 0;
  const bpmClose =
    sourceBpm != null &&
    candidateBpm != null &&
    Math.abs(candidateBpm - sourceBpm) / Math.max(sourceBpm, 1) <= 0.03;
  const joinAlignedRaw = source && ctx.candidateGridOk && ctx.sourceGridOk && bpmClose ? 1 : 0;
  const joinHarmonicRaw = harmonic;
  const priorLabels = new Set(["liquid funk", "neurofunk", "jump up", "jungle"]);
  const candidateGenres = (ctx.candidateGenres ?? candidate.genres ?? []).map(normalizeGenre);
  const preferredGenres = new Set(ctx.preferredSubgenres.map(normalizeGenre));
  const genrePriorRaw = candidateGenres.some((genre) => priorLabels.has(genre))
    ? candidateGenres.some((genre) => preferredGenres.has(genre))
      ? 1
      : 0.4
    : 0;
  const outro = ctx.outgoingOutroMs;
  const intro = ctx.incomingIntroMs;
  let structureRaw = 0;
  if (outro != null && intro != null && outro > 0 && intro > 0) {
    structureRaw = clamp01(1 - Math.abs(outro - intro) / Math.max(outro, intro, 1));
  }
  const rating = candidate.rating === null ? 0 : (candidate.rating - 1) / 4;
  const candidateArtistKey =
    candidate.artistCanonical ?? (candidate.artist ? normalizePersonName(candidate.artist) : null);
  const preferredArtist =
    candidateArtistKey !== null &&
    ctx.preferredArtists.some(
      (artist) => normalizePersonName(artist) === candidateArtistKey,
    )
      ? 1
      : 0;
  const exploration = hashSeed(ctx.seed, candidate.id) * clamp01(ctx.explorationWeight);
  const artistKey = candidateArtistKey;
  const recentWindow = ctx.recentArtistIds.slice(-Math.max(ctx.artistRepeatSpacing, 0));
  const repeatedArtist =
    artistKey !== null &&
    recentWindow.some(
      (item) => item !== null && normalizePersonName(item) === artistKey,
    )
      ? 1
      : 0;
  const recentlyUsed = ctx.alreadyUsed ? 1 : 0;
  const missingMetadata =
    (candidate.bpm === null && ctx.bpmHint == null ? 0.34 : 0) +
    (candidate.camelotKey === null ? 0.33 : 0) +
    (candidateEnergy == null ? 0.33 : 0);

  if (mood > 0 && moodResult.route === "manual") {
    reasons.push("MOOD_MATCH");
  }
  if (mood > 0 && moodResult.route === "preset") {
    reasons.push("MOOD_PRESET");
  }
  if (subgenre > 0) {
    reasons.push(candidate.subgenres.length > 0 ? "SUBGENRE_MATCH" : "GENRE_MATCH");
  }
  if (tagBonus > 0) {
    reasons.push("TAG_MATCH");
  }
  if (harmonic >= 0.85) {
    reasons.push("HARMONIC_COMPATIBLE");
  } else if (source?.camelotKey && candidate.camelotKey && harmonic < 0.45) {
    reasons.push("HARMONIC_CLASH");
  }
  if (candidate.bpm === null && ctx.bpmHint != null) {
    reasons.push("BPM_HINT_ONLY");
  } else if (candidate.bpm === null) {
    reasons.push("MISSING_BPM");
  }
  if (candidate.camelotKey === null) {
    reasons.push("MISSING_KEY");
  }
  if (candidateEnergy == null) {
    reasons.push("MISSING_ENERGY");
  }
  if (structureRaw >= 0.7) {
    reasons.push("STRUCTURE_COMPATIBLE");
  }
  if (repeatedArtist) {
    reasons.push("REPEATED_ARTIST");
  }

  const components: ScoreComponents = {
    mood: mood * weights.mood + tagBonus * (weights.mood / 2),
    subgenre: subgenre * weights.subgenre * subgenreScale,
    energy: energy * weights.energy * energyWeightScale,
    bpm: bpm * weights.bpm * bpmScale,
    harmonic: harmonic * weights.harmonic,
    rating: rating * weights.rating,
    preferredArtist: preferredArtist * weights.preferredArtist,
    exploration: exploration * weights.exploration,
    repeatedArtist: -(repeatedArtist * weights.repeatedArtist),
    recentlyUsed: -(recentlyUsed * weights.recentlyUsed),
    missingMetadata: -(missingMetadata * weights.missingMetadata),
    structure: structureRaw * weights.structure,
    joinLevel: joinLevelRaw * weights.joinLevel,
    joinStructure: joinStructureRaw * weights.joinStructure,
    joinAligned: joinAlignedRaw * weights.joinAligned,
    joinHarmonic: joinHarmonicRaw * weights.joinHarmonic,
    genrePrior: genrePriorRaw * weights.genrePrior,
  };

  const total = Object.values(components).reduce((sum, value) => sum + value, 0);
  return { total, components, reasons };
}

export function interpolateEnergy(
  arc: Array<{ atFraction: number; targetEnergy: number }>,
  fraction: number,
): number {
  if (arc.length === 0) {
    return 5;
  }
  const sorted = [...arc].sort((a, b) => a.atFraction - b.atFraction);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (fraction <= first.atFraction) {
    return first.targetEnergy;
  }
  if (fraction >= last.atFraction) {
    return last.targetEnergy;
  }
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (fraction >= a.atFraction && fraction <= b.atFraction) {
      const span = b.atFraction - a.atFraction;
      const t = span === 0 ? 0 : (fraction - a.atFraction) / span;
      return a.targetEnergy + t * (b.targetEnergy - a.targetEnergy);
    }
  }
  return last.targetEnergy;
}
