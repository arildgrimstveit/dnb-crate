import * as z from "zod/v4";

import { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX } from "./constants.ts";

export const trackIdSchema = z.string().uuid();

const stringListSchema = z.array(z.string().trim().min(1).max(64)).max(20);

export const searchTracksInputSchema = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe("Free-text search across artist, title, album, tags, and notes"),
  artist: z.string().max(200).optional().describe("Exact artist match, case-insensitive"),
  bpmMin: z.number().positive().max(400).optional(),
  bpmMax: z.number().positive().max(400).optional(),
  musicalKey: z
    .string()
    .max(16)
    .optional()
    .describe("Canonical key such as F#m, or a Camelot code such as 11A"),
  camelotKey: z.string().max(8).optional(),
  energyMin: z.number().int().min(1).max(10).optional(),
  energyMax: z.number().int().min(1).max(10).optional(),
  subBassMin: z.number().min(0).max(1).optional().describe("Minimum analyzed sub-bass ratio"),
  subBassMax: z.number().min(0).max(1).optional(),
  brightnessMin: z.number().min(0).max(1).optional().describe("Minimum spectral brightness 0–1"),
  brightnessMax: z.number().min(0).max(1).optional(),
  minRating: z.number().int().min(1).max(5).optional(),
  subgenres: stringListSchema.optional(),
  subgenresMatch: z.enum(["any", "all"]).optional().describe("Default any"),
  moods: stringListSchema.optional(),
  moodsMatch: z.enum(["any", "all"]).optional(),
  tags: stringListSchema.optional(),
  tagsMatch: z.enum(["any", "all"]).optional(),
  analysisStatus: z.enum(["not_analyzed", "pending", "complete", "failed"]).optional(),
  sort: z
    .enum([
      "title",
      "artist",
      "album",
      "bpm",
      "energy",
      "rating",
      "durationMs",
      "createdAt",
      "updatedAt",
    ])
    .optional()
    .describe("Default title"),
  direction: z.enum(["asc", "desc"]).optional().describe("Default asc"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_LIMIT_MAX)
    .optional()
    .describe(`Default ${SEARCH_LIMIT_DEFAULT}, max ${SEARCH_LIMIT_MAX}`),
  cursor: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Opaque pagination cursor from a previous response"),
});

export type SearchTracksInput = z.infer<typeof searchTracksInputSchema>;

export const publicTrackSchema = z.object({
  id: z.string(),
  fileFingerprint: z.string(),
  artist: z.string().nullable(),
  title: z.string(),
  album: z.string().nullable(),
  durationMs: z.number().int(),
  sampleRateHz: z.number().int().nullable(),
  channels: z.number().int().nullable(),
  bpm: z.number().nullable(),
  bpmSource: z.enum(["tag", "manual", "analyzed", "published"]).nullable(),
  musicalKey: z.string().nullable(),
  camelotKey: z.string().nullable(),
  keySource: z.enum(["tag", "manual", "analyzed", "published"]).nullable(),
  energy: z.number().int().nullable(),
  rating: z.number().int().nullable(),
  subgenres: z.array(z.string()),
  moods: z.array(z.string()),
  tags: z.array(z.string()),
  notes: z.string().nullable(),
  analysisStatus: z.enum(["not_analyzed", "pending", "complete", "failed"]),
  fileMissing: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  label: z.string().nullable().optional(),
  releaseDate: z.string().nullable().optional(),
  year: z.number().int().nullable().optional(),
  isrc: z.string().nullable().optional(),
  recordingMbid: z.string().nullable().optional(),
  artistCanonical: z.string().nullable().optional(),
  recordingKey: z.string().nullable().optional(),
  genres: z.array(z.string()).optional(),
  fieldSources: z.record(z.string(), z.enum(["tag", "published", "manual"])).optional(),
});

export const searchTracksDataSchema = z.object({
  tracks: z.array(publicTrackSchema),
  nextCursor: z.string().nullable(),
  limit: z.number().int(),
  sort: z.string(),
  direction: z.string(),
});

export const getTrackInputSchema = z.object({
  trackId: trackIdSchema,
});

