import type { AnalyzerResult } from "@dnb-crate/audio-analysis";

function medianPeriodMs(times: number[]): number {
  if (times.length < 2) {
    return 0;
  }
  const periods = times
    .slice(1)
    .map((time, index) => time - (times[index] ?? 0))
    .filter((period) => period > 0)
    .sort((a, b) => a - b);
  if (periods.length === 0) {
    return 0;
  }
  return periods[Math.floor(periods.length / 2)] ?? 0;
}

function periodStability(times: number[]): number {
  if (times.length < 4) {
    return times.length < 2 ? 0 : 0.4;
  }
  const periods = times
    .slice(1)
    .map((time, index) => time - (times[index] ?? 0))
    .filter((period) => period > 0)
    .sort((a, b) => a - b);
  const n = periods.length;
  const median = periods[Math.floor(n / 2)] ?? 0;
  if (median <= 0) {
    return 0;
  }
  const q1 = periods[Math.floor(n / 4)] ?? 0;
  const q3 = periods[Math.floor((3 * n) / 4)] ?? 0;
  return Math.max(0, Math.min(1, 1 - Math.max(0, q3 - q1) / median));
}

function phaseAgreement(dspDownbeats: number[], sidecarDownbeats: number[]): number {
  if (dspDownbeats.length === 0 || sidecarDownbeats.length === 0) {
    return 0;
  }
  const period = medianPeriodMs(sidecarDownbeats) || medianPeriodMs(dspDownbeats) || 1379;
  let agrees = 0;
  for (const time of sidecarDownbeats) {
    const nearest = dspDownbeats.reduce(
      (best, candidate) =>
        Math.abs(candidate - time) < Math.abs(best - time) ? candidate : best,
      dspDownbeats[0]!,
    );
    if (Math.abs(nearest - time) <= period * 0.25) {
      agrees += 1;
    }
  }
  return agrees / sidecarDownbeats.length;
}

/** Rhythm/structure from the requested engine; key + descriptors always from the TypeScript DSP result. */
export function mergeAnalyzerResults(
  rhythm: AnalyzerResult,
  dsp: AnalyzerResult,
): AnalyzerResult {
  const stability = periodStability(rhythm.downbeatTimesMs);
  const agreement = phaseAgreement(dsp.downbeatTimesMs, rhythm.downbeatTimesMs);
  return {
    ...rhythm,
    gridSource:
      rhythm.analyzerName === "beat-this" || rhythm.analyzerName === "allin1"
        ? "sidecar"
        : rhythm.gridSource,
    musicalKey: dsp.musicalKey,
    keyConfidence: dsp.keyConfidence,
    keyMode: dsp.keyMode,
    camelotKey: dsp.camelotKey,
    keyRunnerUp: dsp.keyRunnerUp,
    keyCandidates: dsp.keyCandidates ?? dsp.descriptors?.keyCandidates ?? null,
    downbeatConfidence: Number((stability * agreement).toFixed(3)),
    descriptors: dsp.descriptors ?? rhythm.descriptors,
    lowBandEnergy: dsp.lowBandEnergy,
    midBandEnergy: dsp.midBandEnergy,
    highBandEnergy: dsp.highBandEnergy,
    waveformSummary:
      dsp.waveformSummary.length > 0 ? dsp.waveformSummary : rhythm.waveformSummary,
    sections: rhythm.sections.length > 0 ? rhythm.sections : dsp.sections,
    suggestedCues:
      rhythm.suggestedCues.length > 0 ? rhythm.suggestedCues : dsp.suggestedCues,
  };
}
