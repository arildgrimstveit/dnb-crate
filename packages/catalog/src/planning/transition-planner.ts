import {
  DEFAULT_BASS_CROSSOVER_HZ,
  DEFAULT_PHRASE_BARS,
  MIN_ANALYSIS_CONFIDENCE,
  assertPlaybackRate,
  clampBassSwapParams,
  normalizeDnbBpm,
  phraseDurationMs,
  playbackRateForBpm,
  resolveCanonicalBpm,
  snapToNearestBeat,
  type AutomationEvent,
  type CuePoint,
  type CuePointType,
  type Track,
  type TrackAnalysis,
  type TransitionProposal,
  type TransitionValidation,
} from "@dnb-crate/domain";

import type { StoredTrackAnalysis } from "../analysis-repository.ts";

export type PlanTransitionInput = {
  outgoingTrackId: string;
  incomingTrackId: string;
  preferredType?: "phrase_mix" | "bass_swap" | "crossfade" | "any";
  barCount?: 16 | 32;
  targetBpm?: number;
  allowExcessiveTempo?: boolean;
  allowLowConfidence?: boolean;
  allowDropIn?: boolean;
};

export type ValidateTransitionInput = {
  outgoingTrackId: string;
  incomingTrackId: string;
  type: "crossfade" | "phrase_mix" | "bass_swap";
  barCount?: 16 | 32;
  durationMs?: number;
  targetBpm?: number;
  outgoingPlaybackRate?: number;
  incomingPlaybackRate?: number;
  allowExcessiveTempo?: boolean;
  allowLowConfidence?: boolean;
  maxTempoDeviation?: number;
};

type TrackBundle = {
  track: Track;
  analysis: StoredTrackAnalysis | null;
  cues: CuePoint[];
};

function cueByType(
  cues: CuePoint[],
  type: CuePointType,
  source?: CuePoint["source"],
): CuePoint | undefined {
  return cues.find((cue) => cue.type === type && (source === undefined || cue.source === source));
}

function snappedPosition(ms: number, beats: number[]): number {
  return snapToNearestBeat(ms, beats)?.positionMs ?? Math.round(ms);
}

function gridOk(analysis: TrackAnalysis | null, allowLow: boolean): boolean {
  if (!analysis) {
    return allowLow;
  }
  if (analysis.gridRejected) {
    return false;
  }
  if ((analysis.bpmConfidence ?? 0) < MIN_ANALYSIS_CONFIDENCE) {
    return allowLow;
  }
  return true;
}

function lastSection(
  bundle: TrackBundle,
  type: "intro" | "outro" | "breakdown" | "drop",
): CuePoint | undefined {
  const matches = (bundle.analysis?.sections ?? []).filter((item) => item.type === type);
  const section = matches.at(-1);
  if (!section) {
    return undefined;
  }
  return {
    id: `${type}-section`,
    trackId: bundle.track.id,
    type: type === "intro" ? "intro_start" : type === "outro" ? "outro_start" : type,
    positionMs: section.startMs,
    beatIndex: null,
    barIndex: section.startBar,
    confidence: section.confidence,
    source: "analyzed",
    label: null,
  };
}

function firstSection(
  bundle: TrackBundle,
  type: "intro" | "outro" | "breakdown" | "drop",
): CuePoint | undefined {
  const section = bundle.analysis?.sections?.find((item) => item.type === type);
  if (!section) {
    return undefined;
  }
  return {
    id: `${type}-section`,
    trackId: bundle.track.id,
    type: type === "intro" ? "intro_start" : type === "outro" ? "outro_start" : type,
    positionMs: section.startMs,
    beatIndex: null,
    barIndex: section.startBar,
    confidence: section.confidence,
    source: "analyzed",
    label: null,
  };
}

