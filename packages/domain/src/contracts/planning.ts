import * as z from "zod/v4";
import { transitionTypeSchema } from "../transition-type.ts";
import { renderReadinessSchema } from "../render-contracts.ts";
import {
  descriptorFiltersSchema,
  genreFiltersSchema,
  stringListSchema,
  trackIdSchema,
  validationIssueSchema,
} from "./common.ts";

const energyArcPointSchema = z.object({
  atFraction: z.number().min(0).max(1),
  targetEnergy: z.number().min(1).max(10),
});

export const getPlanningReadinessInputSchema = z.object({
  trackId: trackIdSchema.optional().describe("Omit to summarize the whole catalog"),
});

export const findCompatibleTracksInputSchema = z.object({
  sourceTrackId: trackIdSchema,
  direction: z
    .enum(["up", "down", "any"])
    .optional()
    .describe("Energy direction relative to the source. Default any."),
  limit: z.number().int().min(1).max(50).optional(),
  preferredMoods: stringListSchema.optional(),
  preferredSubgenres: stringListSchema.optional(),
  preferredTags: stringListSchema.optional(),
  harmonicImportance: z.number().min(0).max(1).optional(),
  subBassMin: z.number().min(0).max(1).optional(),
  brightnessMin: z.number().min(0).max(1).optional(),
  energyMin: z.number().int().min(1).max(10).optional(),
  energyMax: z.number().int().min(1).max(10).optional(),
  descriptors: descriptorFiltersSchema.optional(),
  genres: genreFiltersSchema.optional(),
});

export const scoreBreakdownSchema = z.object({
  total: z.number(),
  components: z.object({
    mood: z.number(),
    subgenre: z.number(),
    energy: z.number(),
    bpm: z.number(),
    harmonic: z.number(),
    rating: z.number(),
    preferredArtist: z.number(),
    exploration: z.number(),
    repeatedArtist: z.number(),
    recentlyUsed: z.number(),
    missingMetadata: z.number(),
    structure: z.number(),
    joinLevel: z.number(),
    joinStructure: z.number(),
    joinAligned: z.number(),
    joinHarmonic: z.number(),
    joinMood: z.number(),
    genrePrior: z.number(),
    feedback: z.number(),
  }),
  reasons: z.array(z.string()),
});

export const findCompatibleTracksDataSchema = z.object({
  sourceTrackId: z.string(),
  candidates: z.array(
    z.object({
      track: z.object({
        id: z.string(),
        artist: z.string().nullable(),
        title: z.string(),
        bpm: z.number().nullable(),
        musicalKey: z.string().nullable(),
        camelotKey: z.string().nullable(),
        energy: z.number().nullable(),
        rating: z.number().nullable(),
      }),
      score: scoreBreakdownSchema,
    }),
  ),
});

export const transitionPlanSchema = z.object({
  id: z.string(),
  type: transitionTypeSchema,
  durationMs: z.number().int().positive(),
  outgoingCuePointId: z.string().nullable(),
  incomingCuePointId: z.string().nullable(),
  parameters: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
});

/** One required-transition declaration. Shared by stored plans and the
 * create-input brief so the two shapes cannot drift. */
export const requiredTransitionSchema = z
  .array(
    z.object({
      outgoingTrackId: trackIdSchema,
      incomingTrackId: trackIdSchema,
      recipeId: z
        .string()
        .uuid()
        .optional()
        .describe("Pin a specific approved recipe when several exist"),
      strength: z.enum(["required", "preferred"]),
      reuse: z.enum(["pair", "recipe"]),
      allowQualityException: z
        .boolean()
        .optional()
        .describe("Only way a required pair may be risky or an unaligned crossfade"),
    }),
  )
  .max(40)
  .optional()
  .describe("Reserve incoming tracks and force A->B (and A->B->C) when the outgoing is chosen.");
