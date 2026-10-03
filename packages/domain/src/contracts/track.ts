import * as z from "zod/v4";
import { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX } from "../constants.ts";
import {
  cuePointTypeSchema,
  descriptorFiltersSchema,
  genreFiltersSchema,
  stringListSchema,
  trackIdSchema,
} from "./common.ts";

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
  descriptors: descriptorFiltersSchema
    .optional()
    .describe("Hard 0–1 descriptor ranges. Tracks without a DSP row fail non-energy filters."),
  genres: genreFiltersSchema.optional(),
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

export const analysisCoverageSchema = z.object({
  analyzed: z.number().int(),
  notAnalyzed: z.number().int(),
  byEngineVersion: z.record(z.string(), z.number().int()),
  accepted: z.number().int(),
  rejected: z.number().int(),
  reference: z.number().int(),
  bpmHintOnly: z.number().int(),
});

export const descriptorPercentileSchema = z
  .object({
    p10: z.number(),
    p50: z.number(),
    p90: z.number(),
  })
  .nullable();

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
  descriptorPercentiles: z.object({
    energy: descriptorPercentileSchema,
    danceability: descriptorPercentileSchema,
    valence: descriptorPercentileSchema,
    acousticness: descriptorPercentileSchema,
    melodicness: descriptorPercentileSchema,
    subBass: descriptorPercentileSchema,
    brightness: descriptorPercentileSchema,
  }),
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
  enrichment: z
    .object({
      enabled: z.boolean(),
      musicbrainz: z.boolean(),
      deezer: z.boolean(),
      acoustidConfigured: z.boolean(),
    })
    .optional(),
});

export type LibraryStats = z.infer<typeof libraryStatsDataSchema>;
export type ServerStatus = z.infer<typeof serverStatusDataSchema>;
export type ScanLibraryResult = z.infer<typeof scanLibraryDataSchema>;
export type SearchTracksResult = z.infer<typeof searchTracksDataSchema>;

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

export const setCuePointsDataSchema = z.object({
  trackId: z.string(),
  cuePoints: z.array(cuePointSchema),
});

export const getTrackDataSchema = publicTrackSchema.extend({
  cuePoints: z.array(cuePointSchema),
});
