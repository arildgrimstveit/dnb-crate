import * as z from "zod/v4";

import {
  MAX_PREVIEW_WINDOW_MS,
  MAX_RENDER_EDGE_FADE_MS,
  MIN_PREVIEW_WINDOW_MS,
  RENDER_JOB_LIST_LIMIT_MAX,
} from "./constants.ts";

const renderIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  entryId: z.string().optional(),
  trackId: z.string().optional(),
});

export const renderJobIdSchema = z.string().uuid();

export const renderJobKindSchema = z.enum(["preview", "full"]);
export const renderJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const renderJobSchema = z.object({
  id: z.string(),
  setPlanId: z.string(),
  kind: renderJobKindSchema,
  status: renderJobStatusSchema,
  progress: z.number().min(0).max(1),
  outputFormat: z.literal("wav"),
  outputRootRelativePath: z.string().nullable(),
  outputFileName: z.string().nullable(),
  outputChecksumSha256: z.string().nullable(),
  transitionId: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retryable: z.boolean(),
  warnings: z.array(z.string()),
  progressMessage: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const renderReadinessSchema = z.object({
  ready: z.boolean(),
  ffmpegAvailable: z.boolean(),
  ffprobeAvailable: z.boolean(),
  ffmpegVersion: z.string().nullable(),
  ffprobeVersion: z.string().nullable(),
  issues: z.array(renderIssueSchema),
});

export const renderManifestTrackSchema = z.object({
  trackId: z.string(),
  sourceFingerprint: z.string(),
  entryId: z.string(),
  sourceStartMs: z.number().int(),
  sourceEndMs: z.number().int(),
  timelineStartMs: z.number().int(),
  playbackRate: z.number(),
  gainDb: z.number(),
  overlapToNextMs: z.number().int().nullable(),
  transitionId: z.string().nullable(),
  transitionTemplate: z.enum(["equal_power_crossfade", "phrase_mix", "bass_swap", "none"]),
  requestedTransitionType: z
    .enum(["crossfade", "phrase_mix", "bass_swap", "double_drop"])
    .nullable(),
  analysisVersion: z.string().nullable(),
  bpmConfidence: z.number().nullable(),
  downbeatOffsetMs: z.number().nullable(),
  alignmentPeriodMs: z.number().nullable().optional(),
  alignmentMode: z.enum(["bar", "beat"]).nullable().optional(),
});

export const renderManifestV1Schema = z.object({
  schemaVersion: z.literal(1),
  rendererVersion: z.string(),
  applicationVersion: z.string(),
  renderJobId: z.string(),
  setPlanId: z.string(),
  setPlanContentHash: z.string(),
  kind: renderJobKindSchema,
  outputFormat: z.literal("wav"),
  outputSampleRateHz: z.number().int(),
  outputChannels: z.number().int(),
  outputDurationMs: z.number().int(),
  outputChecksumSha256: z.string(),
  integratedLufs: z.number().nullable(),
  truePeakDb: z.number().nullable(),
  loudnessTargetLufs: z.number(),
  truePeakCeilingDb: z.number(),
  ffmpegVersion: z.string(),
  ffprobeVersion: z.string(),
  invocation: z.string(),
  tracks: z.array(renderManifestTrackSchema),
  automation: z
    .array(
      z.object({
        atMs: z.number(),
        durationMs: z.number(),
        target: z.enum([
          "outgoing_low",
          "incoming_low",
          "outgoing_high",
          "incoming_high",
          "playback_rate",
        ]),
        action: z.enum(["fade_in", "fade_out", "set"]),
        value: z.number(),
      }),
    )
    .optional(),
  warnings: z.array(z.string()),
  createdAt: z.string(),
});

export const startSetRenderInputSchema = z.object({
  setPlanId: z.string().uuid(),
  outputFormat: z.literal("wav").optional().describe("WAV only. MP3 is not available yet."),
  edgeFadeMs: z
    .number()
    .int()
    .min(0)
    .max(MAX_RENDER_EDGE_FADE_MS)
    .optional()
    .describe("Optional fade at the absolute start and end of the mix. Default 0."),
  allowLowConfidence: z
    .boolean()
    .optional()
    .describe("Allow phrase/bass-swap renders when analysis confidence is below the threshold."),
  allowExcessiveTempo: z.boolean().optional().describe("Allow playback rates beyond ±3%."),
});

export const createTransitionPreviewInputSchema = z.object({
  setPlanId: z.string().uuid(),
  transitionId: z.string().uuid().describe("transitionToNext.id on the outgoing set-plan entry"),
  windowMs: z
    .number()
    .int()
    .min(MIN_PREVIEW_WINDOW_MS)
    .max(MAX_PREVIEW_WINDOW_MS)
    .optional()
    .describe("Target preview length, 30–60 seconds. Default 45 seconds."),
  template: z
    .enum(["crossfade", "phrase_mix", "bass_swap"])
    .optional()
    .describe("Override the planned transition template for this preview."),
  barCount: z.union([z.literal(16), z.literal(32)]).optional(),
  allowLowConfidence: z.boolean().optional(),
});

export const getRenderStatusInputSchema = z.object({
  renderJobId: renderJobIdSchema,
});

export const getRenderManifestInputSchema = z.object({
  renderJobId: renderJobIdSchema,
});

export const listRenderJobsInputSchema = z.object({
  setPlanId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(RENDER_JOB_LIST_LIMIT_MAX).optional(),
  cursor: z.string().min(1).max(500).optional(),
});

export const cancelRenderJobInputSchema = z.object({
  renderJobId: renderJobIdSchema,
  confirm: z.literal(true).describe("Required. Cancellation kills the FFmpeg child process."),
});

export const cancelRenderJobDataSchema = z.object({
  cancelled: z.boolean(),
  renderJobId: z.string(),
  status: renderJobStatusSchema,
});

export const listRenderJobsDataSchema = z.object({
  jobs: z.array(renderJobSchema),
  nextCursor: z.string().nullable(),
});
