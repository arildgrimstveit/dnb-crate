export type { ProcessRunner, RunRequest, RunResult } from "./runner.ts";
export { ProcessRunError } from "./runner.ts";
export { createNodeProcessRunner } from "./node-runner.ts";
export { createFakeFfmpegRunner } from "./fake-runner.ts";
export {
  detectFfmpeg,
  ffmpegAlignedReady,
  ffmpegMixReady,
  parseFilterComplexScriptSupport,
  parseFilterList,
  parseVersionLine,
  requireAlignedFfmpeg,
  requireFfmpeg,
  type FfmpegBinaries,
} from "./detect.ts";
export {
  buildAcrossfadeFilter,
  buildBassSwapFilter,
  buildMixFilter,
  buildPhraseMixFilter,
  estimateArgvChars,
  expectedDurationMs,
  limiterAmplitudeFromCeilingDb,
  mixFilterArgs,
  outputDurationSec,
  redactInvocation,
  type FilterGraphOptions,
  type FilterTrim,
  type MixTransitionKind,
  type MixTransitionSpec,
} from "./filter-graph.ts";
export { parseEbur128, parseFfprobeJson, parseOutTimeMs, parseSilenceSpans } from "./parse.ts";
export { probeAudioFile } from "./probe.ts";
export type { ProbeResult } from "./parse.ts";
export { renderMix, type MixRequest, type MixResult, type MixSegment } from "./mix.ts";
export { sha256File, sha256Json, sha256Text } from "./hash.ts";
