import {
  DEFAULT_BASS_CROSSOVER_HZ,
  DEFAULT_BASS_LOW_ATTENUATION_DB,
  DEFAULT_BASS_SWAP_RAMP_MS,
  DEFAULT_MID_DIP_DB,
  DEFAULT_TRANSITION_OVERLAP_MS,
  LEVEL_MATCH_GAIN_MAX_DB,
  LEVEL_MATCH_GAIN_MIN_DB,
  MAX_TEMPO_DEVIATION,
  SHORT_CROSSFADE_MS,
  MIN_ANALYSIS_CONFIDENCE,
  MIN_PLAYABLE_DURATION_MS,
  assertPlaybackRate,
  pairTargetBpm,
  isConfidentKeyClash,
  normalizePhraseBars,
  resolveBpmHint,
  phraseDurationMs,
  playbackRateForBpm,
  overlapOnlyPlayableMs,
  resolvePlanRateRegionsVersion,
  resolveRateRegions,
  DJ_HANDOFF_POLICY,
  sourceBpmForRate,
  outputToSourceMs,
  defaultLowHandoverBar,
  snapToNearestBeat,
  chooseMixIntent,
  choosePhraseShape,
  RENDERER_VERSION,
  type CuePoint,
  type PhraseBarCount,
  type RecipeLiveIdentity,
  type SetPlanEntry,
  type Track,
  type TrackSection,
  type TrackSectionType,
  type TransitionPlan,
} from "@dnb-crate/domain";

import { constrainMixOut, pickMixIn, pickMixOut, sectionEnergyAt } from "./cues.ts";
import {
  applySequentialDefaults,
  recallApprovedHandoff,
  type RecipeRecallLookup,
} from "./recall.ts";
import {
  firstDropSection,
  lateDropMinPlayableMs,
  planPhraseWindow,
  type PhraseWindow,
} from "./windows.ts";

export type TimelineAnalysis = {
  gridOk: boolean;
  bpm: number | null;
  canonicalBpm: number | null;
  bpmHint: number | null;
  bpmHintConfidence: number | null;
  suggestedEnergy: number | null;
  introStartMs: number | null;
  outroStartMs: number | null;
  outroEndMs: number | null;
  introLenMs: number | null;
  outroLenMs: number | null;
  sections: TrackSection[];
  downbeatTimesMs: number[];
  downbeatConfidence: number | null;
  audioStartMs: number | null;
  audioEndMs: number | null;
  mixInMs: number | null;
  mixOutMs: number | null;
  headEnergy: number | null;
  tailEnergy: number | null;
  integratedLufs: number | null;
  truePeakDb?: number | null;
  keyConfidence: number | null;
  bars?: {
    rms: number[];
    sub?: number[];
    midFlux?: number[];
    onsetDensity?: number[];
  } | null;
  manualMixInMs?: number | null;
  manualMixOutMs?: number | null;
  descriptors?: {
    energy: number | null;
    danceability: number | null;
    valence: number | null;
    acousticness: number | null;
    melodicness: number | null;
    subBassRatio: number | null;
    brightness: number | null;
    suggestedEnergy: number | null;
    bars?: {
      rms: number[];
      sub?: number[];
      midFlux?: number[];
      onsetDensity?: number[];
    } | null;
  } | null;
};

export type TimelineTrack = Pick<Track, "id" | "durationMs" | "energy" | "bpm" | "camelotKey"> & {
  analysis?: TimelineAnalysis | null;
  fileFingerprint?: string | null;
  title?: string | null;
};

export type ChosenTransition = {
  transition: TransitionPlan;
  outgoingRate: number;
  incomingRate: number;
  targetBpm: number | null;
  window?: PhraseWindow;
};

export function defaultPlayableWindow(track: TimelineTrack): {
  sourceStartMs: number;
  sourceEndMs: number;
} {
  return musicalWindow(track, 0, 1, true);
}

export function playableMs(entry: Pick<SetPlanEntry, "sourceStartMs" | "sourceEndMs">): number {
  return Math.max(0, entry.sourceEndMs - entry.sourceStartMs);
}

/**
 * Legacy pairwise hours prepare the first tail and later heads. Version 2
 * prepares both source join regions before accumulation, leaving the body native.
 */
