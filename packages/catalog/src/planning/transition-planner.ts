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

function cueByType(cues: CuePoint[], type: CuePointType): CuePoint | undefined {
  return cues.find((cue) => cue.type === type);
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

function pickOutgoingCue(bundle: TrackBundle): { type: CuePointType | null; ms: number } {
  const outro = cueByType(bundle.cues, "outro_start") ?? cueByType(bundle.cues, "drop");
  if (outro) {
    return { type: outro.type, ms: outro.positionMs };
  }
  return { type: null, ms: Math.max(0, bundle.track.durationMs - 1) };
}

function pickIncomingCue(bundle: TrackBundle): { type: CuePointType | null; ms: number } {
  const intro = cueByType(bundle.cues, "intro_start") ?? cueByType(bundle.cues, "drop");
  if (intro) {
    return { type: intro.type, ms: intro.positionMs };
  }
  return { type: null, ms: 0 };
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
  options: { allowExcessiveTempo?: boolean; allowLowConfidence?: boolean },
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
  const inCue = pickIncomingCue(incoming);
  const outCueMs = outBeats.length > 0 ? snappedPosition(outCue.ms, outBeats) : outCue.ms;
  const inCueMs = inBeats.length > 0 ? snappedPosition(inCue.ms, inBeats) : inCue.ms;

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
    outgoingEnd - outgoingStart <= outSourceOverlap &&
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
    if (!outCue.type && !options.allowLowConfidence) {
      blockers.push("Outgoing intro/drop/outro cue is missing");
    }
    if (!inCue.type && !options.allowLowConfidence) {
      blockers.push("Incoming intro/drop cue is missing");
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
  const confidence = Math.min(
    outgoing.analysis?.bpmConfidence ?? (type === "crossfade" ? 0.8 : 0.2),
    incoming.analysis?.bpmConfidence ?? (type === "crossfade" ? 0.8 : 0.2),
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