export const updateTrackMetadataInputSchema = z
  .object({
    trackId: trackIdSchema,
    energy: z.number().int().min(1).max(10).nullable().optional(),
    rating: z.number().int().min(1).max(5).nullable().optional(),
    moods: stringListSchema.optional(),
    subgenres: stringListSchema.optional(),
    tags: stringListSchema.optional(),
    notes: z.string().max(4000).nullable().optional(),
    bpm: z
      .number()
      .positive()
      .max(400)
      .nullable()
      .optional()
      .describe("BPM override; defaults bpmSource to manual unless bpmSource is set"),
    bpmSource: z
      .enum(["manual", "published"])
      .optional()
      .describe("Provenance for bpm; published = store/label lookup"),
    musicalKey: z
      .string()
      .max(16)
      .nullable()
      .optional()
      .describe("Key or Camelot code; defaults keySource to manual unless keySource is set"),
    keySource: z.enum(["manual", "published"]).optional(),
    metadataSourceNote: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .describe("Optional note about where published/manual values came from"),
    album: z.string().max(200).nullable().optional(),
    label: z.string().max(200).nullable().optional(),
    releaseDate: z.string().max(32).nullable().optional(),
    isrc: z.string().max(16).nullable().optional(),
    genres: stringListSchema.optional(),
  })
  .refine(
    (value) =>
      value.energy !== undefined ||
      value.rating !== undefined ||
      value.moods !== undefined ||
      value.subgenres !== undefined ||
      value.tags !== undefined ||
      value.notes !== undefined ||
      value.bpm !== undefined ||
      value.musicalKey !== undefined ||
      value.metadataSourceNote !== undefined ||
      value.album !== undefined ||
      value.label !== undefined ||
      value.releaseDate !== undefined ||
      value.isrc !== undefined ||
      value.genres !== undefined,
    { message: "Provide at least one metadata field to update" },
  );

export type UpdateTrackMetadataInput = z.infer<typeof updateTrackMetadataInputSchema>;

export const scanLibraryInputSchema = z.object({
  dryRun: z
    .boolean()
    .optional()
    .describe("Walk and parse without writing to the catalog. Default false."),
});

export const scanLibraryDataSchema = z.object({
  dryRun: z.boolean(),
  rootsScanned: z.number().int(),
  filesSeen: z.number().int(),
  upserted: z.number().int(),
  moved: z.number().int(),
  skippedUnsupported: z.number().int(),
  skippedMalformed: z.number().int(),
  markedMissing: z.number().int(),
});

export const emptyInputSchema = z.object({});

export const analysisCoverageSchema = z.object({
  analyzed: z.number().int(),
  notAnalyzed: z.number().int(),
  byEngineVersion: z.record(z.string(), z.number().int()),
  accepted: z.number().int(),
  rejected: z.number().int(),
  reference: z.number().int(),
  bpmHintOnly: z.number().int(),
});

export const metadataCoverageSchema = z.object({
  bpmBySource: z.record(z.string(), z.number().int()),
  keyBySource: z.record(z.string(), z.number().int()),
  energy: z.number().int(),
  moods: z.number().int(),
  genres: z.number().int(),
  isrc: z.number().int(),
  label: z.number().int(),
  releaseDate: z.number().int(),
  recordingMbid: z.number().int(),
  duplicateGroups: z.number().int(),
});

export const libraryStatsDataSchema = z.object({
  trackCount: z.number().int(),
  missingFileCount: z.number().int(),
  totalDurationMs: z.number().int(),
  extensionCounts: z.record(z.string(), z.number().int()),
  missingTitleFromTagsCount: z.number().int(),
  missingArtistCount: z.number().int(),
  missingBpmCount: z.number().int(),
  missingKeyCount: z.number().int(),
  missingEnergyCount: z.number().int(),
  missingRatingCount: z.number().int(),
  analysisCoverage: analysisCoverageSchema,
  metadataCoverage: metadataCoverageSchema,
});

export const serverStatusDataSchema = z.object({
  name: z.string(),
  version: z.string(),
  databaseReady: z.boolean(),
  libraryRootCount: z.number().int(),
  libraryRootsReady: z.number().int(),
  outputRootConfigured: z.boolean(),
  ffmpegAvailable: z.boolean(),
  ffprobeAvailable: z.boolean(),
  ffmpegVersion: z.string().nullable(),
  ffprobeVersion: z.string().nullable(),
  supportedExtensions: z.array(z.string()),
  pythonAnalyzerAvailable: z.boolean(),
  pythonAnalyzerEngines: z.array(z.string()),
  enrichment: z
    .object({
      enabled: z.boolean(),
      musicbrainz: z.boolean(),
      deezer: z.boolean(),
      acoustidConfigured: z.boolean(),
    })
    .optional(),
});

export const toolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export function toolResultSchema<T extends z.ZodType>(dataSchema: T) {
  return z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      data: dataSchema,
      warnings: z.array(z.string()),
    }),
    z.object({
      ok: z.literal(false),
      error: toolErrorSchema,
    }),
  ]);
}