export function playableOutputMs(
  entry: Pick<SetPlanEntry, "sourceStartMs" | "sourceEndMs" | "playbackRate"> & {
    transitionToNext?: TransitionPlan | null;
    overlapToNextMs?: number | null;
  },
  fromPrevMs = 0,
  rateRegionsVersion?: 1 | 2,
): number {
  const toNext =
    entry.overlapToNextMs ??
    (entry.transitionToNext != null ? overlapFor(entry.transitionToNext) : 0);
  const fromPrev = Math.max(0, fromPrevMs);
  if (rateRegionsVersion === 2) {
    try {
      return resolveRateRegions(playableMs(entry), entry.playbackRate, fromPrev, toNext).at(-1)!
        .outputEndMs;
    } catch {
      // Short files cannot host a native body under join-only timing; use overlap-only duration.
    }
  }
  return overlapOnlyPlayableMs({
    sourceMs: playableMs(entry),
    rate: entry.playbackRate > 0 ? entry.playbackRate : 1,
    overlapToNextMs: fromPrev > 0 ? 0 : toNext,
    overlapFromPrevMs: fromPrev,
  });
}

export function plannedMixDurationMs(
  entries: Array<
    Pick<SetPlanEntry, "sourceStartMs" | "sourceEndMs" | "playbackRate"> & {
      transitionToNext?: TransitionPlan | null;
      overlapToNextMs?: number | null;
    }
  >,
  stretchScope: "all" | "overlap" = "overlap",
  rateRegionsVersion?: 1 | 2,
): number {
  if (entries.length === 0) {
    return 0;
  }
  let playable = 0;
  let overlapSum = 0;
  const regions = rateRegionsVersion ?? resolvePlanRateRegionsVersion({ entries }).version;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const toNext =
      entry.overlapToNextMs ??
      (entry.transitionToNext != null ? overlapFor(entry.transitionToNext) : 0);
    const previous = i > 0 ? entries[i - 1] : undefined;
    const previousTransition = previous?.transitionToNext ?? null;
    const fromPrev =
      previous == null
        ? 0
        : (previous.overlapToNextMs ??
          (previousTransition != null ? overlapFor(previousTransition) : 0));
    if (stretchScope === "all") {
      const rate = entry.playbackRate > 0 ? entry.playbackRate : 1;
      playable += playableMs(entry) / rate;
    } else {
      playable += playableOutputMs(entry, fromPrev, regions);
    }
    overlapSum += toNext;
  }
  return Math.max(0, Math.round(playable - overlapSum));
}

export function overlapFor(transition: TransitionPlan | null): number {
  return transition?.durationMs ?? DEFAULT_TRANSITION_OVERLAP_MS;
}

function tempoBpm(track: TimelineTrack): number | null {
  return track.analysis?.canonicalBpm ?? track.bpm ?? track.analysis?.bpm ?? null;
}

function gridBpm(track: TimelineTrack): number | null {
  return sourceBpmForRate(track.analysis?.gridOk ? track.analysis.bpm : null, tempoBpm(track));
}

function crossfade(reason: string, durationMs = DEFAULT_TRANSITION_OVERLAP_MS): ChosenTransition {
  return {
    transition: {
      id: crypto.randomUUID(),
      type: "crossfade",
      durationMs,
      outgoingCuePointId: null,
      incomingCuePointId: null,
      parameters: { reason },
    },
    outgoingRate: 1,
    incomingRate: 1,
    targetBpm: null,
  };
}

function sectionAt(sections: TrackSection[], atMs: number | null): TrackSection | undefined {
  if (atMs == null) {
    return sections[0];
  }
  return (
    sections.find((section) => atMs >= section.startMs && atMs < section.endMs) ??
    sections.find((section) => atMs >= section.startMs && atMs <= section.endMs)
  );
}

