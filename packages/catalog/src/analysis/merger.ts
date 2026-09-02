import type { AnalyzerResult } from "@dnb-crate/audio-analysis";

/** Rhythm/structure from the requested engine; key + descriptors always from the TypeScript DSP result. */
export function mergeAnalyzerResults(
  rhythm: AnalyzerResult,
  dsp: AnalyzerResult,
): AnalyzerResult {
  return {
    ...rhythm,
    musicalKey: dsp.musicalKey,
    keyConfidence: dsp.keyConfidence,
    keyMode: dsp.keyMode,
    camelotKey: dsp.camelotKey,
    keyRunnerUp: dsp.keyRunnerUp,
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
