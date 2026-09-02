import {
  DEFAULT_BASS_CROSSOVER_HZ,
  DEFAULT_BASS_LOW_ATTENUATION_DB,
  DEFAULT_BASS_SWAP_RAMP_MS,
  DEFAULT_MID_DIP_DB,
  DEFAULT_PHRASE_BARS,
  DEFAULT_TRANSITION_OVERLAP_MS,
  MAX_TEMPO_DEVIATION,
  MIN_ANALYSIS_CONFIDENCE,
  MIN_PLAYABLE_DURATION_MS,
  assertPlaybackRate,
  normalizeDnbBpm,
  phraseDurationMs,
  playbackRateForBpm,
  defaultLowHandoverBar,
  snapToNearestBeat,
  type CuePoint,
  type SetPlanEntry,
  type Track,
  type TrackSection,
  type TrackSectionType,
  type TransitionPlan,
} from "@dnb-crate/domain";

import { constrainMixOut, pickMixIn, pickMixOut, sectionEnergyAt } from "./cues.ts";

export type TimelineAnalysis = {
  gridOk: boolean;
  bpm: number | null;
  canonicalBpm: number | null;
  suggestedEnergy: number | null;
  introStartMs: number | null;
  outroStartMs: number | null;
  outroEndMs: number | null;
  introLenMs: number | null;
  outroLenMs: number | null;
  sections: TrackSection[];
  downbeatTimesMs: number[];
  audioStartMs: number | null;
  audioEndMs: number | null;
  mixInMs: number | null;
  mixOutMs: number | null;
  headEnergy: number | null;
  tailEnergy: number | null;
};

export type TimelineTrack = Pick<Track, "id" | "durationMs" | "energy" | "bpm"> & {
  analysis?: TimelineAnalysis | null;
};

export type ChosenTransition = {
  transition: TransitionPlan;
  outgoingRate: number;
  incomingRate: number;
  targetBpm: number | null;
};

export function defaultPlayableWindow(
  track: TimelineTrack,
): { sourceStartMs: number; sourceEndMs: number } {
  return musicalWindow(track, 0, 1, true);
}

export function playableMs(entry: Pick<SetPlanEntry, "sourceStartMs" | "sourceEndMs">): number {
  return Math.max(0, entry.sourceEndMs - entry.sourceStartMs);
}

export function playableOutputMs(
  entry: Pick<SetPlanEntry, "sourceStartMs" | "sourceEndMs" | "playbackRate">,
): number {
  const rate = entry.playbackRate > 0 ? entry.playbackRate : 1;
  return playableMs(entry) / rate;
}

export function overlapFor(transition: TransitionPlan | null): number {
  return transition?.durationMs ?? DEFAULT_TRANSITION_OVERLAP_MS;
}

function tempoBpm(track: TimelineTrack): number | null {
  return track.analysis?.canonicalBpm ?? track.bpm ?? track.analysis?.bpm ?? null;
}

function gridsOk(outgoing: TimelineTrack, incoming: TimelineTrack): boolean {
  return Boolean(outgoing.analysis?.gridOk && incoming.analysis?.gridOk);
}

function crossfade(reason: string): ChosenTransition {
  return {
    transition: {
      id: crypto.randomUUID(),
      type: "crossfade",
      durationMs: DEFAULT_TRANSITION_OVERLAP_MS,
      outgoingCuePointId: null,
      incomingCuePointId: null,
      parameters: { reason },
    },
    outgoingRate: 1,
    incomingRate: 1,
    targetBpm: null,
  };
}