export function chooseTransition(
  outgoing: TimelineTrack,
  incoming: TimelineTrack,
  options: {
    outgoingEffectiveBpm?: number;
    dropAnchored?: boolean;
    window?: PhraseWindow | null;
    chainTargetBpm?: number | null;
    recall?: RecipeRecallLookup | null;
    liveIdentity?: RecipeLiveIdentity | null;
    outgoingSourceStartMs?: number;
    outgoingHeadEndMs?: number;
  } = {},
): ChosenTransition {
  const outCanon = options.outgoingEffectiveBpm ?? tempoBpm(outgoing);
  const inCanon = tempoBpm(incoming);
  if (outCanon == null || inCanon == null || !(outCanon > 0) || !(inCanon > 0)) {
    return crossfade("missing-bpm");
  }
  const pairRate = playbackRateForBpm(inCanon, outCanon);
  const tempoMismatch = Math.abs(pairRate - 1) > MAX_TEMPO_DEVIATION + 1e-9;
  const outGrid = outgoing.analysis?.gridOk === true;
  const inGrid = incoming.analysis?.gridOk === true;
  if (!outGrid || !inGrid) {
    const durationMs = tempoMismatch ? SHORT_CROSSFADE_MS : DEFAULT_TRANSITION_OVERLAP_MS;
    if (!outGrid) {
      return crossfade("outgoing-grid-rejected", durationMs);
    }
    return crossfade("incoming-grid-rejected", durationMs);
  }
  if (tempoMismatch) {
    return crossfade("tempo-out-of-range", SHORT_CROSSFADE_MS);
  }
  const target = pairTargetBpm(outCanon, inCanon, {
    chainTargetBpm: options.chainTargetBpm,
    outgoingLocked: options.outgoingEffectiveBpm != null,
  });
  const outSource = gridBpm(outgoing) ?? outCanon;
  const inSource = gridBpm(incoming) ?? inCanon;
  const outgoingRate = playbackRateForBpm(outSource, target);
  const incomingRate = playbackRateForBpm(inSource, target);
  try {
    assertPlaybackRate(outgoingRate, { allowExcessive: false });
    assertPlaybackRate(incomingRate, { allowExcessive: false });
  } catch {
    return crossfade("tempo-out-of-range", SHORT_CROSSFADE_MS);
  }
  const live: RecipeLiveIdentity = options.liveIdentity ?? {
    outgoingTrackId: outgoing.id,
    incomingTrackId: incoming.id,
    outgoingSourceFingerprint: outgoing.fileFingerprint ?? "",
    incomingSourceFingerprint: incoming.fileFingerprint ?? "",
    outgoingRate,
    incomingRate,
    outgoingDurationMs: outgoing.durationMs,
    incomingDurationMs: incoming.durationMs,
    engine: {
      rendererVersion: RENDERER_VERSION,
      tempoEngine: "rubberband-r3",
      stretchScope: "overlap",
    },
    selectedEvidence: null,
  };
  const requireRecipe = options.recall?.reuseForPair?.(outgoing.id, incoming.id) === "recipe";
  // Exact historical recall is explicit; fresh plans learn general windows.
  const recalled = requireRecipe
    ? recallApprovedHandoff(outgoing, incoming, live, options.recall)
    : null;
  if (recalled?.chosen) {
    if (recalled.chosen.transition.parameters.rateRegionsVersion == null) {
      recalled.chosen.transition.parameters.rateRegionsVersion = 2;
    }
    return recalled.chosen;
  }
  const forcedBars = recalled?.barCount;
  const window =
    options.window ??
    planPhraseWindow(outgoing, incoming, {
      dropAnchored: options.dropAnchored,
      targetBpm: target,
      outgoingRate,
      incomingRate,
      outgoingSourceStartMs: options.outgoingSourceStartMs,
      outgoingHeadEndMs: options.outgoingHeadEndMs,
      ...(forcedBars ? { maxBars: forcedBars } : {}),
    });
  const leftConfidence = outgoing.analysis?.keyConfidence ?? (outgoing.camelotKey ? 1 : 0);
  const rightConfidence = incoming.analysis?.keyConfidence ?? (incoming.camelotKey ? 1 : 0);
  const keyClash = isConfidentKeyClash({
    leftKey: outgoing.camelotKey ?? null,
    rightKey: incoming.camelotKey ?? null,
    leftConfidence,
    rightConfidence,
    plannedBars: window.barCount,
  });
  const resolvedWindow =
    forcedBars && window.barCount !== forcedBars && !options.window
      ? planPhraseWindow(outgoing, incoming, {
          dropAnchored: options.dropAnchored,
          targetBpm: target,
          outgoingRate,
          incomingRate,
          maxBars: forcedBars,
          outgoingSourceStartMs: options.outgoingSourceStartMs,
          outgoingHeadEndMs: options.outgoingHeadEndMs,
        })
      : window;
  const aligned = { type: "phrase_mix" as const, reason: "continuity-window" };
  const phraseBars: PhraseBarCount = normalizePhraseBars(forcedBars ?? resolvedWindow.barCount);
  const phraseShape =
    recalled?.phraseShape ??
    resolvedWindow.phraseShape ??
    choosePhraseShape(
      sectionAt(outgoing.analysis?.sections ?? [], resolvedWindow.mixOutMs),
      sectionAt(incoming.analysis?.sections ?? [], resolvedWindow.mixInMs),
    );
  const intent =
    recalled?.intent ?? chooseMixIntent({ phraseShape, exitKind: resolvedWindow.exitKind });
  const policyHandoff = applySequentialDefaults(phraseShape, recalled?.sequentialHandoff);
  const selectionReason = requireRecipe
    ? `adapted: RECIPE_INFEASIBLE${recalled?.reason ? `; ${recalled.reason}` : ""}`
    : recalled && !recalled.fallback
      ? recalled.reason
      : (policyHandoff.reason ?? recalled?.reason);
  return {
    transition: {
      id: crypto.randomUUID(),
      type: aligned.type,
      durationMs: Math.round(phraseDurationMs(phraseBars, target)),
      outgoingCuePointId: null,
      incomingCuePointId: null,
      parameters: {
        reason: aligned.reason,
        barCount: phraseBars,
        targetBpm: Number(target.toFixed(3)),
        crossoverHz: DEFAULT_BASS_CROSSOVER_HZ,
        swapAtBar: phraseBars === 32 ? 16 : phraseBars === 8 ? 4 : 8,
        lowHandoverBar: defaultLowHandoverBar(phraseBars, intent),
        rampMs: DEFAULT_BASS_SWAP_RAMP_MS,
        lowAttenuationDb: DEFAULT_BASS_LOW_ATTENUATION_DB,
        midDipDb: DEFAULT_MID_DIP_DB,
        phraseShape,
        intent,
        sequentialHandoff: policyHandoff.sequentialHandoff,
        mixOutMs: resolvedWindow.mixOutMs,
        mixInMs: resolvedWindow.mixInMs,
        downbeatOffsetMs: resolvedWindow.alignmentOffsetMs,
        ...(resolvedWindow.alignmentPeriodMs != null
          ? { alignmentPeriodMs: resolvedWindow.alignmentPeriodMs }
          : {}),
        ...(resolvedWindow.alignmentMode ? { alignmentMode: resolvedWindow.alignmentMode } : {}),
        ...(resolvedWindow.exitKind ? { exitKind: resolvedWindow.exitKind } : {}),
        ...(resolvedWindow.incomingDropMs != null
          ? { incomingDropMs: resolvedWindow.incomingDropMs }
          : {}),
        ...(keyClash ? { keyClash: true, keyClashWarning: "KEY_CLASH" } : {}),
        ...(policyHandoff.rateRegionsVersion === 2 ? { rateRegionsVersion: 2 } : {}),
        ...(selectionReason ? { selectionReason } : {}),
        ...(resolvedWindow.continuity
          ? {
              continuityEvidence: resolvedWindow.continuity.evidence,
              continuityEnergyFloor: resolvedWindow.continuity.energyFloor,
              continuityValleyBars: resolvedWindow.continuity.valleyBars,
              continuityCoexistenceBars: resolvedWindow.continuity.coexistenceBars,
              windowPolicy: DJ_HANDOFF_POLICY,
              ...(resolvedWindow.continuity.landingFadeBars
                ? { landingFadeBars: resolvedWindow.continuity.landingFadeBars }
                : {}),
            }
          : {}),
        ...(recalled?.fallback ? { approvalFallbackReason: recalled.reason } : {}),
      },
    },
    outgoingRate,
    incomingRate,
    targetBpm: target,
    window: resolvedWindow,
  };
}

