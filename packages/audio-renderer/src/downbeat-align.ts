import { outputToSourceMs, sourceToOutputMs } from "@dnb-crate/domain";

export function nearestTime(times: number[], target: number): number {
  if (times.length === 0) {
    return target;
  }
  return times.reduce((best, time) =>
    Math.abs(time - target) < Math.abs(best - target) ? time : best,
  );
}

export function wrapDelta(delta: number, period: number): number {
  if (period <= 0) {
    return 0;
  }
  const half = period / 2;
  return ((((delta + half) % period) + period) % period) - half;
}

export type DownbeatAlignment = {
  offsetMs: number;
  periodMs: number;
  mode: "bar" | "beat" | "phrase";
};

/** Sub-beat/bar offset to add to the incoming source start so downbeats meet at overlap. */
export function downbeatAlignmentOffsetMs(input: {
  outgoingDownbeatsMs: number[];
  incomingDownbeatsMs: number[];
  outgoingOverlapStartMs: number;
  incomingOverlapStartMs: number;
  bpm: number | null;
  outgoingRate?: number;
  incomingRate?: number;
  targetBpm?: number | null;
  outgoingDownbeatConfidence?: number | null;
  incomingDownbeatConfidence?: number | null;
  outgoingPhraseOriginMs?: number | null;
  incomingPhraseOriginMs?: number | null;
}): DownbeatAlignment {
  const outgoingRate = input.outgoingRate && input.outgoingRate > 0 ? input.outgoingRate : 1;
  const incomingRate = input.incomingRate && input.incomingRate > 0 ? input.incomingRate : 1;
  const targetBpm =
    input.targetBpm && input.targetBpm > 0
      ? input.targetBpm
      : input.bpm && input.bpm > 0
        ? input.bpm
        : null;
  const beatPeriod = targetBpm ? 60_000 / targetBpm : 345;
  const phraseMs = beatPeriod * 32;
  const phraseMode =
    input.outgoingPhraseOriginMs != null && input.incomingPhraseOriginMs != null;
  const barMode =
    !phraseMode &&
    (input.outgoingDownbeatConfidence ?? 0) >= 0.5 &&
    (input.incomingDownbeatConfidence ?? 0) >= 0.5;
  const mode: "bar" | "beat" | "phrase" = phraseMode ? "phrase" : barMode ? "bar" : "beat";
  const periodMs = phraseMode ? phraseMs : barMode ? beatPeriod * 4 : beatPeriod;
  if (input.outgoingDownbeatsMs.length === 0 || input.incomingDownbeatsMs.length === 0) {
    return { offsetMs: 0, periodMs, mode };
  }
  const nearestPhrase = (origin: number, target: number, rate: number): number => {
    const sourcePhraseMs = phraseMs * rate;
    const k = Math.round((target - origin) / sourcePhraseMs);
    return origin + k * sourcePhraseMs;
  };
  const outRef =
    phraseMode && input.outgoingPhraseOriginMs != null
      ? nearestPhrase(input.outgoingPhraseOriginMs, input.outgoingOverlapStartMs, outgoingRate)
      : nearestTime(input.outgoingDownbeatsMs, input.outgoingOverlapStartMs);
  const inRef =
    phraseMode && input.incomingPhraseOriginMs != null
      ? nearestPhrase(input.incomingPhraseOriginMs, input.incomingOverlapStartMs, incomingRate)
      : nearestTime(input.incomingDownbeatsMs, input.incomingOverlapStartMs);
  const outPhase = (outRef - input.outgoingOverlapStartMs) / outgoingRate;
  const inPhase = (inRef - input.incomingOverlapStartMs) / incomingRate;
  return {
    offsetMs: Math.round(wrapDelta(inPhase - outPhase, periodMs) * incomingRate),
    periodMs,
    mode,
  };
}

const ALIGN_CONFIRM_MS = 20;

/** Phrase wrap only when the residual is within half a bar; else bar, then beat. */
export function planAlignmentOffsetMs(
  input: Parameters<typeof downbeatAlignmentOffsetMs>[0],
): DownbeatAlignment {
  const targetBpm =
    input.targetBpm && input.targetBpm > 0
      ? input.targetBpm
      : input.bpm && input.bpm > 0
        ? input.bpm
        : 174;
  const beatPeriod = 60_000 / targetBpm;
  const halfBar = beatPeriod * 2;
  const incomingRate = input.incomingRate && input.incomingRate > 0 ? input.incomingRate : 1;
  const canPhrase = input.outgoingPhraseOriginMs != null && input.incomingPhraseOriginMs != null;
  if (canPhrase) {
    const phrase = downbeatAlignmentOffsetMs(input);
    if (Math.abs(phrase.offsetMs) / incomingRate <= halfBar) {
      return phrase;
    }
    const bar = downbeatAlignmentOffsetMs({
      ...input,
      outgoingPhraseOriginMs: null,
      incomingPhraseOriginMs: null,
      outgoingDownbeatConfidence: 1,
      incomingDownbeatConfidence: 1,
    });
    if (Math.abs(bar.offsetMs) / incomingRate <= halfBar) {
      return bar;
    }
    return downbeatAlignmentOffsetMs({
      ...input,
      outgoingPhraseOriginMs: null,
      incomingPhraseOriginMs: null,
      outgoingDownbeatConfidence: 0,
      incomingDownbeatConfidence: 0,
    });
  }
  return downbeatAlignmentOffsetMs(input);
}

export function isAlignmentConfirm(offsetMs: number): boolean {
  return Math.abs(offsetMs) <= ALIGN_CONFIRM_MS;
}

export function applyAlignmentOffset(input: {
  incomingStartMs: number;
  incomingEndMs: number;
  outgoingEndMs: number;
  offsetMs: number;
  periodMs: number;
  incomingRate: number;
  outgoingRate: number;
  overlapMs?: number;
}): {
  incomingStartMs: number;
  outgoingEndMs: number;
  appliedOffsetMs: number;
  overlapMs: number | undefined;
  movedOutgoingEnd: boolean;
} {
  const outgoingRate = input.outgoingRate > 0 ? input.outgoingRate : 1;
  const incomingRate = input.incomingRate > 0 ? input.incomingRate : 1;
  const incomingStart = input.incomingStartMs + input.offsetMs;
  if (incomingStart >= 0 && incomingStart < input.incomingEndMs - 1000) {
    return {
      incomingStartMs: incomingStart,
      outgoingEndMs: input.outgoingEndMs,
      appliedOffsetMs: input.offsetMs,
      overlapMs: input.overlapMs,
      movedOutgoingEnd: false,
    };
  }
  return {
    incomingStartMs: input.incomingStartMs,
    outgoingEndMs:
      input.outgoingEndMs - outputToSourceMs(sourceToOutputMs(input.offsetMs, incomingRate), outgoingRate),
    appliedOffsetMs: input.offsetMs,
    // Keep the output overlap fixed: changing it by the same amount cancels the phase correction.
    overlapMs: input.overlapMs,
    movedOutgoingEnd: true,
  };
}