function pickOutgoingCue(
  bundle: TrackBundle,
): { type: CuePointType | null; ms: number; inferred: boolean; reason: string | null; confidence: number | null } {
  const manualOutro = cueByType(bundle.cues, "outro_start", "manual");
  if (manualOutro) {
    return {
      type: manualOutro.type,
      ms: manualOutro.positionMs,
      inferred: false,
      reason: null,
      confidence: manualOutro.confidence,
    };
  }
  const outro = firstSection(bundle, "outro") ?? lastSection(bundle, "breakdown");
  if (outro) {
    return {
      type: outro.type,
      ms: outro.positionMs,
      inferred: true,
      reason: `Outgoing ${outro.type} cue is analyzer-derived (confidence ${(outro.confidence ?? 0).toFixed(2)})`,
      confidence: outro.confidence,
    };
  }
  const analyzedOutro = cueByType(bundle.cues, "outro_start", "analyzed");
  if (analyzedOutro) {
    return {
      type: analyzedOutro.type,
      ms: analyzedOutro.positionMs,
      inferred: true,
      reason: `Outgoing outro cue is analyzer-derived (confidence ${(analyzedOutro.confidence ?? 0).toFixed(2)})`,
      confidence: analyzedOutro.confidence,
    };
  }
  const downbeats = bundle.analysis?.downbeatTimesMs ?? [];
  if (downbeats.length > 4) {
    return {
      type: null,
      ms: downbeats[Math.max(0, downbeats.length - 8)] ?? 0,
      inferred: true,
      reason: "Outgoing mix-out inferred from the last eight downbeats",
      confidence: bundle.analysis?.downbeatConfidence ?? null,
    };
  }
  const overlapGuess = 30_000;
  return {
    type: null,
    ms: Math.max(0, bundle.track.durationMs - overlapGuess),
    inferred: true,
    reason: "Outgoing mix-out inferred from duration minus overlap",
    confidence: null,
  };
}

function pickIncomingCue(
  bundle: TrackBundle,
  options: { preferredType?: PlanTransitionInput["preferredType"]; allowDropIn?: boolean },
): { type: CuePointType | null; ms: number; inferred: boolean; reason: string | null; confidence: number | null } {
  const allowDrop = options.preferredType === "bass_swap" && options.allowDropIn === true;
  const manualIntro = cueByType(bundle.cues, "intro_start", "manual");
  if (manualIntro) {
    return {
      type: manualIntro.type,
      ms: manualIntro.positionMs,
      inferred: false,
      reason: null,
      confidence: manualIntro.confidence,
    };
  }
  if (allowDrop) {
    const drop = cueByType(bundle.cues, "drop", "manual") ?? firstSection(bundle, "drop");
    if (drop) {
      return {
        type: drop.type,
        ms: drop.positionMs,
        inferred: drop.source !== "manual",
        reason:
          drop.source === "manual"
            ? null
            : `Incoming drop cue is analyzer-derived (confidence ${(drop.confidence ?? 0).toFixed(2)})`,
        confidence: drop.confidence,
      };
    }
  }
  const intro = firstSection(bundle, "intro");
  if (intro) {
    return {
      type: intro.type,
      ms: intro.positionMs,
      inferred: true,
      reason: `Incoming intro cue is analyzer-derived (confidence ${(intro.confidence ?? 0).toFixed(2)})`,
      confidence: intro.confidence,
    };
  }
  const analyzedIntro = cueByType(bundle.cues, "intro_start", "analyzed");
  if (analyzedIntro) {
    return {
      type: analyzedIntro.type,
      ms: analyzedIntro.positionMs,
      inferred: true,
      reason: `Incoming intro cue is analyzer-derived (confidence ${(analyzedIntro.confidence ?? 0).toFixed(2)})`,
      confidence: analyzedIntro.confidence,
    };
  }
  const downbeats = bundle.analysis?.downbeatTimesMs ?? [];
  if (downbeats.length > 0) {
    return {
      type: null,
      ms: downbeats[0] ?? 0,
      inferred: true,
      reason: "Incoming mix-in inferred from the first downbeat",
      confidence: bundle.analysis?.downbeatConfidence ?? null,
    };
  }
  return { type: null, ms: 0, inferred: true, reason: "Incoming mix-in inferred at 0ms", confidence: null };
}