export function musicalWindow(
  track: TimelineTrack,
  overlapMs: number,
  rate: number,
  isLast: boolean,
  overrides?: { mixInMs?: number | null; mixOutMs?: number | null; preserveWindow?: boolean },
): { sourceStartMs: number; sourceEndMs: number; mixInMs: number; mixOutMs: number } {
  const analysis = track.analysis;
  const audioStart = analysis?.audioStartMs ?? 0;
  const audioEnd = analysis?.audioEndMs ?? track.durationMs;
  const downbeats = analysis?.downbeatTimesMs ?? [];
  const overlapSource = isLast ? 0 : outputToSourceMs(overlapMs, rate);
  const rawMixIn = overrides?.mixInMs ?? analysis?.mixInMs ?? audioStart;
  const rawMixOut =
    overrides?.mixOutMs ??
    analysis?.mixOutMs ??
    Math.max(audioStart, audioEnd - Math.max(overlapSource, 1));
  const snappedMixIn =
    overrides?.mixInMs != null
      ? Math.round(rawMixIn)
      : downbeats.length > 0
        ? (snapToNearestBeat(rawMixIn, downbeats)?.positionMs ?? Math.round(rawMixIn))
        : Math.round(rawMixIn);
  const mixInMs = Math.max(audioStart, snappedMixIn);
  const mixOutMs = constrainMixOut(rawMixOut, overlapSource, audioEnd, downbeats);
  let sourceEndMs = isLast ? audioEnd : Math.min(Math.round(mixOutMs + overlapSource), audioEnd);
  let sourceStartMs = mixInMs;
  if (sourceEndMs <= sourceStartMs) {
    sourceEndMs = Math.min(track.durationMs, Math.max(sourceStartMs + 1, audioEnd));
  }
  const playable = sourceEndMs - sourceStartMs;
  if (
    !overrides?.preserveWindow &&
    playable < MIN_PLAYABLE_DURATION_MS &&
    track.durationMs >= MIN_PLAYABLE_DURATION_MS
  ) {
    if (overrides?.mixInMs == null) {
      sourceStartMs = Math.max(audioStart, sourceEndMs - MIN_PLAYABLE_DURATION_MS);
    } else {
      const roomEnd = Math.min(audioEnd, track.durationMs);
      if (sourceEndMs < roomEnd) {
        sourceEndMs = Math.min(roomEnd, sourceStartMs + MIN_PLAYABLE_DURATION_MS);
      }
    }
  }
  const lateMin = lateDropMinPlayableMs(
    track.durationMs,
    firstDropSection(analysis?.sections ?? [])?.startMs,
  );
  if (lateMin != null && sourceEndMs - sourceStartMs < lateMin) {
    sourceEndMs = Math.min(audioEnd, track.durationMs);
  }
  return {
    sourceStartMs: Math.round(sourceStartMs),
    sourceEndMs: Math.round(sourceEndMs),
    mixInMs: Math.round(mixInMs),
    mixOutMs: Math.round(mixOutMs),
  };
}

