import type { AutomationEvent } from "./analysis.ts";
import type { TransitionType } from "./planning.ts";

export type RenderJobKind = "preview" | "full";
export type RenderJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type RenderOutputFormat = "wav";

export type RenderJob = {
  id: string;
  setPlanId: string;
  kind: RenderJobKind;
  status: RenderJobStatus;
  progress: number;
  outputFormat: RenderOutputFormat;
  outputRootRelativePath: string | null;
  outputFileName: string | null;
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
};

export type RenderManifestV1 = {
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
  integratedLufs: number | null;
  truePeakDb: number | null;
  loudnessTargetLufs: number;
  truePeakCeilingDb: number;
  ffmpegVersion: string;
  ffprobeVersion: string;
  invocation: string;
  tracks: RenderManifestTrack[];
  automation?: AutomationEvent[];
  warnings: string[];
  createdAt: string;
};

export type StartSetRenderInput = {
  setPlanId: string;
  outputFormat?: RenderOutputFormat;
  edgeFadeMs?: number;
  allowLowConfidence?: boolean;
  allowExcessiveTempo?: boolean;
};

export type CreateTransitionPreviewInput = {
  setPlanId: string;
  transitionId: string;
  windowMs?: number;
  template?: "crossfade" | "phrase_mix" | "bass_swap";
  barCount?: 16 | 32;
  allowLowConfidence?: boolean;
};

export type ListRenderJobsResult = {
  jobs: RenderJob[];
  nextCursor: string | null;
};
