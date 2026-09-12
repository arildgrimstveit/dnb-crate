export type { ProcessRunner, RunRequest, RunResult } from "./runner.ts";
export { ProcessRunError } from "./runner.ts";
export { createNodeProcessRunner } from "./node-runner.ts";
export { createFakeFfmpegRunner } from "./fake-runner.ts";
export {
  detectFfmpeg,
  ffmpegAlignedReady,
  ffmpegMixReady,
  parseAfadeUnitySupport,
  parseFilterComplexScriptSupport,
  parseFilterList,
  parseVersionLine,
  requireAlignedFfmpeg,
  requireFfmpeg,
  type FfmpegBinaries,
} from "./detect.ts";
export {
  buildAcrossfadeFilter,
  buildBandMixFilter,
  buildBassSwapFilter,
  buildMixFilter,
  buildPhraseMixFilter,
  prefixIsolationRunInSec,
  PREFIX_ISOLATION_RUN_IN_BARS,
  PREFIX_ISOLATION_SPLICE_SEC,
  rubberbandTempoFilter,
  type TempoEngine,
  estimateArgvChars,
  expectedDurationMs,
  limiterAmplitudeFromCeilingDb,
  mixFilterArgs,
  outputDurationSec,
  redactInvocation,
  RATE_SPLICE_XFADE_SEC,
  type FilterGraphOptions,
  type FilterTrim,
  type MixTransitionKind,
  type MixTransitionSpec,
  type StretchScope,
} from "./filter-graph.ts";
export { parseEbur128, parseFfprobeJson, parseOutTimeMs, parseSilenceSpans } from "./parse.ts";
export type { SilenceSpan } from "./parse.ts";
export { probeAudioFile } from "./probe.ts";
export type { ProbeResult } from "./parse.ts";
export { renderMix, type MixRequest, type MixResult, type MixSegment } from "./mix.ts";
export {
  MIX_TAG_ARTIST,
  buildCueSheet,
  buildFfmetadataFile,
  buildMixTracklist,
  escapeFfmetadataValue,
  formatCueIndex,
  formatMixTimestamp,
  mixTagsFromTracklist,
  trackCredit,
  type MixChapterTag,
  type MixOutputTags,
} from "./output-tags.ts";
export {
  applyAlignmentOffset,
  downbeatAlignmentOffsetMs,
  isAlignmentConfirm,
  nearestTime,
  planAlignmentOffsetMs,
  wrapDelta,
} from "./downbeat-align.ts";
export type { DownbeatAlignment } from "./downbeat-align.ts";
export { sha256File, sha256Json, sha256Text } from "./hash.ts";
export {
  clampMakeupDb,
  prepareCliStretchedSegments,
  resolveRubberbandCli,
  rubberbandCliArgs,
  RUBBERBAND_MAKEUP_CLAMP_DB,
} from "./rubberband-cli.ts";