export type LibraryStats = z.infer<typeof libraryStatsDataSchema>;
export type ServerStatus = z.infer<typeof serverStatusDataSchema>;
export type ScanLibraryResult = z.infer<typeof scanLibraryDataSchema>;
export type SearchTracksResult = z.infer<typeof searchTracksDataSchema>;

const energyArcPointSchema = z.object({
  atFraction: z.number().min(0).max(1),
  targetEnergy: z.number().min(1).max(10),
});

export const cuePointTypeSchema = z.enum([
  "intro_start",
  "intro_end",
  "drop",
  "breakdown",
  "outro_start",
  "outro_end",
  "custom",
]);

export const cuePointSchema = z.object({
  id: z.string(),
  trackId: z.string(),
  type: cuePointTypeSchema,
  positionMs: z.number().int().nonnegative(),
  beatIndex: z.number().int().nullable(),
  barIndex: z.number().int().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  source: z.enum(["manual", "analyzed", "imported"]),
  label: z.string().nullable(),
});

export const setCuePointsInputSchema = z.object({
  trackId: trackIdSchema,
  cuePoints: z
    .array(
      z.object({
        type: cuePointTypeSchema,
        positionMs: z.number().int().nonnegative(),
        beatIndex: z.number().int().nullable().optional(),
        barIndex: z.number().int().nullable().optional(),
        confidence: z.number().min(0).max(1).nullable().optional(),
        label: z.string().max(200).nullable().optional(),
      }),
    )
    .max(32)
    .describe("Replaces all cue points on the track. Does not invent analysis."),
  beatAnchorMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Optional manual downbeat/beat anchor. Reconstructs the stored analysis grid."),
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
});

const scoreBreakdownSchema = z.object({
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
  type: z.enum(["crossfade", "phrase_mix", "bass_swap", "double_drop"]),
  durationMs: z.number().int().positive(),
  outgoingCuePointId: z.string().nullable(),
  incomingCuePointId: z.string().nullable(),
  parameters: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
});

export const setPlanEntrySchema = z.object({
  id: z.string(),
  trackId: z.string(),
  order: z.number().int().nonnegative(),
  sourceStartMs: z.number().int().nonnegative(),
  sourceEndMs: z.number().int().positive(),
  timelineStartMs: z.number().int().nonnegative(),
  playbackRate: z.number(),
  gainDb: z.number(),
  transitionToNext: transitionPlanSchema.nullable(),
});

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
});

export const createSetPlanInputSchema = z.object({
  name: z.string().min(1).max(200),
  targetDurationMs: z
    .number()
    .int()
    .min(60_000)
    .max(8 * 60 * 60 * 1000)
    .optional()
    .describe("Default 3600000 (one hour)"),
  targetBpm: z.number().positive().max(400).nullable().optional(),
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
  startTrackId: trackIdSchema.optional(),
  endTrackId: trackIdSchema.optional(),
  seed: z.number().int().optional().describe("Reproducibility seed. Default 1."),
});

export const getSetPlanInputSchema = z.object({
  setPlanId: trackIdSchema,
});

export const validateSetPlanInputSchema = z.object({
  setPlanId: trackIdSchema,
});

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
        type: z.enum(["crossfade", "phrase_mix", "bass_swap", "double_drop"]),
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
        type: z.enum(["crossfade", "phrase_mix", "bass_swap"]),
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

export const validationIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  entryId: z.string().optional(),
  trackId: z.string().optional(),
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
  renderReadiness: z
    .object({
      ready: z.boolean(),
      ffmpegAvailable: z.boolean(),
      ffprobeAvailable: z.boolean(),
      ffmpegVersion: z.string().nullable(),
      ffprobeVersion: z.string().nullable(),
      issues: z.array(validationIssueSchema),
    })
    .optional(),
});

export const planExplanationSchema = z.object({
  seed: z.number(),
  selected: z.array(
    z.object({
      trackId: z.string(),
      title: z.string(),
      artist: z.string().nullable(),
      order: z.number().int(),
      score: scoreBreakdownSchema,
    }),
  ),
  rejected: z.array(
    z.object({
      trackId: z.string(),
      title: z.string(),
      reason: z.string(),
    }),
  ),
});

export const createSetPlanDataSchema = z.object({
  plan: setPlanV1Schema,
  explanation: planExplanationSchema,
  validation: validateSetPlanDataSchema,
  partial: z.boolean(),
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

export const setCuePointsDataSchema = z.object({
  trackId: z.string(),
  cuePoints: z.array(cuePointSchema),
});

export const getTrackDataSchema = publicTrackSchema.extend({
  cuePoints: z.array(cuePointSchema),
});

export const buildDnbSetPromptArgsSchema = z.object({
  request: z.string().min(1).max(4000).describe("Natural-language description of the desired set"),
});