export const setPlanEntrySchema = z.object({
  id: z.string(),
  trackId: z.string(),
  order: z.number().int().nonnegative(),
  sourceStartMs: z.number().int().nonnegative(),
  sourceEndMs: z.number().int().positive(),
  // Timeline positions are derived from BPM/rate math and are inherently
  // fractional (4*60000/bpm is irrational for almost every tempo).
  timelineStartMs: z.number().nonnegative(),
  playbackRate: z.number(),
  gainDb: z.number(),
  transitionToNext: transitionPlanSchema.nullable(),
});

export const planningConstraintsSchema = z
  .object({
    requiredTransitions: requiredTransitionSchema,
    artistRepeatSpacing: z.number().int().min(0).max(10).optional(),
    startTrackId: trackIdSchema.optional(),
    endTrackId: trackIdSchema.optional(),
    requiredTrackIds: z.array(trackIdSchema).optional(),
    excludedTrackIds: z.array(trackIdSchema).optional(),
    excludedArtists: z.array(z.string()).optional(),
  })
  .optional();
export const setPlanV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  targetDurationMs: z.number().int().positive(),
  targetBpm: z.number().nullable(),
  requestedArc: z.array(energyArcPointSchema),
  entries: z.array(setPlanEntrySchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  rateRegionsVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  handoffPolicy: z.literal("dj-continuity-v1").optional(),
  qualityPolicy: z.enum(["strict", "off"]).optional(),
  planningConstraints: z
    .object({
      requiredTransitions: requiredTransitionSchema,

      artistRepeatSpacing: z.number().int().min(0).max(10).optional(),
      startTrackId: trackIdSchema.optional(),
      endTrackId: trackIdSchema.optional(),
      requiredTrackIds: z.array(trackIdSchema).optional(),
      excludedTrackIds: z.array(trackIdSchema).optional(),
      excludedArtists: z.array(z.string()).optional(),
    })
    .optional(),
});

export const createSetPlanInputSchema = z.object({
  name: z.string().min(1).max(200),
  targetDurationMs: z
    .number()
    .int()
    .min(60_000)
    .max(8 * 60 * 60 * 1000)
    .optional()
    .describe(
      "Requested mix length in milliseconds. Default 3600000 (one hour) when neither this nor targetDurationMinutes is set. Any length from 1 minute to 8 hours.",
    ),
  targetDurationMinutes: z
    .number()
    .int()
    .min(1)
    .max(8 * 60)
    .optional()
    .describe(
      "Requested mix length in minutes. Wins over targetDurationMs when both are set. Default 60 when neither duration field is set.",
    ),
  targetBpm: z
    .number()
    .positive()
    .max(400)
    .nullable()
    .optional()
    .describe(
      "Optional mix-wide tempo lock. Omit so each overlap beatmatches at the pair tempo (outgoing-native when the incoming grid fits). Not a mood default — Peak, Liquid, and other briefs omit this.",
    ),
  bpmMin: z.number().positive().max(400).optional(),
  bpmMax: z.number().positive().max(400).optional(),
  requestedArc: z
    .array(energyArcPointSchema)
    .max(12)
    .optional()
    .describe("Energy curve control points. Default 3 → 9 at 0.75 → 6."),
  requiredTrackIds: z.array(trackIdSchema).max(40).optional(),
  excludedTrackIds: z.array(trackIdSchema).max(200).optional(),
  excludedArtists: z.array(z.string().min(1).max(200)).max(50).optional(),
  preferredMoods: stringListSchema.optional(),
  preferredSubgenres: stringListSchema.optional(),
  preferredTags: stringListSchema.optional(),
  preferredArtists: z.array(z.string().min(1).max(200)).max(20).optional(),
  minRating: z.number().int().min(1).max(5).optional(),
  artistRepeatSpacing: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe("Minimum other tracks between the same artist. Default 1 (no back-to-back)."),
  harmonicImportance: z.number().min(0).max(1).optional(),
  explorationWeight: z.number().min(0).max(1).optional(),
  variety: z
    .object({
      referencePlanIds: z.array(z.string().uuid()).max(20),
      strength: z.number().min(0).max(1).optional(),
      history: z.enum(["auto", "off"]).optional(),
    })
    .optional()
    .describe(
      "Prefer fresh recordings and directed pairs relative to these explicit prior mixes. Soft cost; never bypasses quality or required tracks/pairs. Strength defaults to 0.7. history: 'auto' (default) also diversifies against recent qualifying plans when no ids are given; 'off' disables that automatic history. Search drafts are not automatically listening history.",
    ),
  startTrackId: trackIdSchema.optional(),
  endTrackId: trackIdSchema.optional(),
  seed: z.number().int().optional().describe("Reproducibility seed. Default 1."),
  descriptors: descriptorFiltersSchema
    .optional()
    .describe("Hard 0–1 descriptor ranges on the planner pool"),
  genres: genreFiltersSchema.optional().describe("Normalized include/exclude genre labels"),
  dropAnchored: z
    .boolean()
    .optional()
    .describe("Anchor mix-in so the incoming drop lands at overlap end. Default true."),
  qualityPolicy: z
    .enum(["strict", "off"])
    .optional()
    .describe(
      "strict (default for new plans) forbids unexplained risky/unknown/crossfade joins. Pass off only for fixtures or an explicit draft. MCP must not set off unless the user asks for a draft.",
    ),
  requiredTransitions: requiredTransitionSchema,
});