function automationFor(
  type: TransitionProposal["type"],
  durationMs: number,
  barCount: 16 | 32 | null,
): AutomationEvent[] {
  if (type === "crossfade") {
    return [
      { atMs: 0, durationMs, target: "outgoing_high", action: "fade_out", value: 0 },
      { atMs: 0, durationMs, target: "incoming_high", action: "fade_in", value: 1 },
    ];
  }
  if (type === "phrase_mix") {
    return [
      { atMs: 0, durationMs, target: "outgoing_high", action: "fade_out", value: 0 },
      { atMs: 0, durationMs, target: "incoming_high", action: "fade_in", value: 1 },
    ];
  }
  const bars = barCount ?? 16;
  const swap = clampBassSwapParams(null, bars);
  const swapAt = Math.round((swap.swapAtBar / bars) * durationMs);
  return [
    { atMs: 0, durationMs, target: "outgoing_high", action: "fade_out", value: 0 },
    { atMs: 0, durationMs, target: "incoming_high", action: "fade_in", value: 1 },
    { atMs: swapAt, durationMs: swap.rampMs, target: "outgoing_low", action: "fade_out", value: 0 },
    { atMs: swapAt, durationMs: swap.rampMs, target: "incoming_low", action: "fade_in", value: 1 },
  ];
}

function propose(
  type: TransitionProposal["type"],
  barCount: 16 | 32 | null,
  outgoing: TrackBundle,
  incoming: TrackBundle,
  targetBpm: number | null,
  options: {
    allowExcessiveTempo?: boolean;
    allowLowConfidence?: boolean;
    preferredType?: PlanTransitionInput["preferredType"];
    allowDropIn?: boolean;
  },
): TransitionProposal {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const outCanon = resolveCanonicalBpm(outgoing.track, outgoing.analysis);
  const inCanon = resolveCanonicalBpm(incoming.track, incoming.analysis);
  let outgoingRate = 1;
  let incomingRate = 1;
  if (targetBpm && outCanon.bpm) {
    outgoingRate = playbackRateForBpm(outCanon.bpm, targetBpm);
  }
  if (targetBpm && inCanon.bpm) {
    incomingRate = playbackRateForBpm(inCanon.bpm, targetBpm);
  }
  try {
    assertPlaybackRate(outgoingRate, { allowExcessive: options.allowExcessiveTempo });
    assertPlaybackRate(incomingRate, { allowExcessive: options.allowExcessiveTempo });
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : "Playback rate out of range");
  }

  const durationMs =
    barCount && targetBpm
      ? Math.round(phraseDurationMs(barCount, targetBpm))
      : type === "crossfade"
        ? 30_000
        : Math.round(phraseDurationMs(DEFAULT_PHRASE_BARS, targetBpm ?? 174));

  const outBeats = outgoing.analysis?.beatTimesMs ?? [];
  const inBeats = incoming.analysis?.beatTimesMs ?? [];
  const outCue = pickOutgoingCue(outgoing);
  const inCue = pickIncomingCue(incoming, {
    preferredType: options.preferredType ?? type,
    allowDropIn: options.allowDropIn,
  });
  let outCueMs = outBeats.length > 0 ? snappedPosition(outCue.ms, outBeats) : outCue.ms;
  const inCueMs = inBeats.length > 0 ? snappedPosition(inCue.ms, inBeats) : inCue.ms;
  const firstDrop = outgoing.analysis?.sections?.find((section) => section.type === "drop");
  if (firstDrop && outCueMs < firstDrop.endMs) {
    outCueMs = firstDrop.endMs;
  }

  const outSourceOverlap = durationMs * outgoingRate;
  const inSourceOverlap = durationMs * incomingRate;
  let outgoingEnd = Math.min(outgoing.track.durationMs, Math.round(outCueMs + outSourceOverlap));
  if (outCue.type === "outro_start" || outCue.type === "drop") {
    outgoingEnd = Math.min(outgoing.track.durationMs, Math.round(outCueMs + outSourceOverlap));
  }
  const outgoingStart = Math.max(0, Math.round(outgoingEnd - outSourceOverlap));
  const incomingStart = Math.max(0, Math.round(inCueMs));
  const incomingPlayableEnd = Math.min(
    incoming.track.durationMs,
    Math.round(
      incomingStart + Math.max(inSourceOverlap, incoming.track.durationMs - incomingStart),
    ),
  );

  if (
    outgoingEnd - outgoingStart < outSourceOverlap &&
    outgoing.track.durationMs > outSourceOverlap
  ) {
    blockers.push("Outgoing window cannot fit the phrase overlap");
  }
  if (type !== "crossfade") {
    if (!gridOk(outgoing.analysis, options.allowLowConfidence === true)) {
      blockers.push("Outgoing beat grid is missing, rejected, or low-confidence");
    }
    if (!gridOk(incoming.analysis, options.allowLowConfidence === true)) {
      blockers.push("Incoming beat grid is missing, rejected, or low-confidence");
    }
    if (outCue.inferred) {
      reasons.push(outCue.reason ?? "Outgoing mix-out cue is inferred");
    }
    if (inCue.inferred) {
      reasons.push(inCue.reason ?? "Incoming mix-in cue is inferred");
    }
  } else {
    reasons.push("Equal-power crossfade does not require a validated beat grid");
  }

  if (type === "bass_swap") {
    reasons.push(`Bass swap at bar ${barCount === 32 ? 16 : 8} of ${barCount ?? 16}`);
  }
  if (type === "phrase_mix") {
    reasons.push(`${barCount ?? 16}-bar phrase mix with incoming high-pass fade-in`);
  }

  const energyUp = (incoming.track.energy ?? 0) > (outgoing.track.energy ?? 0);
  const bothHot = (outgoing.track.energy ?? 0) >= 7 && (incoming.track.energy ?? 0) >= 7;
  const scoreBase = type === "crossfade" ? 0.4 : type === "phrase_mix" ? 0.75 : 0.7;
  const score =
    scoreBase + (type === "bass_swap" && (energyUp || bothHot) ? 0.2 : 0) - blockers.length * 0.3;
  const cueConfidences = [outCue.confidence, inCue.confidence].filter(
    (value): value is number => value != null,
  );
  const confidence = Math.min(
    outgoing.analysis?.bpmConfidence ?? (type === "crossfade" ? 0.8 : 0.2),
    incoming.analysis?.bpmConfidence ?? (type === "crossfade" ? 0.8 : 0.2),
    ...cueConfidences,
  );

  return {
    type,
    barCount,
    durationMs,
    targetBpm,
    outgoingTrackId: outgoing.track.id,
    incomingTrackId: incoming.track.id,
    outgoingCueType: outCue.type,
    incomingCueType: inCue.type,
    outgoingCuePositionMs: outCueMs,
    incomingCuePositionMs: inCueMs,
    outgoingPlaybackRate: outgoingRate,
    incomingPlaybackRate: incomingRate,
    outgoingSourceStartMs: outgoingStart,
    outgoingSourceEndMs: outgoingEnd,
    incomingSourceStartMs: incomingStart,
    incomingSourceEndMs: incomingPlayableEnd,
    bassSwap:
      type === "bass_swap"
        ? clampBassSwapParams({ crossoverHz: DEFAULT_BASS_CROSSOVER_HZ }, barCount ?? 16)
        : null,
    automation: automationFor(type, durationMs, barCount),
    score: Number(Math.max(0, score).toFixed(3)),
    confidence: Number(confidence.toFixed(3)),
    feasible: blockers.length === 0,
    reasons,
    blockers,
  };
}

