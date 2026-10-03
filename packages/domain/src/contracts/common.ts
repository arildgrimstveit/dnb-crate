import * as z from "zod/v4";

export const trackIdSchema = z.string().uuid();

export const stringListSchema = z.array(z.string().trim().min(1).max(64)).max(20);

export const descriptorRangeSchema = z.object({
  min: z.number().min(0).max(1).optional(),
  max: z.number().min(0).max(1).optional(),
  minPct: z.number().min(0).max(100).optional(),
  maxPct: z.number().min(0).max(100).optional(),
});

export const descriptorFiltersSchema = z.object({
  energy: descriptorRangeSchema.optional(),
  danceability: descriptorRangeSchema.optional(),
  valence: descriptorRangeSchema.optional(),
  acousticness: descriptorRangeSchema.optional(),
  melodicness: descriptorRangeSchema.optional(),
  subBass: descriptorRangeSchema.optional(),
  brightness: descriptorRangeSchema.optional(),
});

export const genreFiltersSchema = z.object({
  include: stringListSchema.optional(),
  exclude: stringListSchema.optional(),
});

export const emptyInputSchema = z.object({});

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

export const cuePointTypeSchema = z.enum([
  "intro_start",
  "intro_end",
  "drop",
  "breakdown",
  "outro_start",
  "outro_end",
  "custom",
]);

export const validationIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  entryId: z.string().optional(),
  trackId: z.string().optional(),
});
