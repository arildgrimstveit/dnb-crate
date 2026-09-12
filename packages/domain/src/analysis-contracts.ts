import * as z from "zod/v4";

import {
  ANALYSIS_ENGINE_IDS,
  ANALYSIS_JOB_LIST_LIMIT_MAX,
  MAX_TEMPO_DEVIATION,
} from "./constants.ts";
import { cuePointTypeSchema, trackIdSchema } from "./contracts.ts";

export const analysisEngineIdSchema = z.enum(ANALYSIS_ENGINE_IDS);

export const analysisJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const analysisScopeSchema = z.enum(["ids", "planningReady", "unanalyzed", "stale", "all"]);

export const startTrackAnalysisInputSchema = z
  .object({
    trackIds: z.array(trackIdSchema).min(1).max(2000).optional(),
    planningReadyOnly: z
      .boolean()
      .optional()
      .describe("If true, analyze the planning-ready subset (BPM, key, energy, file present)."),
    scope: analysisScopeSchema
      .optional()
      .describe(
        "ids (default) uses trackIds; planningReady / unanalyzed / stale / all select from the catalog.",
      ),
    engines: z
      .array(z.literal("dnb-crate-dsp"))
      .min(1)
      .max(1)
      .optional()
      .describe("Only dnb-crate-dsp is supported. Default is config analysis.defaultEngine."),
  })
  .refine(
    (value) =>
      (value.trackIds?.length ?? 0) > 0 ||
      value.planningReadyOnly === true ||
      (value.scope !== undefined && value.scope !== "ids"),
    {
      message: "Pass trackIds, planningReadyOnly=true, or scope unanalyzed|stale|all|planningReady",
    },
  );

export const getAnalysisStatusInputSchema = z.object({
  analysisJobId: z.string().uuid().optional(),
});

export const getTrackAnalysisInputSchema = z.object({
  trackId: trackIdSchema,
  engine: z.string().min(1).optional(),
});

export const compareTrackAnalysesInputSchema = z.object({
  trackId: trackIdSchema,
});

export const getTrackSectionsInputSchema = z.object({
  trackId: trackIdSchema,
  engine: z.string().min(1).optional(),
});

export const cuePreviewCueSchema = z.enum(["intro_start", "drop", "breakdown", "outro_start"]);

export const createCuePreviewInputSchema = z.object({
  trackId: trackIdSchema,
  cue: cuePreviewCueSchema.optional().describe("Default drop"),
  windowMs: z.number().int().min(2000).max(16_000).optional().describe("Default 8000"),
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
  barCount: z.union([z.literal(8), z.literal(16), z.literal(32)]).optional(),
  targetBpm: z.number().positive().max(400).optional(),
  allowExcessiveTempo: z.boolean().optional(),
  allowLowConfidence: z.boolean().optional(),
  allowDropIn: z.boolean().optional(),
});

