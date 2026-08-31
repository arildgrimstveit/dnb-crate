import * as z from "zod/v4";

import { ANALYSIS_JOB_LIST_LIMIT_MAX, MAX_TEMPO_DEVIATION } from "./constants.ts";
import { cuePointTypeSchema, trackIdSchema } from "./contracts.ts";

export const analysisJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const startTrackAnalysisInputSchema = z
  .object({
    trackIds: z.array(trackIdSchema).min(1).max(100).optional(),
    planningReadyOnly: z
      .boolean()
      .optional()
      .describe("If true, analyze the planning-ready subset (BPM, key, energy, file present)."),
  })
  .refine((value) => (value.trackIds?.length ?? 0) > 0 || value.planningReadyOnly === true, {
    message: "Pass trackIds or planningReadyOnly=true",
  });

export const getAnalysisStatusInputSchema = z.object({
  analysisJobId: z.string().uuid().optional(),
});

export const getTrackAnalysisInputSchema = z.object({
  trackId: trackIdSchema,
});

export const setBeatAnchorInputSchema = z.object({
  trackId: trackIdSchema,
  positionMs: z
    .number()
    .int()
    .nonnegative()
    .describe("Manual downbeat/beat anchor. Reconstructs the grid from canonical BPM."),
});

export const planTransitionInputSchema = z.object({
  outgoingTrackId: trackIdSchema,
  incomingTrackId: trackIdSchema,
  preferredType: z.enum(["phrase_mix", "bass_swap", "crossfade", "any"]).optional(),
  barCount: z.union([z.literal(16), z.literal(32)]).optional(),
  targetBpm: z.number().positive().max(400).optional(),
  allowExcessiveTempo: z.boolean().optional(),
  allowLowConfidence: z.boolean().optional(),
});

export const validateTransitionInputSchema = z.object({
  outgoingTrackId: trackIdSchema,
  incomingTrackId: trackIdSchema,
  type: z.enum(["crossfade", "phrase_mix", "bass_swap"]),
  barCount: z.union([z.literal(16), z.literal(32)]).optional(),
  durationMs: z.number().int().min(1000).max(120_000).optional(),
  targetBpm: z.number().positive().max(400).optional(),
  outgoingPlaybackRate: z.number().positive().optional(),
  incomingPlaybackRate: z.number().positive().optional(),
  allowExcessiveTempo: z.boolean().optional(),
  allowLowConfidence: z.boolean().optional(),
  maxTempoDeviation: z
    .number()
    .min(0)
    .max(0.2)
    .optional()
    .describe(`Default ${MAX_TEMPO_DEVIATION}`),
});

export const analysisJobSchema = z.object({
  id: z.string(),
  status: analysisJobStatusSchema,
  progress: z.number().min(0).max(1),
  trackIds: z.array(z.string()),
  completedTrackIds: z.array(z.string()),
  failedTrackIds: z.array(z.string()),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retryable: z.boolean(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const trackAnalysisSchema = z.object({
  trackId: z.string(),
  analyzerName: z.string(),
  analyzerVersion: z.string(),
  bpm: z.number().nullable(),
  bpmConfidence: z.number().nullable(),
  bpmRaw: z.number().nullable(),
  beatTimesMs: z.array(z.number()),
  downbeatTimesMs: z.array(z.number()),
  gridRejected: z.boolean(),
  gridRejectionReason: z.string().nullable(),
  musicalKey: z.string().nullable(),
  keyConfidence: z.number().nullable(),
  integratedLufs: z.number().nullable(),
  truePeakDb: z.number().nullable(),
  lowBandEnergy: z.number().nullable(),
  midBandEnergy: z.number().nullable(),
  highBandEnergy: z.number().nullable(),
  waveformSummary: z.array(z.number()).nullable(),
  beatAnchorMs: z.number().nullable(),
  analyzedAt: z.string(),
  canonicalBpm: z.number().nullable(),
  canonicalBpmSource: z.enum(["tag", "manual", "analyzed"]).nullable(),
  canonicalKey: z.string().nullable(),
  canonicalKeySource: z.enum(["tag", "manual", "analyzed"]).nullable(),
  suggestedCues: z.array(
    z.object({
      type: cuePointTypeSchema,
      positionMs: z.number().int(),
      beatIndex: z.number().int().nullable(),
      barIndex: z.number().int().nullable(),
      confidence: z.number(),
    }),
  ),
});

export const listAnalysisJobsInputSchema = z.object({
  limit: z.number().int().min(1).max(ANALYSIS_JOB_LIST_LIMIT_MAX).optional(),
});

export const bassSwapParamsSchema = z.object({
  crossoverHz: z.number(),
  swapAtBar: z.number().int(),
  rampMs: z.number().int(),
  lowAttenuationDb: z.number(),
});

export const transitionProposalSchema = z.object({
  type: z.enum(["crossfade", "phrase_mix", "bass_swap"]),
  barCount: z.union([z.literal(16), z.literal(32)]).nullable(),
  durationMs: z.number().int(),
  targetBpm: z.number().nullable(),
  outgoingTrackId: z.string(),
  incomingTrackId: z.string(),
  outgoingCueType: cuePointTypeSchema.nullable(),
  incomingCueType: cuePointTypeSchema.nullable(),
  outgoingCuePositionMs: z.number().nullable(),
  incomingCuePositionMs: z.number().nullable(),
  outgoingPlaybackRate: z.number(),
  incomingPlaybackRate: z.number(),
  outgoingSourceStartMs: z.number().int(),
  outgoingSourceEndMs: z.number().int(),
  incomingSourceStartMs: z.number().int(),
  incomingSourceEndMs: z.number().int(),
  bassSwap: bassSwapParamsSchema.nullable(),
  automation: z.array(
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
  ),
  score: z.number(),
  confidence: z.number(),
  feasible: z.boolean(),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});

export const planTransitionDataSchema = z.object({
  outgoingTrackId: z.string(),
  incomingTrackId: z.string(),
  targetBpm: z.number().nullable(),
  proposals: z.array(transitionProposalSchema),
});

export const validateTransitionDataSchema = z.object({
  valid: z.boolean(),
  feasible: z.boolean(),
  errors: z.array(z.object({ code: z.string(), message: z.string() })),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});

export const listAnalysisJobsDataSchema = z.object({
  jobs: z.array(analysisJobSchema),
});