const setPlanIdInputSchema = z.object({ setPlanId: trackIdSchema });

export const getSetPlanInputSchema = setPlanIdInputSchema;

export const validateSetPlanInputSchema = setPlanIdInputSchema;

export const listSetPlansInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(500).optional(),
});

export const deleteSetPlanInputSchema = z.object({
  setPlanId: trackIdSchema,
  confirm: z
    .literal(true)
    .describe("Must be true. Refuses otherwise so the model cannot delete accidentally."),
});

export const updateSetPlanInputSchema = z
  .object({
    setPlanId: trackIdSchema,
    name: z.string().min(1).max(200).optional(),
    replaceTrack: z
      .object({
        entryId: z.string().uuid(),
        trackId: trackIdSchema,
      })
      .optional(),
    setTrim: z
      .object({
        entryId: z.string().uuid(),
        sourceStartMs: z.number().int().nonnegative(),
        sourceEndMs: z.number().int().positive(),
      })
      .optional(),
    setTransition: z
      .object({
        entryId: z.string().uuid(),
        type: transitionTypeSchema,
        durationMs: z.number().int().min(1000).max(120_000),
        outgoingCuePointId: z.string().uuid().nullable().optional(),
        incomingCuePointId: z.string().uuid().nullable().optional(),
        parameters: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
      })
      .optional(),
    setPlaybackRate: z
      .object({
        entryId: z.string().uuid(),
        playbackRate: z.number().positive().max(2),
      })
      .optional(),
    applyTransition: z
      .object({
        entryId: z.string().uuid(),
        type: transitionTypeSchema,
        durationMs: z.number().int().min(1000).max(120_000),
        outgoingCuePointId: z.string().uuid().nullable().optional(),
        incomingCuePointId: z.string().uuid().nullable().optional(),
        outgoingPlaybackRate: z.number().positive().max(2),
        incomingPlaybackRate: z.number().positive().max(2),
        outgoingSourceStartMs: z.number().int().nonnegative(),
        outgoingSourceEndMs: z.number().int().positive(),
        incomingSourceStartMs: z.number().int().nonnegative(),
        incomingSourceEndMs: z.number().int().positive(),
        parameters: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
      })
      .optional(),
    moveEntry: z
      .object({
        entryId: z.string().uuid(),
        toOrder: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.replaceTrack !== undefined ||
      value.setTrim !== undefined ||
      value.setTransition !== undefined ||
      value.setPlaybackRate !== undefined ||
      value.applyTransition !== undefined ||
      value.moveEntry !== undefined,
    { message: "Provide at least one edit" },
  );

export const joinKeyEvidenceSchema = z.object({
  musicalKey: z.string().nullable(),
  camelotKey: z.string().nullable(),
  source: z.string().nullable(),
  confidence: z.number(),
  analyzerName: z.string().nullable(),
});

export const joinQualityReportSchema = z.object({
  order: z.number().int(),
  outgoingTrackId: z.string(),
  incomingTrackId: z.string(),
  outgoingTitle: z.string(),
  incomingTitle: z.string(),
  outgoingKey: joinKeyEvidenceSchema,
  incomingKey: joinKeyEvidenceSchema,
  harmonicRelation: z.enum(["same", "relative", "adjacent_same_mode", "other", "unknown"]),
  harmonicClass: z.enum(["compatible", "risky", "unknown"]),
  outgoingSourceStartMs: z.number().int(),
  outgoingSourceEndMs: z.number().int(),
  incomingSourceStartMs: z.number().int(),
  incomingSourceEndMs: z.number().int(),
  barCount: z.number().int().nullable(),
  overlapMs: z.number().int(),
  continuity: z
    .object({
      evidence: z.string(),
      energyFloor: z.number().nullable(),
      valleyBars: z.number().nullable(),
      coexistenceBars: z.number().nullable(),
    })
    .optional(),
  phraseShape: z.string().nullable(),
  sequentialHandoff: z.string().nullable(),
  intent: z.string().nullable(),
  type: transitionTypeSchema,
  fallbackReason: z.string().nullable(),
  nativeOutgoingBpm: z.number().nullable(),
  nativeIncomingBpm: z.number().nullable(),
  joinTargetBpm: z.number().nullable(),
  planTargetBpm: z.number().nullable(),
  outgoingRate: z.number(),
  incomingRate: z.number(),
  rateRegionsVersion: z.number().nullable(),
  gridOkOutgoing: z.boolean(),
  gridOkIncoming: z.boolean(),
  gridEngineOutgoing: z.string().nullable(),
  gridEngineIncoming: z.string().nullable(),
  recipeStatus: z.enum(["applied", "stale", "none", "protected-exception", "adapted"]),
  constraintSatisfaction: z.enum([
    "satisfied",
    "preferred-dropped",
    "unsatisfied",
    "adapted",
    "exception",
    "none",
  ]),
  unexplainedQualityIssue: z.boolean(),
});

const artistGapSchema = z.object({
  artist: z.string(),
  leftOrder: z.number().int(),
  rightOrder: z.number().int(),
  gap: z.number().int(),
});
export const planQualityReportSchema = z.object({
  joins: z.array(joinQualityReportSchema),
  typeCounts: z.object({
    crossfade: z.number().int(),
    phrase_mix: z.number().int(),
    bass_swap: z.number().int(),
  }),
  harmonicCounts: z.object({
    compatible: z.number().int(),
    risky: z.number().int(),
    unknown: z.number().int(),
  }),
  durationMs: z.number().int(),
  durationDeltaMs: z.number().int(),
  targetDurationMs: z.number().int(),
  artistRepeatSpacingRequested: z.number().int(),
  artistGaps: z.array(artistGapSchema),
  artistSpacingViolations: z.array(artistGapSchema),
  entryBodyWarnings: z.array(
    z.object({
      order: z.number().int(),
      title: z.string().nullable(),
      bodyMs: z.number().int(),
      joinRegionsMs: z.number().int(),
    }),
  ),
  partial: z.boolean(),
  partialReasons: z.array(z.string()),
  unsatisfiedRequiredTransitions: z.array(z.string()).optional(),
  structurallyValid: z.boolean(),
  qualityChecksPassed: z.boolean(),
  readyForAudition: z.boolean(),
  userAccepted: z.boolean(),
  qualityPolicy: z.enum(["strict", "off"]).nullable(),
});

export const validateSetPlanDataSchema = z.object({
  valid: z.boolean(),
  errors: z.array(validationIssueSchema),
  warnings: z.array(validationIssueSchema),
  diagnostics: z.object({
    durationMs: z.number().int(),
    durationDeltaMs: z.number().int(),
    energyByEntry: z.array(
      z.object({
        entryId: z.string(),
        trackId: z.string(),
        atFraction: z.number(),
        actualEnergy: z.number().nullable(),
        targetEnergy: z.number(),
        deviation: z.number().nullable(),
      }),
    ),
  }),
  renderReadiness: renderReadinessSchema.optional(),
  quality: planQualityReportSchema.optional(),
});

export const planExplanationSchema = z.object({
  openerSearch: z
    .array(z.object({ openerTrackId: z.string().nullable(), durationMs: z.number() }))
    .optional(),
  variety: z
    .object({
      referencePlanIds: z.array(z.string()),
      strength: z.number(),
      historyMode: z.enum(["auto", "explicit", "off"]).optional(),
      recentArtistUses: z.record(z.string(), z.number()).optional(),
      policyVersion: z.number().int().optional(),
      trackIds: z.array(z.string()),
      pairs: z.array(z.object({ outgoingTrackId: z.string(), incomingTrackId: z.string() })),
      repeatedTracks: z.number().int(),
      repeatedPairs: z.number().int(),
    })
    .optional(),
  seed: z.number(),
  selected: z.array(
    z.object({
      trackId: z.string(),
      title: z.string(),
      artist: z.string().nullable(),
      order: z.number().int(),
      score: scoreBreakdownSchema,
      lookahead: z.number().optional(),
      requiredProgress: z.number().optional(),
      buckets: z
        .object({
          moodFit: z.number(),
          joinQuality: z.number(),
          keyCoverage: z.number(),
          timeFit: z.number(),
          lookahead: z.number(),
          feedback: z.number(),
        })
        .optional(),
    }),
  ),
  rejected: z.array(
    z.object({
      trackId: z.string(),
      title: z.string(),
      reason: z.string(),
    }),
  ),
  harmonicCoverage: z
    .object({
      knownJoins: z.number().int(),
      totalJoins: z.number().int(),
    })
    .optional(),
  originalDescriptors: z.unknown().optional(),
  resolvedDescriptors: z.unknown().optional(),
  relaxationSteps: z.number().int().optional(),
  chainRetry: z
    .object({
      durationMs: z.number(),
      partialReasons: z.array(z.string()),
      missingRequiredTransitions: z.array(z.string()),
      trackIds: z.array(z.string()),
      repairSearch: z.unknown().optional(),
      priorRepairSearch: z.unknown().optional(),
    })
    .optional(),
  repairSearch: z
    .object({
      rejectionCounts: z.record(z.string(), z.number().int()),
      evaluations: z.number().int(),
      invalid: z.number().int(),
      limit: z.number().int(),
      status: z.string(),
      missingRequired: z.number().int(),
      durationDistanceMs: z.number().nullable(),
      musicalScore: z.number().nullable().optional(),
    })
    .optional(),
});

export const createSetPlanDataSchema = z.object({
  plan: setPlanV1Schema,
  explanation: planExplanationSchema,
  validation: validateSetPlanDataSchema,
  partial: z.boolean(),
  quality: planQualityReportSchema,
});

export const listSetPlansDataSchema = z.object({
  plans: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      targetDurationMs: z.number().int(),
      entryCount: z.number().int(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const deleteSetPlanDataSchema = z.object({
  deleted: z.boolean(),
  setPlanId: z.string(),
});

export const planningReadinessDataSchema = z.object({
  tracks: z.array(
    z.object({
      trackId: z.string(),
      title: z.string(),
      ready: z.boolean(),
      missing: z.array(z.string()),
      cuePointTypes: z.array(z.string()),
      bpmSource: z.enum(["tag", "manual", "analyzed", "published", "hint"]).nullable().optional(),
    }),
  ),
  readyCount: z.number().int(),
  totalCount: z.number().int(),
});

export const listApprovedRecipesInputSchema = z.object({
  outgoingTrackId: trackIdSchema.optional(),
  incomingTrackId: trackIdSchema.optional(),
});

export const listApprovedRecipesDataSchema = z.object({
  recipes: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      outgoingTrackId: z.string(),
      incomingTrackId: z.string(),
      outgoingTitle: z.string().nullable(),
      incomingTitle: z.string().nullable(),
      note: z.string().nullable(),
      createdAt: z.string(),
      type: z.string(),
      barCount: z.number(),
      phraseShape: z.string(),
    }),
  ),
});