export function planTransition(
  outgoing: TrackBundle,
  incoming: TrackBundle,
  input: PlanTransitionInput,
): {
  outgoingTrackId: string;
  incomingTrackId: string;
  targetBpm: number | null;
  proposals: TransitionProposal[];
} {
  const outBpm = resolveCanonicalBpm(outgoing.track, outgoing.analysis).bpm;
  const inBpm = resolveCanonicalBpm(incoming.track, incoming.analysis).bpm;
  let targetBpm = input.targetBpm ?? null;
  if (targetBpm === null && outBpm && inBpm) {
    const folded = normalizeDnbBpm((outBpm + inBpm) / 2);
    targetBpm = folded?.bpm ?? (outBpm + inBpm) / 2;
  } else if (targetBpm !== null) {
    targetBpm = normalizeDnbBpm(targetBpm)?.bpm ?? targetBpm;
  }
  const barCount = input.barCount ?? DEFAULT_PHRASE_BARS;
  const allow = {
    allowExcessiveTempo: input.allowExcessiveTempo,
    allowLowConfidence: input.allowLowConfidence,
    preferredType: input.preferredType,
    allowDropIn: input.allowDropIn,
  };
  const energyUp = (incoming.track.energy ?? 0) > (outgoing.track.energy ?? 0);
  const bothHot = (outgoing.track.energy ?? 0) >= 7 && (incoming.track.energy ?? 0) >= 7;
  const preferred = input.preferredType ?? "any";
  const proposals: TransitionProposal[] = [];
  const include = (type: TransitionProposal["type"]) =>
    preferred === "any" ||
    preferred === type ||
    (preferred === "crossfade" && type === "crossfade");

  if (include("bass_swap")) {
    proposals.push(propose("bass_swap", barCount, outgoing, incoming, targetBpm, allow));
  }
  if (include("phrase_mix")) {
    proposals.push(propose("phrase_mix", barCount, outgoing, incoming, targetBpm, allow));
  }
  if (include("crossfade") || preferred === "any") {
    proposals.push(propose("crossfade", null, outgoing, incoming, targetBpm, allow));
  }
  proposals.sort((a, b) => {
    if (preferred !== "any") {
      return 0;
    }
    const bassFirst = energyUp || bothHot;
    const rank = (type: TransitionProposal["type"]) =>
      type === "crossfade" ? 2 : type === "bass_swap" ? (bassFirst ? 0 : 1) : bassFirst ? 1 : 0;
    return rank(a.type) - rank(b.type) || b.score - a.score;
  });
  return {
    outgoingTrackId: outgoing.track.id,
    incomingTrackId: incoming.track.id,
    targetBpm,
    proposals,
  };
}