export function medianLufs(values: Array<number | null | undefined>): number | null {
  const finite = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (finite.length === 0) {
    return null;
  }
  const sorted = [...finite].sort((left, right) => left - right);
  const mid = Math.floor((sorted.length - 1) / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? null;
  }
  return ((sorted[mid] ?? 0) + (sorted[mid + 1] ?? 0)) / 2;
}

export function levelMatchGainDb(
  trackLufs: number | null | undefined,
  referenceLufs: number | null | undefined,
  truePeakDb?: number | null,
): { gainDb: number; warning: string | null } {
  if (referenceLufs == null || !Number.isFinite(referenceLufs)) {
    return { gainDb: 0, warning: trackLufs == null ? "missing-lufs" : null };
  }
  if (trackLufs == null || !Number.isFinite(trackLufs)) {
    return { gainDb: 0, warning: "missing-lufs" };
  }
  let gainDb = Math.min(
    LEVEL_MATCH_GAIN_MAX_DB,
    Math.max(LEVEL_MATCH_GAIN_MIN_DB, referenceLufs - trackLufs),
  );
  let warning: string | null = null;
  if (truePeakDb != null && Number.isFinite(truePeakDb)) {
    const maxGain = Math.min(LEVEL_MATCH_GAIN_MAX_DB, 0 - truePeakDb);
    if (gainDb > maxGain) {
      gainDb = Math.max(LEVEL_MATCH_GAIN_MIN_DB, maxGain);
      warning = "true-peak-headroom";
    }
  }
  return { gainDb: Number(gainDb.toFixed(2)), warning };
}