export const validateTransitionInputSchema = z.object({
  outgoingTrackId: trackIdSchema,
  incomingTrackId: trackIdSchema,
  type: z.enum(["crossfade", "phrase_mix", "bass_swap"]),
  barCount: z.union([z.literal(8), z.literal(16), z.literal(32)]).optional(),
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
  engines: z.array(z.string()),
  completedTrackIds: z.array(z.string()),
  failedTrackIds: z.array(z.string()),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retryable: z.boolean(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const trackSectionSchema = z.object({
  type: z.enum(["intro", "build", "drop", "breakdown", "bridge", "outro"]),
  startMs: z.number(),
  endMs: z.number(),
  startBar: z.number().int().nullable(),
  endBar: z.number().int().nullable(),
  confidence: z.number(),
  sectionEnergy: z.number(),
});

export const tempoEvidenceSchema = z.object({
  prominence: z.number(),
  stability: z.number(),
  tempoConf: z.number(),
  onGridRatio: z.number(),
  agreement: z.number().optional(),
});

export const sonicDescriptorsSchema = z.object({
  integratedLufs: z.number().nullable(),
  shortTermLufsMean: z.number().nullable(),
  shortTermLufsMax: z.number().nullable(),
  truePeakDb: z.number().nullable(),
  subBassRatio: z.number().nullable(),
  brightness: z.number().nullable(),
  onsetDensity: z.number().nullable(),
  dynamicRange: z.number().nullable(),
  dropIntensity: z.number().nullable(),
  suggestedEnergy: z.number().int().min(1).max(10).nullable(),
  energy: z.number().min(0).max(1).nullable().optional(),
  danceability: z.number().min(0).max(1).nullable().optional(),
  acousticness: z.number().min(0).max(1).nullable().optional(),
  melodicness: z.number().min(0).max(1).nullable().optional(),
  valence: z.number().min(0).max(1).nullable().optional(),
  waveformSummary: z.array(z.number()),
  lowBandEnergy: z.number().nullable(),
  midBandEnergy: z.number().nullable(),
  highBandEnergy: z.number().nullable(),
  chromaVector: z.array(z.number()).length(12).nullable().optional(),
  tempoEvidence: tempoEvidenceSchema.nullable().optional(),
  audioStartMs: z.number().nullable().optional(),
  audioEndMs: z.number().nullable().optional(),
  bars: z
    .object({
      rms: z.array(z.number()),
      sub: z.array(z.number()),
      midFlux: z.array(z.number()),
      onsetDensity: z.array(z.number()),
    })
    .nullable()
    .optional(),
  keyCandidates: z.array(z.string()).max(2).nullable().optional(),
});

export const beatGridSummarySchema = z.object({
  bpm: z.number().nullable(),
  bpmConfidence: z.number().nullable(),
  beatCount: z.number().int(),
  firstDownbeatMs: z.number().nullable(),
  downbeatConfidence: z.number().nullable(),
  tempoStability: z.number().nullable(),
  gridRejected: z.boolean(),
  gridRejectionReason: z.string().nullable(),
  gridSource: z.enum(["analyzed", "reference", "anchor", "sidecar"]).nullable().optional(),
});

export const trackAnalysisSchema = z.object({
  trackId: z.string(),
  analyzerName: z.string(),
  analyzerVersion: z.string(),
  bpm: z.number().nullable(),
  bpmConfidence: z.number().nullable(),
  bpmRaw: z.number().nullable(),
  gridRejected: z.boolean(),
  gridRejectionReason: z.string().nullable(),
  gridSource: z.enum(["analyzed", "reference", "anchor", "sidecar"]).nullable().optional(),
  musicalKey: z.string().nullable(),
  keyConfidence: z.number().nullable(),
  keyMode: z.enum(["major", "minor"]).nullable(),
  camelotKey: z.string().nullable(),
  keyCandidates: z.array(z.string()).max(2).nullable().optional(),
  tempoStability: z.number().nullable(),
  downbeatConfidence: z.number().nullable(),
  integratedLufs: z.number().nullable(),
  truePeakDb: z.number().nullable(),
  lowBandEnergy: z.number().nullable(),
  midBandEnergy: z.number().nullable(),
  highBandEnergy: z.number().nullable(),
  waveformSummary: z.array(z.number()).nullable(),
  beatAnchorMs: z.number().nullable(),
  descriptors: sonicDescriptorsSchema.nullable(),
  engineRuntimeMs: z.number().nullable(),
  analyzedAt: z.string(),
  canonicalBpm: z.number().nullable(),
  canonicalBpmSource: z.enum(["tag", "manual", "analyzed", "published"]).nullable(),
  canonicalKey: z.string().nullable(),
  canonicalKeySource: z.enum(["tag", "manual", "analyzed", "published"]).nullable(),
  suggestedCues: z.array(
    z.object({
      type: cuePointTypeSchema,
      positionMs: z.number().int(),
      beatIndex: z.number().int().nullable(),
      barIndex: z.number().int().nullable(),
      confidence: z.number(),
    }),
  ),
  sections: z.array(trackSectionSchema),
  availableEngines: z.array(z.string()),
  gridSummary: beatGridSummarySchema,
  bpmHint: z.number().nullable().optional(),
  bpmHintConfidence: z.number().nullable().optional(),
  referenceBpm: z.number().nullable().optional(),
});

export const compareTrackAnalysesDataSchema = z.object({
  trackId: z.string(),
  engines: z.array(
    z.object({
      analyzerName: z.string(),
      analyzerVersion: z.string(),
      bpm: z.number().nullable(),
      bpmConfidence: z.number().nullable(),
      gridRejected: z.boolean(),
      musicalKey: z.string().nullable(),
      keyConfidence: z.number().nullable(),
      downbeatConfidence: z.number().nullable(),
      sectionCount: z.number().int(),
      engineRuntimeMs: z.number().nullable(),
      analyzedAt: z.string(),
      chromaVector: z.array(z.number()).length(12).nullable().optional(),
      energy: z.number().min(0).max(1).nullable().optional(),
      danceability: z.number().min(0).max(1).nullable().optional(),
      acousticness: z.number().min(0).max(1).nullable().optional(),
      melodicness: z.number().min(0).max(1).nullable().optional(),
      valence: z.number().min(0).max(1).nullable().optional(),
    }),
  ),
});

export const getTrackSectionsDataSchema = z.object({
  trackId: z.string(),
  analyzerName: z.string(),
  sections: z.array(trackSectionSchema),
});

export const analysisReportEngineRowSchema = z.object({
  trackId: z.string(),
  title: z.string(),
  analyzerName: z.string(),
  bpm: z.number().nullable(),
  bpmConfidence: z.number().nullable(),
  gridRejected: z.boolean(),
  gridSource: z.enum(["analyzed", "reference", "anchor", "sidecar"]).nullable().optional(),
  keyAgreement: z.enum(["exact", "relative", "number_pm1", "clash"]).nullable(),
  sectionCount: z.number().int(),
});

export const analysisReportDataSchema = z.object({
  trackCount: z.number().int(),
  engineCounts: z.record(z.string(), z.number()),
  inRange: z.object({
    count: z.number().int(),
    withinHalf: z.number().int(),
    accepted: z.number().int().optional(),
    acceptedExact: z.number().int().optional(),
  }),
  gridSourceCounts: z
    .object({
      analyzed: z.number().int(),
      reference: z.number().int(),
      anchor: z.number().int(),
      sidecar: z.number().int().optional(),
    })
    .optional(),
  keyAgreementCounts: z
    .object({
      exact: z.number().int(),
      relative: z.number().int(),
      number_pm1: z.number().int(),
      clash: z.number().int(),
      unknown: z.number().int(),
    })
    .optional(),
  outOfRange: z.object({
    count: z.number().int(),
  }),
  publishedOrManualCompared: z.number().int(),
  dspWithinHalfBpm: z.number().int(),
  engines: z.array(analysisReportEngineRowSchema),
  needsReview: z.array(
    z.object({
      trackId: z.string(),
      title: z.string(),
      reason: z.enum(["out-of-range", "disagreement"]),
      canonicalBpm: z.number().nullable(),
      canonicalSource: z.string().nullable(),
      publishedFolded: z.number().nullable(),
      dspBpm: z.number().nullable(),
      engines: z.record(z.string(), z.number().nullable()),
    }),
  ),
  disagreements: z.array(
    z.object({
      trackId: z.string(),
      title: z.string(),
      canonicalBpm: z.number().nullable(),
      canonicalSource: z.string().nullable(),
      engines: z.record(z.string(), z.number().nullable()),
    }),
  ),
});

export const createCuePreviewDataSchema = z.object({
  trackId: z.string(),
  cue: cuePreviewCueSchema,
  positionMs: z.number(),
  outputRelpath: z.string(),
});

export const listAnalysisJobsInputSchema = z.object({
  limit: z.number().int().min(1).max(ANALYSIS_JOB_LIST_LIMIT_MAX).optional(),
});

export const bassSwapParamsSchema = z.object({
  crossoverHz: z.number(),
  swapAtBar: z.number().int(),
  rampMs: z.number().int(),
  lowAttenuationDb: z.number(),
  midDipDb: z.number().optional(),
  lowHandoverBar: z.number().int().optional(),
});

export const automationEventSchema = z.object({
  target: z.enum([
    "outgoing_low",
    "outgoing_mid",
    "outgoing_high",
    "incoming_low",
    "incoming_mid",
    "incoming_high",
    "playback_rate",
  ]),
  action: z.enum(["ramp", "set"]),
  atBar: z.number().optional(),
  durationBars: z.number().optional(),
  atMs: z.number().optional(),
  durationMs: z.number().optional(),
  fromDb: z.number().nullable(),
  toDb: z.number().nullable(),
});

export const transitionProposalSchema = z.object({
  type: z.enum(["crossfade", "phrase_mix", "bass_swap"]),
  barCount: z.union([z.literal(8), z.literal(16), z.literal(32)]).nullable(),
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
  automation: z.array(automationEventSchema),
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