export function chooseTransition(
  outgoing: TimelineTrack,
  incoming: TimelineTrack,
  options: { outgoingEffectiveBpm?: number } = {},
): ChosenTransition {
  if (!gridsOk(outgoing, incoming)) {
    return crossfade("tempo-or-grid-mismatch");
  }
  const outCanon = options.outgoingEffectiveBpm ?? tempoBpm(outgoing);
  const inCanon = tempoBpm(incoming);
  if (outCanon == null || inCanon == null || !(outCanon > 0) || !(inCanon > 0)) {
    return crossfade("tempo-or-grid-mismatch");
  }
  const pairRate = playbackRateForBpm(inCanon, outCanon);
  if (Math.abs(pairRate - 1) > MAX_TEMPO_DEVIATION + 1e-9) {
    return crossfade("tempo-out-of-range");
  }
  const target =
    options.outgoingEffectiveBpm != null
      ? outCanon
      : (normalizeDnbBpm((outCanon + inCanon) / 2)?.bpm ?? (outCanon + inCanon) / 2);
  const outgoingRate = playbackRateForBpm(outCanon, target);
  const incomingRate = playbackRateForBpm(inCanon, target);
  try {
    assertPlaybackRate(outgoingRate, { allowExcessive: false });
    assertPlaybackRate(incomingRate, { allowExcessive: false });
  } catch {
    return crossfade("tempo-out-of-range");
  }
  const outEnergy = outgoing.energy ?? outgoing.analysis?.suggestedEnergy ?? 5;
  const inEnergy = incoming.energy ?? incoming.analysis?.suggestedEnergy ?? 5;
  const bassSwap = inEnergy > outEnergy || (outEnergy >= 7 && inEnergy >= 7);
  const introLen = incoming.analysis?.introLenMs ?? 0;
  const outroLen = outgoing.analysis?.outroLenMs ?? 0;
  const barMs = phraseDurationMs(1, target);
  const phraseBars: 16 | 32 =
    introLen >= barMs * 28 || outroLen >= barMs * 28 ? 32 : DEFAULT_PHRASE_BARS;
  const type = bassSwap ? "bass_swap" : "phrase_mix";
  return {
    transition: {
      id: crypto.randomUUID(),
      type,
      durationMs: Math.round(phraseDurationMs(phraseBars, target)),
      outgoingCuePointId: null,
      incomingCuePointId: null,
      parameters: {
        reason: bassSwap ? "energy-up-or-both-hot" : "matched-grid-phrase",
        barCount: phraseBars,
        targetBpm: Number(target.toFixed(3)),
        crossoverHz: DEFAULT_BASS_CROSSOVER_HZ,
        swapAtBar: phraseBars === 32 ? 16 : 8,
        lowHandoverBar: defaultLowHandoverBar(phraseBars),
        rampMs: DEFAULT_BASS_SWAP_RAMP_MS,
        lowAttenuationDb: DEFAULT_BASS_LOW_ATTENUATION_DB,
        midDipDb: DEFAULT_MID_DIP_DB,
      },
    },
    outgoingRate,
    incomingRate,
    targetBpm: target,
  };
}

export function musicalWindow(
  track: TimelineTrack,
  overlapMs: number,
  rate: number,
  isLast: boolean,
): { sourceStartMs: number; sourceEndMs: number; mixInMs: number; mixOutMs: number } {
  const analysis = track.analysis;
  const audioStart = analysis?.audioStartMs ?? 0;
  const audioEnd = analysis?.audioEndMs ?? track.durationMs;
  const downbeats = analysis?.downbeatTimesMs ?? [];
  const overlapSource = isLast ? 0 : overlapMs * (rate > 0 ? rate : 1);
  const rawMixIn = analysis?.mixInMs ?? audioStart;
  const rawMixOut = analysis?.mixOutMs ?? Math.max(audioStart, audioEnd - Math.max(overlapSource, 1));
  const snappedMixIn =
    downbeats.length > 0
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
  if (playable < MIN_PLAYABLE_DURATION_MS && track.durationMs >= MIN_PLAYABLE_DURATION_MS) {
    sourceStartMs = Math.max(audioStart, sourceEndMs - MIN_PLAYABLE_DURATION_MS);
  }
  return {
    sourceStartMs: Math.round(sourceStartMs),
    sourceEndMs: Math.round(sourceEndMs),
    mixInMs: Math.round(mixInMs),
    mixOutMs: Math.round(mixOutMs),
  };
}