export function buildEntries(
  tracks: TimelineTrack[],
  overlapMs = DEFAULT_TRANSITION_OVERLAP_MS,
  existing?: Map<string, Partial<SetPlanEntry>>,
  options: {
    dropAnchored?: boolean;
    targetBpm?: number | null;
    recall?: RecipeRecallLookup | null;
  } = {},
): SetPlanEntry[] {
  const referenceLufs = medianLufs(tracks.map((track) => track.analysis?.integratedLufs));
  const pairWindows: Array<PhraseWindow | null> = [];
  const rates = tracks.map((track) => {
    const prior = existing?.get(track.id);
    return prior?.playbackRate && prior.playbackRate > 0 ? prior.playbackRate : 1;
  });
  const chosen: Array<ChosenTransition | null> = [];
  let firstAlignedApplied = false;
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]!;
    const prior = existing?.get(track.id);
    const isLast = index === tracks.length - 1;
    const next = tracks[index + 1];
    if (isLast || !next) {
      chosen.push(null);
      pairWindows.push(null);
      continue;
    }
    pairWindows.push(null);
    if (prior?.transitionToNext) {
      chosen.push({
        transition: prior.transitionToNext,
        outgoingRate: rates[index] ?? 1,
        incomingRate: rates[index + 1] ?? 1,
        targetBpm:
          typeof prior.transitionToNext.parameters.targetBpm === "number"
            ? prior.transitionToNext.parameters.targetBpm
            : null,
      });
      continue;
    }
    const outGrid = gridBpm(track);
    const locked = firstAlignedApplied || (rates[index] ?? 1) !== 1;
    const outgoingEffective = locked && outGrid != null ? outGrid * (rates[index] ?? 1) : undefined;
    const plannedStart =
      prior && "sourceStartMs" in prior && prior.sourceStartMs != null
        ? prior.sourceStartMs
        : (track.analysis?.manualMixInMs ??
          pairWindows[index - 1]?.mixInMs ??
          track.analysis?.mixInMs ??
          track.analysis?.audioStartMs ??
          0);
    const result = chooseTransition(track, next, {
      outgoingSourceStartMs: plannedStart,
      outgoingHeadEndMs:
        plannedStart + (chosen[index - 1]?.transition.durationMs ?? 0) * (rates[index] ?? 1),
      outgoingEffectiveBpm: outgoingEffective,
      dropAnchored: options.dropAnchored,
      chainTargetBpm: options.targetBpm,
      recall: options.recall,
    });
    const alignedWindow =
      result.window ??
      planPhraseWindow(track, next, {
        dropAnchored: false,
        outgoingRate: rates[index],
        incomingRate: rates[index + 1],
      });
    pairWindows[index] = alignedWindow;
    result.transition.parameters = {
      ...result.transition.parameters,
      mixOutMs: alignedWindow.mixOutMs,
      mixInMs: alignedWindow.mixInMs,
      downbeatOffsetMs: alignedWindow.alignmentOffsetMs,
      ...(alignedWindow.alignmentPeriodMs != null
        ? { alignmentPeriodMs: alignedWindow.alignmentPeriodMs }
        : {}),
      ...(alignedWindow.alignmentMode ? { alignmentMode: alignedWindow.alignmentMode } : {}),
    };
    const aligned =
      result.transition.type === "phrase_mix" || result.transition.type === "bass_swap";
    if (aligned) {
      if (!firstAlignedApplied && !existing?.get(track.id)?.playbackRate) {
        rates[index] = result.outgoingRate;
      }
      firstAlignedApplied = true;
      if (!existing?.get(next.id)?.playbackRate) {
        rates[index + 1] = result.incomingRate;
      }
    }
    chosen.push(result);
  }

  const windows = tracks.map((track, index) => {
    const isLast = index === tracks.length - 1;
    const prior = existing?.get(track.id);
    const picked = chosen[index];
    const transition = isLast ? null : (prior?.transitionToNext ?? picked?.transition ?? null);
    const overlap = isLast ? 0 : overlapFor(transition) || overlapMs;
    const rate =
      prior?.playbackRate && prior.playbackRate > 0 ? prior.playbackRate : (rates[index] ?? 1);
    return musicalWindow(track, overlap, rate, isLast, {
      mixInMs:
        prior?.sourceStartMs ?? track.analysis?.manualMixInMs ?? pairWindows[index - 1]?.mixInMs,
      mixOutMs: track.analysis?.manualMixOutMs ?? pairWindows[index]?.mixOutMs,
      preserveWindow: true,
    });
  });

  const rateVersion = 2;
  const entries: SetPlanEntry[] = [];
  let timeline = 0;
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]!;
    const prior = existing?.get(track.id);
    const window = windows[index]!;
    const nextWindow = windows[index + 1];
    const sourceStartMs = prior?.sourceStartMs ?? window.sourceStartMs;
    const sourceEndMs = prior?.sourceEndMs ?? window.sourceEndMs;
    const isLast = index === tracks.length - 1;
    const picked = chosen[index];
    const baseTransition: TransitionPlan | null = isLast
      ? null
      : (prior?.transitionToNext ??
        picked?.transition ?? {
          id: crypto.randomUUID(),
          type: "crossfade",
          durationMs: overlapMs,
          outgoingCuePointId: null,
          incomingCuePointId: null,
          parameters: { purpose: "timing-only" },
        });
    const transitionToNext =
      baseTransition === null
        ? null
        : {
            ...baseTransition,
            parameters: {
              ...baseTransition.parameters,
              recipeVersion: 1,
              mixOutMs:
                sourceEndMs -
                outputToSourceMs(
                  baseTransition.durationMs,
                  prior?.playbackRate ?? rates[index] ?? 1,
                ),
              mixInMs:
                existing?.get(tracks[index + 1]!.id)?.sourceStartMs ??
                nextWindow?.sourceStartMs ??
                window.mixInMs,
            },
          };
    const playbackRate =
      prior?.playbackRate && prior.playbackRate > 0 ? prior.playbackRate : (rates[index] ?? 1);
    const matched = levelMatchGainDb(
      track.analysis?.integratedLufs,
      referenceLufs,
      track.analysis?.truePeakDb,
    );
    const gainDb = typeof prior?.gainDb === "number" ? prior.gainDb : matched.gainDb;
    const transitionWithGain =
      transitionToNext === null
        ? null
        : matched.warning && typeof prior?.gainDb !== "number"
          ? {
              ...transitionToNext,
              parameters: { ...transitionToNext.parameters, levelMatchWarning: matched.warning },
            }
          : transitionToNext;
    const stampedTransition =
      transitionWithGain && rateVersion === 2
        ? {
            ...transitionWithGain,
            parameters: { ...transitionWithGain.parameters, rateRegionsVersion: 2 as const },
          }
        : transitionWithGain;
    entries.push({
      id: prior?.id ?? crypto.randomUUID(),
      trackId: track.id,
      order: index,
      sourceStartMs,
      sourceEndMs,
      timelineStartMs: timeline,
      playbackRate,
      gainDb,
      transitionToNext: stampedTransition,
    });
    const prevOverlap = index > 0 ? overlapFor(entries[index - 1]!.transitionToNext) : 0;
    const playable = playableOutputMs(
      { sourceStartMs, sourceEndMs, playbackRate, transitionToNext: stampedTransition },
      prevOverlap,
      rateVersion,
    );
    const overlap = isLast ? 0 : Math.min(overlapFor(transitionToNext), Math.max(0, playable - 1));
    timeline += playable - overlap;
  }
  return entries;
}

