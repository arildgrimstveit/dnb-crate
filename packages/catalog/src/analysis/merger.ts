import type { AnalyzerResult } from "@dnb-crate/audio-analysis";
import { downbeatPhaseAgreement, periodStats } from "@dnb-crate/domain";

function periodStability(times: number[]): number {
  const stats = periodStats(times);
  if (!stats) {
    return times.length < 2 ? 0 : 0.4;
  }
  return Math.max(0, Math.min(1, 1 - stats.cv));
}

/** Rhythm/structure from the requested engine; key + descriptors always from the TypeScript DSP result. */
export function mergeAnalyzerResults(
  rhythm: AnalyzerResult,
  dsp: AnalyzerResult,
): AnalyzerResult {
  const stability = periodStability(rhythm.downbeatTimesMs);
  const agreement = downbeatPhaseAgreement(dsp.downbeatTimesMs, rhythm.downbeatTimesMs);
  const dspDescriptors = dsp.descriptors ?? rhythm.descriptors;
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
    downbeatConfidence: Number(stability.toFixed(3)),
    tempoStability: Number(stability.toFixed(3)),
    descriptors: dspDescriptors
      ? {
          ...dspDescriptors,
          tempoEvidence: {
            prominence: dspDescriptors.tempoEvidence?.prominence ?? 0,
            stability,
            tempoConf: dspDescriptors.tempoEvidence?.tempoConf ?? 0,
            onGridRatio: dspDescriptors.tempoEvidence?.onGridRatio ?? 0,
            agreement,
          },
        }
      : null,
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