export function buildEntries(
  tracks: TimelineTrack[],
  overlapMs = DEFAULT_TRANSITION_OVERLAP_MS,
  existing?: Map<string, Partial<SetPlanEntry>>,
): SetPlanEntry[] {
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
      continue;
    }
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
    const outCanon = tempoBpm(track);
    const locked = firstAlignedApplied || (rates[index] ?? 1) !== 1;
    const outgoingEffective =
      locked && outCanon != null ? outCanon * (rates[index] ?? 1) : undefined;
    const result = chooseTransition(track, next, {
      outgoingEffectiveBpm: outgoingEffective,
    });
    const aligned = result.transition.type === "phrase_mix" || result.transition.type === "bass_swap";
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
    const transition = isLast
      ? null
      : (prior?.transitionToNext ?? picked?.transition ?? null);
    const overlap = isLast ? 0 : overlapFor(transition) || overlapMs;
    const rate =
      prior?.playbackRate && prior.playbackRate > 0 ? prior.playbackRate : (rates[index] ?? 1);
    return musicalWindow(track, overlap, rate, isLast);
  });

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
          parameters: { purpose: "stage2-timing-only" },
        });
    const transitionToNext =
      baseTransition === null
        ? null
        : {
            ...baseTransition,
            parameters: {
              ...baseTransition.parameters,
              mixOutMs:
                typeof baseTransition.parameters.mixOutMs === "number"
                  ? baseTransition.parameters.mixOutMs
                  : window.mixOutMs,
              mixInMs:
                typeof baseTransition.parameters.mixInMs === "number"
                  ? baseTransition.parameters.mixInMs
                  : (nextWindow?.mixInMs ?? window.mixInMs),
            },
          };
    const playbackRate =
      prior?.playbackRate && prior.playbackRate > 0 ? prior.playbackRate : (rates[index] ?? 1);
    entries.push({
      id: prior?.id ?? crypto.randomUUID(),
      trackId: track.id,
      order: index,
      sourceStartMs,
      sourceEndMs,
      timelineStartMs: timeline,
      playbackRate,
      gainDb: prior?.gainDb ?? 0,
      transitionToNext,
    });
    const playable = playableOutputMs({ sourceStartMs, sourceEndMs, playbackRate });
    const overlap = isLast ? 0 : Math.min(overlapFor(transitionToNext), Math.max(0, playable - 1));
    timeline += playable - overlap;
  }
  return entries;
}

export function planDurationMs(entries: SetPlanEntry[]): number {
  const last = entries[entries.length - 1];
  if (!last) {
    return 0;
  }
  return last.timelineStartMs + playableOutputMs(last);
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
    bpmConfidence: number | null;
    downbeatTimesMs?: number[];
    downbeatConfidence?: number | null;
    beatTimesMs?: number[];
    descriptors: {
      suggestedEnergy: number | null;
      audioStartMs?: number | null;
      audioEndMs?: number | null;
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
  const duration =
    durationMs ?? analysis.descriptors?.audioEndMs ?? lastEnd ?? 0;
  const intro = sections.find((section) => section.type === "intro");
  const outro = sections.find((section) => section.type === "outro" && section.sectionEnergy >= 0.05)
    ?? sections.find((section) => section.type === "outro");
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
  return {
    gridOk: !analysis.gridRejected && (analysis.bpmConfidence ?? 0) >= MIN_ANALYSIS_CONFIDENCE,
    bpm: analysis.bpm,
    canonicalBpm: canonicalBpm ?? analysis.bpm,
    suggestedEnergy: analysis.descriptors?.suggestedEnergy ?? null,
    introStartMs: intro?.startMs ?? null,
    outroStartMs: outro?.startMs ?? null,
    outroEndMs: outro?.endMs ?? analysis.descriptors?.audioEndMs ?? lastEnd ?? null,
    introLenMs: intro ? intro.endMs - intro.startMs : null,
    outroLenMs: outro ? outro.endMs - outro.startMs : null,
    sections,
    downbeatTimesMs: analysis.downbeatTimesMs ?? [],
    audioStartMs: analysis.descriptors?.audioStartMs ?? null,
    audioEndMs: analysis.descriptors?.audioEndMs ?? null,
    mixInMs: mixIn.ms,
    mixOutMs: mixOut.ms,
    headEnergy: sectionEnergyAt(sections, mixIn.ms),
    tailEnergy: sectionEnergyAt(sections, mixOut.ms),
  };
}
