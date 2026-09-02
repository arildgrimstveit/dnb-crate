import { DEFAULT_SCORE_WEIGHTS } from "./constants.ts";
import { camelotDistance } from "./keys.ts";
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
): number {
  if (importance <= 0) {
    return 0;
  }
  const distance = camelotDistance(sourceKey, candidateKey);
  if (distance === null) {
    return 0;
  }
  const raw =
    distance === 0 ? 1 : distance === 1 ? 0.85 : distance === 2 ? 0.45 : distance === 3 ? 0.15 : 0;
  return raw * clamp01(importance);
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
  const mood = overlapScore(candidate.moods, ctx.preferredMoods);
  const subgenre = overlapScore(candidate.subgenres, ctx.preferredSubgenres);
  const tagBonus = overlapScore(candidate.tags, ctx.preferredTags);
  const candidateEnergy = candidate.energy ?? ctx.suggestedEnergy ?? null;
  const sourceEnergy = source?.energy ?? ctx.sourceSuggestedEnergy ?? null;
  const energy = energyScore(
    candidateEnergy,
    ctx.targetEnergy,
    sourceEnergy,
    ctx.direction,
  );
  const energyWeightScale = candidate.energy === null && ctx.suggestedEnergy != null ? 0.6 : 1;
  const bpm = bpmScore(source?.bpm ?? null, candidate.bpm, null);
  const harmonic = harmonicScore(
    source?.camelotKey ?? null,
    candidate.camelotKey,
    ctx.harmonicImportance,
  );
  const outro = ctx.outgoingOutroMs;
  const intro = ctx.incomingIntroMs;
  let structureRaw = 0;
  if (outro != null && intro != null && outro > 0 && intro > 0) {
    structureRaw = clamp01(1 - Math.abs(outro - intro) / Math.max(outro, intro, 1));
  }
  const rating = candidate.rating === null ? 0 : (candidate.rating - 1) / 4;
  const preferredArtist =
    candidate.artist !== null &&
    ctx.preferredArtists.some((artist) => artist.toLowerCase() === candidate.artist!.toLowerCase())
      ? 1
      : 0;
  const exploration = hashSeed(ctx.seed, candidate.id) * clamp01(ctx.explorationWeight);
  const artistKey = candidate.artist?.toLowerCase() ?? null;
  const recentWindow = ctx.recentArtistIds.slice(-Math.max(ctx.artistRepeatSpacing, 0));
  const repeatedArtist =
    artistKey !== null &&
    recentWindow.some((item) => item !== null && item.toLowerCase() === artistKey)
      ? 1
      : 0;
  const recentlyUsed = ctx.alreadyUsed ? 1 : 0;
  const missingMetadata =
    (candidate.bpm === null ? 0.34 : 0) +
    (candidate.camelotKey === null ? 0.33 : 0) +
    (candidate.energy === null && ctx.suggestedEnergy == null ? 0.33 : 0);

  if (mood > 0) {
    reasons.push("MOOD_MATCH");
  }
  if (subgenre > 0) {
    reasons.push("SUBGENRE_MATCH");
  }
  if (tagBonus > 0) {
    reasons.push("TAG_MATCH");
  }
  if (harmonic >= 0.85) {
    reasons.push("HARMONIC_COMPATIBLE");
  } else if (source?.camelotKey && candidate.camelotKey && harmonic < 0.45) {
    reasons.push("HARMONIC_CLASH");
  }
  if (candidate.bpm === null) {
    reasons.push("MISSING_BPM");
  }
  if (candidate.camelotKey === null) {
    reasons.push("MISSING_KEY");
  }
  if (candidate.energy === null && ctx.suggestedEnergy == null) {
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
    subgenre: subgenre * weights.subgenre,
    energy: energy * weights.energy * energyWeightScale,
    bpm: bpm * weights.bpm,
    harmonic: harmonic * weights.harmonic,
    rating: rating * weights.rating,
    preferredArtist: preferredArtist * weights.preferredArtist,
    exploration: exploration * weights.exploration,
    repeatedArtist: -(repeatedArtist * weights.repeatedArtist),
    recentlyUsed: -(recentlyUsed * weights.recentlyUsed),
    missingMetadata: -(missingMetadata * weights.missingMetadata),
    structure: structureRaw * weights.structure,
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
