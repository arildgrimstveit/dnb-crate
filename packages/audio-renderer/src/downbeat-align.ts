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
  const nearestPhrase = (origin: number, target: number): number => {
    const k = Math.round((target - origin) / phraseMs);
    return origin + k * phraseMs;
  };
  const outRef =
    phraseMode && input.outgoingPhraseOriginMs != null
      ? nearestPhrase(input.outgoingPhraseOriginMs, input.outgoingOverlapStartMs)
      : nearestTime(input.outgoingDownbeatsMs, input.outgoingOverlapStartMs);
  const inRef =
    phraseMode && input.incomingPhraseOriginMs != null
      ? nearestPhrase(input.incomingPhraseOriginMs, input.incomingOverlapStartMs)
      : nearestTime(input.incomingDownbeatsMs, input.incomingOverlapStartMs);
  const outPhase = (outRef - input.outgoingOverlapStartMs) / outgoingRate;
  const inPhase = (inRef - input.incomingOverlapStartMs) / incomingRate;
  return {
    offsetMs: Math.round(wrapDelta(inPhase - outPhase, periodMs) * incomingRate),
    periodMs,
    mode,
  };
}

export function applyAlignmentOffset(input: {
  incomingStartMs: number;
  incomingEndMs: number;
  outgoingEndMs: number;
  offsetMs: number;
  periodMs: number;
  incomingRate: number;
  outgoingRate: number;
}): { incomingStartMs: number; outgoingEndMs: number; appliedOffsetMs: number } {
  const outgoingRate = input.outgoingRate > 0 ? input.outgoingRate : 1;
  const incomingStart = input.incomingStartMs + input.offsetMs;
  if (incomingStart >= 0 && incomingStart < input.incomingEndMs - 1000) {
    return {
      incomingStartMs: incomingStart,
      outgoingEndMs: input.outgoingEndMs,
      appliedOffsetMs: input.offsetMs,
    };
  }
  return {
    incomingStartMs: input.incomingStartMs,
    outgoingEndMs: input.outgoingEndMs - input.offsetMs * outgoingRate,
    appliedOffsetMs: input.offsetMs,
  };
}