export function validateTransition(
  outgoing: TrackBundle,
  incoming: TrackBundle,
  input: ValidateTransitionInput,
): TransitionValidation {
  const planned = planTransition(outgoing, incoming, {
    outgoingTrackId: outgoing.track.id,
    incomingTrackId: incoming.track.id,
    preferredType: input.type,
    barCount: input.barCount,
    targetBpm: input.targetBpm,
    allowExcessiveTempo: input.allowExcessiveTempo,
    allowLowConfidence: input.allowLowConfidence,
  });
  const match = planned.proposals.find((item) => item.type === input.type) ?? planned.proposals[0];
  const errors: Array<{ code: string; message: string }> = [];
  const warnings: Array<{ code: string; message: string }> = [];
  if (!match) {
    errors.push({ code: "INVALID_SET_PLAN", message: "No matching transition proposal" });
    return { valid: false, feasible: false, errors, warnings };
  }
  for (const blocker of match.blockers) {
    errors.push({ code: "INVALID_SET_PLAN", message: blocker });
  }
  if (input.outgoingPlaybackRate !== undefined) {
    try {
      assertPlaybackRate(input.outgoingPlaybackRate, {
        allowExcessive: input.allowExcessiveTempo,
        maxDeviation: input.maxTempoDeviation,
      });
    } catch (error) {
      errors.push({
        code: "PLAYBACK_RATE_OUT_OF_RANGE",
        message: error instanceof Error ? error.message : "Outgoing playback rate invalid",
      });
    }
  }
  if (input.incomingPlaybackRate !== undefined) {
    try {
      assertPlaybackRate(input.incomingPlaybackRate, {
        allowExcessive: input.allowExcessiveTempo,
        maxDeviation: input.maxTempoDeviation,
      });
    } catch (error) {
      errors.push({
        code: "PLAYBACK_RATE_OUT_OF_RANGE",
        message: error instanceof Error ? error.message : "Incoming playback rate invalid",
      });
    }
  }
  if (input.durationMs !== undefined && match.barCount && planned.targetBpm) {
    const expected = Math.round(phraseDurationMs(match.barCount, planned.targetBpm));
    if (Math.abs(input.durationMs - expected) > 50) {
      warnings.push({
        code: "PHRASE_DURATION",
        message: `Duration ${input.durationMs}ms is not the ${match.barCount}-bar length ${expected}ms at ${planned.targetBpm} BPM`,
      });
    }
  }
  for (const reason of match.reasons) {
    warnings.push({ code: "INFO", message: reason });
  }
  const valid = errors.length === 0;
  return { valid, feasible: match.feasible && valid, errors, warnings };
}
