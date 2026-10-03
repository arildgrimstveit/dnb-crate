import type { CompatibleTrack, CreateSetPlanInput, Track } from "@dnb-crate/domain";
import {
  COMPATIBLE_TRACKS_LIMIT_MAX,
  genresMatchFilter,
  matchesDescriptorFilters,
  resolveBpmHint,
  resolveCanonicalKeyConfidence,
  scoreCandidate,
} from "@dnb-crate/domain";
import type { AnalysisRepository } from "../analysis-repository.ts";
import type { TrackRepository } from "../repository.ts";
import { analysisForTimeline, resolveTrackEvidence } from "../evidence.ts";

export type CompatibleTracksInput = {
  sourceTrackId: string;
  direction?: "up" | "down" | "any";
  limit?: number;
  preferredMoods?: string[];
  preferredSubgenres?: string[];
  preferredTags?: string[];
  harmonicImportance?: number;
  subBassMin?: number;
  brightnessMin?: number;
  energyMin?: number;
  energyMax?: number;
  descriptors?: CreateSetPlanInput["descriptors"];
  genres?: CreateSetPlanInput["genres"];
};

/** Ranked compatible-track search around one source track. The source is
 * resolved (and thrown on) by the caller. */
export function findCompatibleTracks(
  repository: TrackRepository,
  analyses: AnalysisRepository,
  source: Track,
  input: CompatibleTracksInput,
): { sourceTrackId: string; candidates: CompatibleTrack[] } {
  const limit = Math.min(input.limit ?? 10, COMPATIBLE_TRACKS_LIMIT_MAX);
  const analysisOf = (trackId: string) =>
    analysisForTimeline(resolveTrackEvidence(analyses, trackId));
  const srcA = analysisOf(source.id);
  const sectionMs = (
    analysis: ReturnType<typeof analysisOf>,
    type: "intro" | "outro",
  ): number | null => {
    const section = analysis?.sections.find((row) => row.type === type);
    return section ? section.endMs - section.startMs : null;
  };
  const scored = repository
    .listAll()
    .map((track) => ({ track, analysis: analysisOf(track.id) }))
    .filter(({ track, analysis }) => {
      if (track.id === source.id || track.fileMissing) {
        return false;
      }
      const desc = analysis?.descriptors ?? null;
      if (input.energyMin !== undefined) {
        const energy = track.energy ?? desc?.suggestedEnergy;
        if (energy == null || energy < input.energyMin) {
          return false;
        }
      }
      if (input.energyMax !== undefined) {
        const energy = track.energy ?? desc?.suggestedEnergy;
        if (energy == null || energy > input.energyMax) {
          return false;
        }
      }
      if (input.subBassMin !== undefined && (desc?.subBassRatio ?? -1) < input.subBassMin) {
        return false;
      }
      if (input.brightnessMin !== undefined && (desc?.brightness ?? -1) < input.brightnessMin) {
        return false;
      }
      const descriptorMatch = matchesDescriptorFilters(track, desc, input.descriptors);
      if (!descriptorMatch.ok) {
        return false;
      }
      const genreMatch = genresMatchFilter(track.genres, input.genres);
      if (!genreMatch.ok) {
        return false;
      }
      return true;
    })
    .map(({ track, analysis: candA }) => {
      return {
        track,
        score: scoreCandidate({
          source,
          candidate: track,
          targetEnergy: null,
          direction: input.direction ?? "any",
          preferredMoods: input.preferredMoods ?? [],
          preferredSubgenres: input.preferredSubgenres ?? [],
          preferredTags: input.preferredTags ?? [],
          preferredArtists: [],
          recentArtistIds: [source.artist],
          artistRepeatSpacing: 1,
          harmonicImportance: input.harmonicImportance ?? 1,
          explorationWeight: 0,
          seed: 1,
          alreadyUsed: false,
          suggestedEnergy: candA?.descriptors?.suggestedEnergy ?? null,
          sourceSuggestedEnergy: srcA?.descriptors?.suggestedEnergy ?? null,
          outgoingOutroMs: sectionMs(srcA, "outro"),
          incomingIntroMs: sectionMs(candA, "intro"),
          bpmHint: candA ? resolveBpmHint(candA).bpm : null,
          sourceBpmHint: srcA ? resolveBpmHint(srcA).bpm : null,
          descriptors: candA?.descriptors ?? null,
          sourceDescriptors: srcA?.descriptors ?? null,
          candidateKeyConfidence: resolveCanonicalKeyConfidence(track, candA),
          sourceKeyConfidence: resolveCanonicalKeyConfidence(source, srcA),
          candidateGridOk: Boolean(candA && !candA.gridRejected),
          sourceGridOk: Boolean(srcA && !srcA.gridRejected),
          candidateLufs: candA?.integratedLufs ?? null,
          sourceLufs: srcA?.integratedLufs ?? null,
          candidateGenres: track.genres,
        }),
      };
    })
    .sort((a, b) => b.score.total - a.score.total || a.track.id.localeCompare(b.track.id))
    .slice(0, limit);
  return {
    sourceTrackId: source.id,
    candidates: scored.map((item) => ({
      track: {
        id: item.track.id,
        artist: item.track.artist,
        title: item.track.title,
        bpm: item.track.bpm,
        musicalKey: item.track.musicalKey,
        camelotKey: item.track.camelotKey,
        energy: item.track.energy,
        rating: item.track.rating,
      },
      score: item.score,
    })),
  };
}
