export type PeriodStats = {
  medianMs: number;
  cv: number;
  startToEndDriftMs: number;
};

function periodsFrom(times: number[]): number[] {
  const periods: number[] = [];
  for (let i = 1; i < times.length; i += 1) {
    const period = times[i]! - times[i - 1]!;
    if (period > 0) {
      periods.push(period);
    }
  }
  return periods;
}

export function periodStats(times: number[]): PeriodStats | null {
  const periods = periodsFrom(times);
  if (periods.length === 0) {
    return null;
  }
  const sorted = [...periods].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  if (median <= 0) {
    return null;
  }
  const mean = periods.reduce((sum, value) => sum + value, 0) / periods.length;
  const variance = periods.reduce((sum, value) => sum + (value - mean) ** 2, 0) / periods.length;
  const first = periods[0]!;
  const last = periods[periods.length - 1]!;
  return {
    medianMs: median,
    cv: Math.sqrt(variance) / median,
    startToEndDriftMs: last - first,
  };
}

export function downbeatPhaseAgreement(
  left: number[],
  right: number[],
  toleranceRatio = 0.25,
): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const stats = periodStats(right) ?? periodStats(left);
  const period = stats?.medianMs ?? 1379;
  let agrees = 0;
  for (const time of right) {
    const nearest = left.reduce(
      (best, candidate) => (Math.abs(candidate - time) < Math.abs(best - time) ? candidate : best),
      left[0]!,
    );
    if (Math.abs(nearest - time) <= period * toleranceRatio) {
      agrees += 1;
    }
  }
  return agrees / right.length;
}

export function bpmDisagrees(left: number | null, right: number | null, threshold = 1): boolean {
  if (left == null || right == null) {
    return false;
  }
  return Math.abs(left - right) > threshold;
}
