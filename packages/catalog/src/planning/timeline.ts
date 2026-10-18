import {
  DEFAULT_BASS_CROSSOVER_HZ,
  DEFAULT_BASS_LOW_ATTENUATION_DB,
  DEFAULT_BASS_SWAP_RAMP_MS,
  DEFAULT_MID_DIP_DB,
  DEFAULT_TRANSITION_OVERLAP_MS,
  LEVEL_MATCH_GAIN_MAX_DB,
  LEVEL_MATCH_GAIN_MIN_DB,
  MAX_TEMPO_DEVIATION,
  PLANNER_BASS_SWAP_TRIGGER_GROOVE,
  PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP,
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
  resolveJoinInputs,
  stripJoinResolution,
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
  grooveCompatibility,
  localBeatProfile,
  beatIndexAtOrAfter,
  structuralGrooveConflict,
} from "./shared.ts";
import {
  applySequentialDefaults,
  recallApprovedHandoff,
  type RecipeRecallLookup,
} from "./recall.ts";
import {
  bakeWindowAlignment,
  firstDropSection,
  lateDropMinPlayableMs,
  planPhraseWindow,
  type PhraseWindow,
} from "./windows.ts";

export type TimelineAnalysis = {
  gridOk: boolean;
  /** Q03 evidence passthrough for the resolved-join contract. */
  analyzerVersion?: string | null;
  gridSource?: "analyzed" | "reference" | "manual" | "anchor" | "sidecar" | null;
  /**
   * Q04: representative short-term loudness of the track's PLAYED material
   * (the time-indexed series' median over valid frames). Null when no
   * series is stored - callers fall back to integrated LUFS. This is the
   * section-aware value join scoring and the gain outlier guard prefer:
   * whole-track integrated is dragged by quiet intros/outros that never
   * play in the mix.
   */
  bodyShortTermLufs?: number | null;
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
  /** Beat-grid steadiness from the DSP analysis; low values (2026-10
   * listening sessions) mean the stored grid drifts against the audio and
   * every join the track touches risks audible flams. */
  tempoStability?: number | null;
  /** Absolute beat grid; beat-profile index 0 is beatTimesMs[0]. */
  beatTimesMs?: number[];
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
    beatKick?: number[];
    beatSnare?: number[];
    beatOnset?: number[];
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
    grooveSyncopation?: number | null;
    backbeatConcentration?: number | null;
    /** DSP 3.12: the stored grid phase disagrees with the track's own audio
     *  somewhere beyond the trust threshold — aligned blends on it risk
     *  constant sub-beat flams. */
    gridPhaseSuspect?: boolean | null;
    bars?: {
      rms: number[];
      sub?: number[];
      midFlux?: number[];
      onsetDensity?: number[];
      syncopation?: Array<number | null>;
      beatKick?: number[];
      beatSnare?: number[];
      beatOnset?: number[];
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

function crossfade(
  reason: string,
  durationMs = DEFAULT_TRANSITION_OVERLAP_MS,
  parameters: Record<string, number | string | boolean> = {},
): ChosenTransition {
  return {
    transition: {
      id: crypto.randomUUID(),
      type: "crossfade",
      durationMs,
      outgoingCuePointId: null,
      incomingCuePointId: null,
      parameters: { reason, ...parameters },
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
    maxBars?: PhraseBarCount | null;
  } = {},
): ChosenTransition {
  const outCanon = options.outgoingEffectiveBpm ?? tempoBpm(outgoing);
  const inCanon = tempoBpm(incoming);
  if (outCanon == null || inCanon == null || !(outCanon > 0) || !(inCanon > 0)) {
    return crossfade("missing-bpm");
  }
  // Feasibility first: opposite-end pairs (170/178) can still meet at 174 with
  // each deck inside ±3%. A direct out→in ratio would wrongly reject them.
  const target = pairTargetBpm(outCanon, inCanon, {
    chainTargetBpm: options.chainTargetBpm,
    outgoingLocked: options.outgoingEffectiveBpm != null,
  });
  const tempoMismatch =
    Math.abs(playbackRateForBpm(outCanon, target) - 1) > MAX_TEMPO_DEVIATION + 1e-9 ||
    Math.abs(playbackRateForBpm(inCanon, target) - 1) > MAX_TEMPO_DEVIATION + 1e-9;
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
      ...(!forcedBars && options.maxBars ? { maxBars: options.maxBars } : {}),
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
  const resolvedBase =
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
  // Groove-triggered bass_swap: when the outgoing and incoming kick patterns
  // are incompatible, blending mid/high frequencies creates a galloping
  // effect (the two drum lines fight each other). Bass_swap keeps the drums
  // separate — the outgoing plays until the handover bar, then the incoming
  // takes over. This is Phase 3-lite: the existing groove signal triggers a
  // different template instead of just penalizing the pair.
  const outgoingSyncopation = outgoing.analysis?.descriptors?.grooveSyncopation ?? null;
  const incomingSyncopation = incoming.analysis?.descriptors?.grooveSyncopation ?? null;
  // Structurally incompatible grooves, measured where the two decks actually
  // meet: the outgoing's bars from its mix-out (the START of its overlap —
  // mixOutMs is where the blend begins, the source end adds the overlap on
  // top) against the incoming's bars from its aligned mix-in, each over the
  // join's actual bar count (F3, repository review 2026-10-08). The material
  // before mix-out is not superimposed on anything and must not gate the
  // join; whole-track averages demonstrably cannot separate praised joins
  // from bad ones, and a drum-sparse side cannot gallop against anything.
  const structural = structuralGrooveConflict(
    {
      syncopation: outgoing.analysis?.descriptors?.bars?.syncopation,
      bpm: outgoing.analysis?.bpm,
      downbeat0Ms: outgoing.analysis?.downbeatTimesMs?.[0] ?? null,
      windowStartMs: resolvedBase.mixOutMs,
      windowBars: resolvedBase.barCount,
    },
    {
      syncopation: incoming.analysis?.descriptors?.bars?.syncopation,
      bpm: incoming.analysis?.bpm,
      downbeat0Ms: incoming.analysis?.downbeatTimesMs?.[0] ?? null,
      windowStartMs: resolvedBase.mixInMs,
      windowBars: resolvedBase.barCount,
    },
    PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP,
  );
  // Batch D (11 October review): when the anchored window structurally
  // conflicts, recover automatically with a different WINDOW before
  // accepting the crossfade fallback — the gate is overlap-local, so a
  // whole-phrase shift of the incoming mix-in can move the blend onto
  // compatible material without changing tracks. Bounded at two phrases
  // per side; downstream gates (playable span, continuity, timeline) still
  // reject an infeasible shift, so termination is unchanged.
  // T1 (12 October review): mixInMs is SOURCE time — the shift increment
  // and the bounds check must convert the output-time bar length through
  // the incoming rate, recovery requires MEASURED compatibility (an
  // unknown region is not evidence of a recovery), and the shifted window
  // is re-baked through the shared alignment path with stale drop/phrase
  // provenance cleared so dependent fields describe the new interval.
  let resolvedWindow = resolvedBase;
  let windowShiftBars: number | null = null;
  let windowShiftMeasured = false;
  if (structural.conflict && structural.gap != null && options.window == null) {
    const barMs = target && target > 0 ? (4 * 60_000) / target : 1379.31;
    const inAudioStart = incoming.analysis?.audioStartMs ?? 0;
    const inAudioEnd = incoming.analysis?.audioEndMs ?? incoming.durationMs;
    const inBpm = incoming.analysis?.bpm ?? target;
    // Output-time bar length converted to the incoming's SOURCE time; the
    // overlap occupies this much of the incoming's source timeline.
    const barSourceMs = outputToSourceMs(barMs, incomingRate);
    const overlapSourceMs = outputToSourceMs(
      phraseDurationMs(resolvedBase.barCount, target ?? inBpm ?? 174),
      incomingRate,
    );
    const shifts = [
      resolvedBase.barCount,
      -resolvedBase.barCount,
      resolvedBase.barCount * 2,
      -resolvedBase.barCount * 2,
    ];
    for (const shiftBars of shifts) {
      const candidateIn = resolvedBase.mixInMs + shiftBars * barSourceMs;
      if (candidateIn < inAudioStart || candidateIn + overlapSourceMs > inAudioEnd - 100) {
        continue;
      }
      const shifted = structuralGrooveConflict(
        {
          syncopation: outgoing.analysis?.descriptors?.bars?.syncopation,
          bpm: outgoing.analysis?.bpm,
          downbeat0Ms: outgoing.analysis?.downbeatTimesMs?.[0] ?? null,
          windowStartMs: resolvedBase.mixOutMs,
          windowBars: resolvedBase.barCount,
        },
        {
          syncopation: incoming.analysis?.descriptors?.bars?.syncopation,
          bpm: inBpm,
          downbeat0Ms: incoming.analysis?.downbeatTimesMs?.[0] ?? null,
          windowStartMs: candidateIn,
          windowBars: resolvedBase.barCount,
        },
        PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP,
      );
      // Only MEASURED compatibility is a recovery: conflict===false with a
      // gap means both sides were measured and agree. gap===null means the
      // candidate region's evidence was missing — unknown, not recovered.
      if (!shifted.conflict && shifted.gap != null) {
        const shiftedWindow: PhraseWindow = {
          ...resolvedBase,
          mixInMs: Math.round(candidateIn),
          mixInBar: resolvedBase.mixInBar != null ? resolvedBase.mixInBar + shiftBars : null,
          // The old interval's provenance no longer describes this window.
          dropAnchored: false,
          incomingDropMs: null,
          continuity: undefined,
        };
        resolvedWindow = bakeWindowAlignment(outgoing, incoming, shiftedWindow, {
          targetBpm: target,
          outgoingRate,
          incomingRate,
        });
        windowShiftBars = shiftBars;
        windowShiftMeasured = true;
        break;
      }
    }
  }
  if (structural.conflict && structural.gap != null && windowShiftBars == null) {
    return crossfade("groove-syncopation-conflict", DEFAULT_TRANSITION_OVERLAP_MS, {
      grooveGap: Number(structural.gap.toFixed(3)),
      grooveOutSync: Number((structural.outgoing?.mean ?? 0).toFixed(3)),
      grooveInSync: Number((structural.incoming?.mean ?? 0).toFixed(3)),
      grooveOutBars: structural.outgoing?.measuredBars ?? 0,
      grooveInBars: structural.incoming?.measuredBars ?? 0,
      grooveOutWindowMs: Math.round(resolvedBase.mixOutMs),
      grooveInWindowMs: Math.round(resolvedBase.mixInMs),
    });
  }
  // Groove-triggered bass_swap scores the same overlap-local material the
  // structural gate measures — the outgoing's beats from its mix-out and the
  // incoming's from its mix-in, sized to the join's bar count (F3 locality:
  // file tail/head profiles can describe material the join never plays).
  // Profiles are grid-indexed, so without beat times there is no way to
  // locate the overlap in them; abstain rather than scoring the wrong bars.
  // The trigger requires DECISIVE conflict (PLANNER_BASS_SWAP_TRIGGER_GROOVE,
  // audition-calibrated October 2026): mild negatives are measurement noise,
  // and phrase_mix — which preserves volume and energy — is preferred
  // whenever the blend works. Hand-pinned bass swaps belong in recipes.
  const outProfile = outgoing.analysis?.bars;
  const inProfile = incoming.analysis?.bars;
  const outStartBeat =
    outgoing.analysis?.beatTimesMs && outProfile
      ? beatIndexAtOrAfter(outgoing.analysis.beatTimesMs, resolvedWindow.mixOutMs)
      : null;
  const inStartBeat =
    incoming.analysis?.beatTimesMs && inProfile
      ? beatIndexAtOrAfter(incoming.analysis.beatTimesMs, resolvedWindow.mixInMs)
      : null;
  const groove =
    outProfile && inProfile && outStartBeat != null && inStartBeat != null
      ? grooveCompatibility(
          localBeatProfile(outProfile, outStartBeat),
          localBeatProfile(inProfile, inStartBeat),
          resolvedWindow.barCount * 4,
          {
            outgoingSyncopation,
            incomingSyncopation,
          },
          { positioned: true },
        )
      : null;
  const grooveTriggeredSwap = groove != null && groove < PLANNER_BASS_SWAP_TRIGGER_GROOVE;
  // Explicit abstention: per-bar series exist but a side's overlap window is
  // drum-sparse (fewer than two measured bars), so the structural gate could
  // not compare. Distinguish this from "no per-bar evidence at all".
  const structuralAbstain =
    structural.gap == null &&
    ((outgoing.analysis?.descriptors?.bars?.syncopation?.length ?? 0) > 0 ||
      (incoming.analysis?.descriptors?.bars?.syncopation?.length ?? 0) > 0)
      ? structural.outgoing == null && structural.incoming == null
        ? "both-sparse"
        : structural.outgoing == null
          ? "outgoing-sparse"
          : "incoming-sparse"
      : null;
  const aligned = grooveTriggeredSwap
    ? { type: "bass_swap" as const, reason: "groove-kick-conflict" }
    : { type: "phrase_mix" as const, reason: "continuity-window" };
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
        // Phase 3: groove-triggered bass_swaps glide the low end across the
        // handover (12 bars for 32-bar / 8 for 16-bar) instead of a hard
        // dump — the auditioned treatment for incompatible kick patterns
        // with compatible syncopation (structural conflicts crossfade).
        ...(grooveTriggeredSwap ? { lowFadeBars: phraseBars === 32 ? 12 : 8 } : {}),
        phraseShape,
        intent,
        sequentialHandoff: policyHandoff.sequentialHandoff,
        mixOutMs: resolvedWindow.mixOutMs,
        mixInMs: resolvedWindow.mixInMs,
        downbeatOffsetMs: resolvedWindow.alignmentOffsetMs,
        ...(resolvedWindow.onsetLockBeats != null
          ? { onsetLockBeats: resolvedWindow.onsetLockBeats }
          : {}),
        ...(resolvedWindow.alignmentPeriodMs != null
          ? { alignmentPeriodMs: resolvedWindow.alignmentPeriodMs }
          : {}),
        ...(resolvedWindow.alignmentMode ? { alignmentMode: resolvedWindow.alignmentMode } : {}),
        ...(resolvedWindow.exitKind ? { exitKind: resolvedWindow.exitKind } : {}),
        ...(resolvedWindow.incomingDropMs != null
          ? { incomingDropMs: resolvedWindow.incomingDropMs }
          : {}),
        ...(keyClash ? { keyClash: true, keyClashWarning: "KEY_CLASH" } : {}),
        ...(structuralAbstain ? { grooveAbstain: structuralAbstain } : {}),
        // Batch D: when the anchored window structurally conflicted and a
        // whole-phrase shift recovered it on MEASURED compatibility, the
        // shift is provenance (T1: unknown evidence is not a recovery).
        ...(windowShiftBars != null && windowShiftMeasured
          ? { windowShiftBars, windowShiftReason: "groove-syncopation-conflict-resolved" }
          : {}),
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
              ...(resolvedWindow.continuity.landingIncomingFadeBars
                ? {
                    landingIncomingFadeBars: resolvedWindow.continuity.landingIncomingFadeBars,
                  }
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
  const mixOutMs = constrainMixOut(rawMixOut, audioEnd);
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
  // Q04 calibrated outlier guard (owner A/B verdict, 13 October 2026):
  // whole-track matching stays the DEFAULT; the section-aware body value
  // substitutes only when it disagrees with integrated by more than
  // 2 LU - the pathological class (quiet intros/outros dragging the
  // whole-track average away from the material that actually plays).
  // The set reference is the median of the SAME guarded values, so the
  // outlier's gain is measured against played material on both sides.
  const BODY_GAIN_DISAGREEMENT_LU = 2;
  const guardedGainLufs = (track: TimelineTrack): number | null => {
    const integrated = track.analysis?.integratedLufs ?? null;
    const body = track.analysis?.bodyShortTermLufs ?? null;
    if (body != null && integrated != null) {
      return Math.abs(body - integrated) > BODY_GAIN_DISAGREEMENT_LU ? body : integrated;
    }
    return body ?? integrated;
  };
  const referenceLufs = medianLufs(tracks.map((track) => guardedGainLufs(track)));
  const pairWindows: Array<PhraseWindow | null> = [];
  // S3 (11 October review): rates distinguish intentional PINS from derived
  // chain values. A prior rate is authoritative only when it is pinned
  // (setPlaybackRate) or when the entry's adjacency survived the edit —
  // evidenced by the previous entry's KEPT transition still stamping this
  // track as its incoming side (the F7 pair identity). Everything else (a
  // replaced entry's placeholder rate, a replaced neighbor, a structurally
  // invalidated join) re-derives from the newly chosen pair targets, so a
  // 178 BPM replacement in a 174 BPM chain actually plays at 174/178.
  const rateFromPrior = tracks.map((track, index) => {
    const prior = existing?.get(track.id);
    if (!prior?.playbackRate || prior.playbackRate <= 0) {
      return false;
    }
    if (prior.rateSource === "pinned") {
      return true;
    }
    if (index === 0) {
      // The chain-head rate derives from join 0's outgoing side: keep it
      // while join 0 survived (a null prior transition means it was
      // invalidated and the head re-derives).
      return existing?.get(track.id)?.transitionToNext != null;
    }
    const prevPrior = existing?.get(tracks[index - 1]!.id);
    const stamp = prevPrior?.transitionToNext?.parameters.incomingTrackId;
    return typeof stamp === "string" && stamp === track.id;
  });
  const rates = tracks.map((track, index) => {
    const prior = existing?.get(track.id);
    // rateFromPrior[index] implies a truthy prior rate (see above), but the
    // non-null assertion on an optional chain is both unsafe and banned.
    return rateFromPrior[index] && prior?.playbackRate ? prior.playbackRate : 1;
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
    // R3 fix: the resolved previous-pair window takes precedence over the
    // raw manual cue (the resolver already consulted it and may have rejected
    // it as stale/dead). Manual cues still apply when no aligned window was
    // resolved for this entry.
    const plannedStart =
      prior && "sourceStartMs" in prior && prior.sourceStartMs != null
        ? prior.sourceStartMs
        : (pairWindows[index - 1]?.mixInMs ??
          track.analysis?.manualMixInMs ??
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
      if (!firstAlignedApplied && !rateFromPrior[index]) {
        rates[index] = result.outgoingRate;
      }
      firstAlignedApplied = true;
      if (!rateFromPrior[index + 1]) {
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
    const rate = rateFromPrior[index]
      ? (existing?.get(track.id)?.playbackRate as number)
      : (rates[index] ?? 1);
    // R3 scoped fix: prefer the resolved pair window for the mix-IN only
    // when the PREVIOUS JOIN was aligned (the resolver evaluated the pair
    // and its window is authoritative for where the incoming starts). Check
    // chosen[index - 1]'s transition type, not the current entry's (which
    // is null for the last entry — the exact incoming we're placing).
    // Crossfades and non-aligned joins keep manual-cue precedence; the
    // plannedStart fix above already feeds the resolver the correct start.
    const prevJoinAligned =
      chosen[index - 1]?.transition?.type === "phrase_mix" ||
      chosen[index - 1]?.transition?.type === "bass_swap" ||
      prior?.transitionToNext?.type === "phrase_mix" ||
      prior?.transitionToNext?.type === "bass_swap";
    // S2 (11 October review): the SAME semantics on the outgoing side. The
    // resolver treats a manual mix-out cue as an advisory candidate and
    // snaps it onto the grid (an alignment correction); final entry
    // construction must not silently restore the raw cue over the corrected
    // position while keeping the corrected incoming side — that re-opened
    // the outgoing half of the dead-intro bug. Scoped to THIS entry's own
    // aligned join; crossfades and the last entry keep the raw cue. A hard
    // pin remains expressible through absolute entry trims (setTrim /
    // applyTransition), which are honored verbatim via the prior windows.
    const outgoingJoinAligned =
      transition?.type === "phrase_mix" || transition?.type === "bass_swap";
    return musicalWindow(track, overlap, rate, isLast, {
      mixInMs:
        prior?.sourceStartMs ??
        (prevJoinAligned ? pairWindows[index - 1]?.mixInMs : undefined) ??
        track.analysis?.manualMixInMs,
      mixOutMs:
        (outgoingJoinAligned ? pairWindows[index]?.mixOutMs : undefined) ??
        track.analysis?.manualMixOutMs,
      preserveWindow: true,
    });
  });

  const rateVersion = 2;
  // Q03: entry ids are generated BEFORE the loop so the resolved-join
  // contract can stamp the exact pair identity the built entries carry
  // (fresh builds otherwise mint their ids at push time).
  const entryIds = tracks.map((track) => existing?.get(track.id)?.id ?? crypto.randomUUID());
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
    // S1 (11 October review): resolved and invalidated placement must be
    // mutually exclusive BY CONSTRUCTION. The prior-parameters spread already
    // carries recipeVersion from the original build, so merely omitting the
    // re-stamp leaves the stale marker in place — the renderer kept taking
    // its version-1 early exit and never applied the recomputed placement.
    // The stale marker is removed explicitly instead.
    const alignmentInvalidated = baseTransition?.parameters.alignmentInvalidated != null;
    const priorParameters =
      baseTransition === null
        ? null
        : ({ ...baseTransition.parameters } as Record<string, number | string | boolean>);
    if (alignmentInvalidated && priorParameters != null) {
      delete priorParameters.recipeVersion;
      // S1 mutual exclusion covers the Q03 contract too: an invalidated
      // placement must not carry a stale resolved-join context.
      delete priorParameters.resolvedJoin;
      delete priorParameters.joinResolution;
    }
    const playbackRate = rateFromPrior[index]
      ? (existing?.get(track.id)?.playbackRate as number)
      : (rates[index] ?? 1);
    // Q03 slice 2: the join's OUTPUT anchor is known before the parameters
    // are finalized (same accumulation the entry loop performs), so the
    // resolved-join contract can be stamped at resolution time.
    const prevOverlap = index > 0 ? overlapFor(entries[index - 1]!.transitionToNext) : 0;
    const playableSelf = playableOutputMs(
      { sourceStartMs, sourceEndMs, playbackRate, transitionToNext: baseTransition },
      prevOverlap,
      rateVersion,
    );
    const clampedOverlap =
      baseTransition === null
        ? 0
        : Math.min(overlapFor(baseTransition), Math.max(0, playableSelf - 1));
    const joinAnchorMs = timeline + playableSelf - clampedOverlap;
    // Resolve the join contract for this transition (Q03): geometry through
    // the piecewise rate map, alignment from the resolved window, evidence
    // from the track rows. Unresolved outcomes are recorded explicitly —
    // they never silently degrade into a resolved-looking join.
    const nextTrack = tracks[index + 1];
    const nextPrior = nextTrack ? existing?.get(nextTrack.id) : undefined;
    const nextResolvedWindow = windows[index + 1];
    const incomingStartMs =
      nextPrior?.sourceStartMs ?? nextResolvedWindow?.sourceStartMs ?? undefined;
    const incomingEndMs = nextPrior?.sourceEndMs ?? nextResolvedWindow?.sourceEndMs ?? undefined;
    const paramNum = (key: string): number | null => {
      const value = priorParameters?.[key];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    };
    const targetBpmNum = paramNum("targetBpm");
    const joinResolutionOutcome =
      baseTransition === null || priorParameters === null || !nextTrack || isLast
        ? null
        : alignmentInvalidated
          ? // S1/Q03: an invalidated placement re-derives at render time -
            // stamping a fresh contract would pin the planner's bar-mode
            // math over the renderer's onset-aware recomputation.
            null
          : resolveJoinInputs({
              outgoingEntryId: entryIds[index]!,
              incomingEntryId: entryIds[index + 1]!,
              transitionId: baseTransition.id,
              geometry: {
                outgoingSourceStartMs: sourceStartMs,
                outgoingSourceEndMs: sourceEndMs,
                incomingSourceStartMs: incomingStartMs ?? 0,
                incomingSourceEndMs: incomingEndMs ?? 0,
                joinOutputAnchorMs: joinAnchorMs,
                overlapMs: baseTransition.durationMs,
                outgoingRate: playbackRate,
                incomingRate: rateFromPrior[index + 1]
                  ? ((existing?.get(nextTrack.id)?.playbackRate as number) ?? 1)
                  : (rates[index + 1] ?? 1),
                phraseBarCount:
                  paramNum("barCount") === 8 ||
                  paramNum("barCount") === 16 ||
                  paramNum("barCount") === 32
                    ? (paramNum("barCount") as 8 | 16 | 32)
                    : null,
              },
              outgoingDurationMs: track.durationMs,
              incomingDurationMs: nextTrack.durationMs,
              alignment: {
                mode:
                  priorParameters.alignmentMode === "beat" ||
                  priorParameters.alignmentMode === "phrase"
                    ? priorParameters.alignmentMode
                    : "bar",
                periodMs:
                  paramNum("alignmentPeriodMs") ??
                  (targetBpmNum != null && targetBpmNum > 0
                    ? (4 * 60_000) / targetBpmNum
                    : (4 * 60_000) / 174),
                downbeatOffsetMs: paramNum("downbeatOffsetMs") ?? 0,
                onsetLockBeats:
                  typeof priorParameters.onsetLockBeats === "number"
                    ? priorParameters.onsetLockBeats
                    : null,
                confidence: null,
                coverage: null,
              },
              evidence: {
                outgoingFingerprint: track.fileFingerprint ?? "",
                incomingFingerprint: nextTrack.fileFingerprint ?? "",
                analyzerVersion: track.analysis?.analyzerVersion ?? null,
                gridSource: track.analysis?.gridSource ?? null,
              },
              treatment: {
                type: baseTransition.type,
                params: stripJoinResolution(priorParameters),
              },
              // The join context records the OUTGOING deck's gain decision;
              // the joint two-deck gain policy is Q04.
              gain: {
                gainDb:
                  typeof prior?.gainDb === "number"
                    ? prior.gainDb
                    : levelMatchGainDb(
                        track.analysis?.integratedLufs,
                        referenceLufs,
                        track.analysis?.truePeakDb,
                      ).gainDb,
                source: typeof prior?.gainDb === "number" ? "pinned" : "derived",
              },
            });
    const transitionToNext =
      baseTransition === null || priorParameters === null
        ? null
        : {
            ...baseTransition,
            parameters: {
              ...priorParameters,
              // Q03 slice 3: recipeVersion is RETIRED as the
              // alignment-validity flag. The stamped resolved-join
              // contract is the join authority; alignment-invalidated
              // joins carry neither (S1 mutual exclusion) and re-align at
              // render time.
              ...(joinResolutionOutcome?.status === "resolved"
                ? { resolvedJoin: joinResolutionOutcome.context }
                : {}),
              ...(joinResolutionOutcome?.status === "unresolved"
                ? { joinResolution: joinResolutionOutcome }
                : {}),
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
              // Pair identity (F7): a transition's parameters belong to this
              // exact ordered pair; structural edits use it to invalidate
              // treatments whose incoming side changed.
              incomingTrackId: tracks[index + 1]!.id,
            },
          };
    // Q04 guard input: the guarded value (body only for >2 LU outliers).
    const matched = levelMatchGainDb(
      guardedGainLufs(track),
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
      transitionWithGain === null
        ? null
        : {
            ...transitionWithGain,
            parameters: { ...transitionWithGain.parameters, rateRegionsVersion: 2 as const },
          };
    entries.push({
      id: entryIds[index]!,
      trackId: track.id,
      order: index,
      sourceStartMs,
      sourceEndMs,
      timelineStartMs: timeline,
      playbackRate,
      // S3: an intentional rate pin survives rebuilds verbatim; derived
      // entries carry no marker (absent = derived).
      ...(prior?.rateSource === "pinned" ? { rateSource: "pinned" as const } : {}),
      gainDb,
      transitionToNext: stampedTransition,
    });
    timeline = joinAnchorMs;
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
    tempoStability?: number | null;
    beatTimesMs?: number[];
    /** Q03 evidence passthrough: the analyzer version and grid source the
     * resolved-join contract stamps (null stays null — unknown). */
    analyzerVersion?: string | null;
    gridSource?: "analyzed" | "reference" | "manual" | "anchor" | "sidecar" | null;
    /** Q04: representative played-material short-term loudness from the
     * time-indexed series (null when none is stored). */
    bodyShortTermLufs?: number | null;
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
      grooveSyncopation?: number | null;
      backbeatConcentration?: number | null;
      gridPhaseSuspect?: boolean | null;
      audioStartMs?: number | null;
      audioEndMs?: number | null;
      bars?: {
        rms: number[];
        sub?: number[];
        midFlux?: number[];
        onsetDensity?: number[];
        syncopation?: Array<number | null>;
        beatKick?: number[];
        beatSnare?: number[];
        beatOnset?: number[];
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
    analyzerVersion: analysis.analyzerVersion ?? null,
    gridSource: analysis.gridSource ?? null,
    bodyShortTermLufs: analysis.bodyShortTermLufs ?? null,
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
    tempoStability: analysis.tempoStability ?? null,
    beatTimesMs: analysis.beatTimesMs ?? [],
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
          grooveSyncopation: analysis.descriptors.grooveSyncopation ?? null,
          backbeatConcentration: analysis.descriptors.backbeatConcentration ?? null,
          gridPhaseSuspect: analysis.descriptors.gridPhaseSuspect ?? null,
          bars: analysis.descriptors.bars ?? null,
        }
      : null,
  };
}
