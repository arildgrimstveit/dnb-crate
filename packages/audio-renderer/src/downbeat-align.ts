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

/** Sub-beat offset to add to the incoming source start so downbeats meet at overlap. */
export function downbeatAlignmentOffsetMs(input: {
  outgoingDownbeatsMs: number[];
  incomingDownbeatsMs: number[];
  outgoingOverlapStartMs: number;
  incomingOverlapStartMs: number;
  bpm: number | null;
  outgoingRate?: number;
  incomingRate?: number;
  targetBpm?: number | null;
}): number {
  if (input.outgoingDownbeatsMs.length === 0 || input.incomingDownbeatsMs.length === 0) {
    return 0;
  }
  const outgoingRate = input.outgoingRate && input.outgoingRate > 0 ? input.outgoingRate : 1;
  const incomingRate = input.incomingRate && input.incomingRate > 0 ? input.incomingRate : 1;
  const targetBpm =
    input.targetBpm && input.targetBpm > 0
      ? input.targetBpm
      : input.bpm && input.bpm > 0
        ? input.bpm
        : null;
  const period = targetBpm ? 60_000 / targetBpm : 345;
  const outPhase =
    (nearestTime(input.outgoingDownbeatsMs, input.outgoingOverlapStartMs) -
      input.outgoingOverlapStartMs) /
    outgoingRate;
  const inPhase =
    (nearestTime(input.incomingDownbeatsMs, input.incomingOverlapStartMs) -
      input.incomingOverlapStartMs) /
    incomingRate;
  return Math.round(wrapDelta(inPhase - outPhase, period) * incomingRate);
}
