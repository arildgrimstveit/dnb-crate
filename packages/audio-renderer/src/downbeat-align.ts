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
  mode: "bar" | "beat";
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
  const barMode =
    (input.outgoingDownbeatConfidence ?? 0) >= 0.5 &&
    (input.incomingDownbeatConfidence ?? 0) >= 0.5;
  const mode: "bar" | "beat" = barMode ? "bar" : "beat";
  const periodMs = barMode ? beatPeriod * 4 : beatPeriod;
  if (input.outgoingDownbeatsMs.length === 0 || input.incomingDownbeatsMs.length === 0) {
    return { offsetMs: 0, periodMs, mode };
  }
  const outPhase =
    (nearestTime(input.outgoingDownbeatsMs, input.outgoingOverlapStartMs) -
      input.outgoingOverlapStartMs) /
    outgoingRate;
  const inPhase =
    (nearestTime(input.incomingDownbeatsMs, input.incomingOverlapStartMs) -
      input.incomingOverlapStartMs) /
    incomingRate;
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
  const incomingRate = input.incomingRate > 0 ? input.incomingRate : 1;
  const outgoingRate = input.outgoingRate > 0 ? input.outgoingRate : 1;
  const periodSource = input.periodMs * incomingRate;
  let applied = input.offsetMs;
  let incomingStart = input.incomingStartMs + applied;
  if (incomingStart < 0 && periodSource > 0) {
    applied += periodSource;
    incomingStart = input.incomingStartMs + applied;
  }
  if (incomingStart >= 0 && incomingStart < input.incomingEndMs - 1000) {
    return {
      incomingStartMs: incomingStart,
      outgoingEndMs: input.outgoingEndMs,
      appliedOffsetMs: applied,
    };
  }
  return {
    incomingStartMs: input.incomingStartMs,
    outgoingEndMs: input.outgoingEndMs - input.offsetMs * outgoingRate,
    appliedOffsetMs: input.offsetMs,
  };
}