export function planDurationMs(
  entries: SetPlanEntry[],
  plan?: { rateRegionsVersion?: unknown },
): number {
  return plannedMixDurationMs(
    entries,
    "overlap",
    resolvePlanRateRegionsVersion({ rateRegionsVersion: plan?.rateRegionsVersion, entries })
      .version,
  );
}

export function assertPlayableWindow(
  track: TimelineTrack,
  sourceStartMs: number,
  sourceEndMs: number,
): void {
  if (sourceStartMs < 0 || sourceEndMs <= sourceStartMs) {
    throw new Error("invalid source window");
  }
  if (sourceEndMs > track.durationMs) {
    throw new Error("source window exceeds track duration");
  }
  if (
    sourceEndMs - sourceStartMs < MIN_PLAYABLE_DURATION_MS &&
    track.durationMs >= MIN_PLAYABLE_DURATION_MS
  ) {
    throw new Error("playable duration below minimum");
  }
}

export function analysisToTimeline(
  analysis: {
    trackId?: string;
    gridRejected: boolean;
    bpm: number | null;
    bpmRaw?: number | null;
    bpmConfidence: number | null;
    keyConfidence?: number | null;
    integratedLufs?: number | null;
    truePeakDb?: number | null;
    downbeatTimesMs?: number[];
    downbeatConfidence?: number | null;
    beatTimesMs?: number[];
    descriptors: {
      suggestedEnergy: number | null;
      integratedLufs?: number | null;
      energy?: number | null;
      danceability?: number | null;
      valence?: number | null;
      acousticness?: number | null;
      melodicness?: number | null;
      subBassRatio?: number | null;
      brightness?: number | null;
      audioStartMs?: number | null;
      audioEndMs?: number | null;
      bars?: {
        rms: number[];
        sub?: number[];
        midFlux?: number[];
        onsetDensity?: number[];
      } | null;
    } | null;
    sections: Array<{
      type: string;
      startMs: number;
      endMs: number;
      startBar?: number | null;
      endBar?: number | null;
      confidence?: number;
      sectionEnergy?: number;
    }>;
  } | null,
  canonicalBpm?: number | null,
  cues: CuePoint[] = [],
  durationMs?: number,
): TimelineAnalysis | null {
  if (!analysis) {
    return null;
  }
  const sections: TrackSection[] = analysis.sections.map((section) => ({
    type: section.type as TrackSectionType,
    startMs: section.startMs,
    endMs: section.endMs,
    startBar: section.startBar ?? null,
    endBar: section.endBar ?? null,
    confidence: section.confidence ?? 0,
    sectionEnergy: section.sectionEnergy ?? 0.5,
  }));
  const lastEnd = sections.at(-1)?.endMs;
  const duration = durationMs ?? analysis.descriptors?.audioEndMs ?? lastEnd ?? 0;
  const intro = sections.find((section) => section.type === "intro");
  const outro =
    sections.find((section) => section.type === "outro" && section.sectionEnergy >= 0.05) ??
    sections.find((section) => section.type === "outro");
  const bundle = {
    track: { id: analysis.trackId ?? "unknown", durationMs: duration },
    analysis: {
      sections,
      downbeatTimesMs: analysis.downbeatTimesMs ?? [],
      downbeatConfidence: analysis.downbeatConfidence ?? null,
      beatTimesMs: analysis.beatTimesMs ?? [],
      descriptors: analysis.descriptors,
    },
    cues,
  };
  const mixIn = pickMixIn(bundle);
  const mixOut = pickMixOut(bundle);
  const hint = resolveBpmHint(analysis);
  return {
    gridOk: !analysis.gridRejected && (analysis.bpmConfidence ?? 0) >= MIN_ANALYSIS_CONFIDENCE,
    manualMixInMs:
      cues.find((cue) => cue.source === "manual" && cue.type === "intro_start")?.positionMs ?? null,
    manualMixOutMs:
      cues.find((cue) => cue.source === "manual" && cue.type === "outro_start")?.positionMs ?? null,
    bpm: analysis.bpm,
    canonicalBpm: canonicalBpm ?? analysis.bpm,
    bpmHint: hint.bpm,
    bpmHintConfidence: hint.confidence,
    suggestedEnergy: analysis.descriptors?.suggestedEnergy ?? null,
    introStartMs: intro?.startMs ?? null,
    outroStartMs: outro?.startMs ?? null,
    outroEndMs: outro?.endMs ?? analysis.descriptors?.audioEndMs ?? lastEnd ?? null,
    introLenMs: intro ? intro.endMs - intro.startMs : null,
    outroLenMs: outro ? outro.endMs - outro.startMs : null,
    sections,
    downbeatTimesMs: analysis.downbeatTimesMs ?? [],
    downbeatConfidence: analysis.downbeatConfidence ?? null,
    audioStartMs: analysis.descriptors?.audioStartMs ?? null,
    audioEndMs: analysis.descriptors?.audioEndMs ?? null,
    mixInMs: mixIn.ms,
    mixOutMs: mixOut.ms,
    headEnergy: sectionEnergyAt(sections, mixIn.ms),
    tailEnergy: sectionEnergyAt(sections, mixOut.ms),
    integratedLufs: analysis.integratedLufs ?? analysis.descriptors?.integratedLufs ?? null,
    truePeakDb: analysis.truePeakDb ?? null,
    keyConfidence: analysis.keyConfidence ?? null,
    bars: analysis.descriptors?.bars ?? null,
    descriptors: analysis.descriptors
      ? {
          energy: analysis.descriptors.energy ?? null,
          danceability: analysis.descriptors.danceability ?? null,
          valence: analysis.descriptors.valence ?? null,
          acousticness: analysis.descriptors.acousticness ?? null,
          melodicness: analysis.descriptors.melodicness ?? null,
          subBassRatio: analysis.descriptors.subBassRatio ?? null,
          brightness: analysis.descriptors.brightness ?? null,
          suggestedEnergy: analysis.descriptors.suggestedEnergy ?? null,
          bars: analysis.descriptors.bars ?? null,
        }
      : null,
  };
}
