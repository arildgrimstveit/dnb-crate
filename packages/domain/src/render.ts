import type { AutomationEvent } from "./analysis.ts";
import type { TransitionType } from "./planning.ts";

export type RenderJobKind = "preview" | "full";
export type RenderJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type RenderOutputFormat = "flac" | "wav";

export type RenderJob = {
  id: string;
  setPlanId: string;
  kind: RenderJobKind;
  status: RenderJobStatus;
  progress: number;
  outputFormat: RenderOutputFormat;
  outputRootRelativePath: string | null;
  outputFileName: string | null;
  listenRootRelativePath: string | null;
  listenFileName: string | null;
  outputChecksumSha256: string | null;
  transitionId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  warnings: string[];
  progressMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type RenderReadiness = {
  ready: boolean;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
  issues: Array<{
    code: string;
    message: string;
    entryId?: string;
    trackId?: string;
  }>;
};

export type RenderManifestTrack = {
  appliedRecipeId?: string;
  appliedRecipeFingerprint?: string;
  recipeReuseMode?: string;
  trackId: string;
  sourceFingerprint: string;
  entryId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  timelineStartMs: number;
  playbackRate: number;
  gainDb: number;
  overlapToNextMs: number | null;
  transitionId: string | null;
  transitionTemplate: "equal_power_crossfade" | "phrase_mix" | "bass_swap" | "none";
  requestedTransitionType: TransitionType | null;
  analysisVersion: string | null;
  bpmConfidence: number | null;
  downbeatOffsetMs: number | null;
  alignmentPeriodMs: number | null;
  alignmentMode?: "bar" | "beat" | "phrase" | null;
  barCount?: number | null;
  phraseShape?: string | null;
  sequentialHandoff?: "legacy" | "early" | "supported" | null;
  landingFadeBars?: 2 | 4 | 8 | null;
  landingCarryBars?: 2 | 3.5 | 4 | 4.5 | null;
  landingIncomingFadeBars?: 8 | 16 | 32 | null;
  exitKind?: string | null;
  mixOutMs?: number | null;
  mixInMs?: number | null;
  incomingDropMs?: number | null;
  outgoingLufs?: number | null;
  incomingLufs?: number | null;
  camelotDistance?: number | null;
};

export type FrozenJoinEvidence = {
  outgoingTrackId: string;
  incomingTrackId: string;
  outgoingAnalysisVersion: string | null;
  incomingAnalysisVersion: string | null;
  outgoingBeatsMs: number[];
  incomingBeatsMs: number[];
  outgoingCamelotKey: string | null;
  incomingCamelotKey: string | null;
  outgoingAudioEndMs: number | null;
  outgoingTailEnergy: number | null;
  incomingHeadEnergy: number | null;
  incomingDropMs: number | null;
  recipeVersion: number | null;
  intent: "sustain" | "lift" | "breather" | null;
};

export type RenderManifestV1 = {
  rateRegionsVersion?: 2;
  schemaVersion: 1;
  rendererVersion: string;
  applicationVersion: string;
  renderJobId: string;
  setPlanId: string;
  setPlanContentHash: string;
  kind: RenderJobKind;
  outputFormat: RenderOutputFormat;
  outputSampleRateHz: number;
  outputChannels: number;
  outputDurationMs: number;
  outputChecksumSha256: string;
  listenRootRelativePath?: string;
  listenBitDepth?: 16;
  integratedLufs: number | null;
  truePeakDb: number | null;
  loudnessTargetLufs: number;
  truePeakCeilingDb: number;
  ffmpegVersion: string;
  ffprobeVersion: string;
  rubberbandCliPath?: string | null;
  rubberbandSha256?: string | null;
  audioEngineId?: string;
  staticGainDb?: number | null;
  limiterApplied?: boolean;
  stretchEngine?: string;
  stretchEngines?: string[];
  listenIntegratedLufs?: number | null;
  listenTruePeakDb?: number | null;
  invocation: string;
  tracks: RenderManifestTrack[];
  joinEvidence?: FrozenJoinEvidence[];
  automation?: AutomationEvent[];
  warnings: string[];
  createdAt: string;
};

export type StartSetRenderInput = {
  setPlanId: string;
  outputFormat?: "flac";
  edgeFadeMs?: number;
  allowLowConfidence?: boolean;
  allowExcessiveTempo?: boolean;
};

export type CreateTransitionPreviewInput = {
  setPlanId: string;
  transitionId: string;
  windowMs?: number;
  template?: "crossfade" | "phrase_mix" | "bass_swap";
  barCount?: 8 | 16 | 32;
  allowLowConfidence?: boolean;
};

export type ListRenderJobsResult = {
  jobs: RenderJob[];
  nextCursor: string | null;
};
