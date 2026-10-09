import {
  DEFAULT_TRANSITION_OVERLAP_MS,
  MIN_PLAYABLE_DURATION_MS,
  harmonicRelation,
  isConservativeHarmonic,
  resolveCanonicalKeyConfidence,
  type SelectionScoreBuckets,
  type SetPlanEntry,
  type Track,
} from "@dnb-crate/domain";

import { verifiesAppliedRecipe } from "./applied-recipe.ts";
import { buildEntries, playableMs, type TimelineAnalysis } from "./timeline.ts";
import type { RecipeRecallLookup } from "./recall.ts";
import type { CompiledPlanningConstraints } from "./constraints.ts";
import { artistKey, isEnergyDeathContinuity } from "./shared.ts";

export function hasShortPlayable(entries: SetPlanEntry[], tracks: Track[]): boolean {
  const durations = new Map(tracks.map((track) => [track.id, track.durationMs]));
  return entries.some((entry) => {
    const durationMs = durations.get(entry.trackId) ?? 0;
    return durationMs >= MIN_PLAYABLE_DURATION_MS && playableMs(entry) < MIN_PLAYABLE_DURATION_MS;
  });
}

export function typicalPlayable(tracks: Track[]): number {
  if (tracks.length === 0) {
    return 240_000;
  }
  const avg = tracks.reduce((sum, track) => sum + track.durationMs, 0) / tracks.length;
  return Math.max(avg - DEFAULT_TRANSITION_OVERLAP_MS, 60_000);
}

export function respectsSpacing(track: Track, recent: Track[], spacing: number): boolean {
  if (spacing <= 0) {
    return true;
  }
  const key = artistKey(track);
  if (key === null) {
    return true;
  }
  return !recent.slice(-spacing).some((item) => artistKey(item) === key);
}

export function playableFromAnalysis(track: Track, analysis?: TimelineAnalysis): number {
  if (
    analysis?.mixInMs != null &&
    analysis.mixOutMs != null &&
    analysis.mixOutMs > analysis.mixInMs
  ) {
    return analysis.mixOutMs - analysis.mixInMs;
  }
  return Math.max(track.durationMs - DEFAULT_TRANSITION_OVERLAP_MS, 0);
}

export function scoreBuckets(
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
      joinMood: number;
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
    keyCoverage: components.harmonic + components.joinHarmonic + components.joinMood,
    timeFit: components.bpm,
    lookahead,
    feedback: components.feedback,
  };
}

export type EntryRebuilder = {
  rebuildEntries: (tracks: Track[]) => SetPlanEntry[];
  /** Null when the timeline cannot host native bodies / valid rate regions. */
  rebuildEntriesOrNull: (tracks: Track[]) => SetPlanEntry[] | null;
};

export function makeEntryRebuilder(
  analyses: Map<string, TimelineAnalysis>,
  options: {
    dropAnchored?: boolean | undefined;
    targetBpm?: number | null;
    recall?: RecipeRecallLookup | null;
  },
): EntryRebuilder {
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
        dropAnchored: options.dropAnchored,
        targetBpm: options.targetBpm,
        recall: options.recall,
      },
    );
  const rebuildEntriesOrNull = (tracks: Track[]): SetPlanEntry[] | null => {
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
  return { rebuildEntries, rebuildEntriesOrNull };
}

/** Strict-quality gate over a candidate sequence: recording duplicates,
 * timeline feasibility, artist spacing, pinned recipes, grid/key evidence,
 * crossfades, and conservative harmony. Returns the first failure or null. */
export function makeSelectionQualityCheck(input: {
  qualityPolicy: "strict" | "off";
  compiled: CompiledPlanningConstraints;
  recipeLookup: RecipeRecallLookup;
  analyses: Map<string, TimelineAnalysis>;
  spacing: number;
  rebuildEntriesOrNull: (tracks: Track[]) => SetPlanEntry[] | null;
}): (tracks: Track[]) => string | null {
  const { qualityPolicy, compiled, recipeLookup, analyses, spacing, rebuildEntriesOrNull } = input;
  return (tracks: Track[]): string | null => {
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
      // Energy-death signature (2026-10 listening sessions): a chain whose
      // fade rides a dying outgoing tail while the drums never co-carry is
      // rejected before the track is ever selected.
      if (
        isEnergyDeathContinuity({
          valleyBars:
            typeof transition?.parameters.continuityValleyBars === "number"
              ? transition.parameters.continuityValleyBars
              : null,
          coexistenceBars:
            typeof transition?.parameters.continuityCoexistenceBars === "number"
              ? transition.parameters.continuityCoexistenceBars
              : null,
        })
      ) {
        return "ENERGY_CONTINUITY";
      }
      if (!isConservativeHarmonic(harmonicRelation(outgoing.camelotKey, incoming.camelotKey))) {
        return "HARMONY";
      }
    }
    return null;
  };
}
