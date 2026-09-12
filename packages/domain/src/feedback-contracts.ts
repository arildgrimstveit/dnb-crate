import * as z from "zod/v4";

import { trackIdSchema } from "./contracts.ts";

export const feedbackRatingValueSchema = z.union([
  z.number().min(0).max(1),
  z.literal("not_assessed"),
]);

export const rateTransitionInputSchema = z
  .object({
    recipeFingerprint: z.string().min(1).optional(),
    outgoingTrackId: trackIdSchema.optional(),
    incomingTrackId: trackIdSchema.optional(),
    setPlanId: z.string().uuid().optional(),
    renderJobId: z.string().uuid().optional(),
    transitionId: z.string().uuid().optional(),
    rendererVersion: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    barCount: z.number().int().positive().nullable().optional(),
    intent: z.string().min(1).nullable().optional(),
    phraseShape: z.string().min(1).nullable().optional(),
    outgoingRate: z.number().nullable().optional(),
    incomingRate: z.number().nullable().optional(),
    mixInMs: z.number().int().nullable().optional(),
    mixOutMs: z.number().int().nullable().optional(),
    recipeVersion: z.number().int().nullable().optional(),
    overall: feedbackRatingValueSchema.optional(),
    timing: feedbackRatingValueSchema.optional(),
    phrasing: feedbackRatingValueSchema.optional(),
    bassClarity: feedbackRatingValueSchema.optional(),
    harmonicFit: feedbackRatingValueSchema.optional(),
    energyContinuity: feedbackRatingValueSchema.optional(),
    vocalClash: feedbackRatingValueSchema.optional(),
    note: z.string().max(4000).nullable().optional(),
  })
  .refine(
    (value) =>
      Boolean(value.renderJobId) ||
      Boolean(value.recipeFingerprint) ||
      Boolean(value.outgoingTrackId && value.incomingTrackId) ||
      Boolean(value.type),
    { message: "Pass renderJobId, a recipe fingerprint, a track pair, or recipe fields" },
  );

export const rateTransitionDataSchema = z.object({
  id: z.string(),
  recipeFingerprint: z.string(),
  createdAt: z.string(),
});

export const listTransitionFeedbackInputSchema = z.object({
  recipeFingerprint: z.string().min(1).optional(),
  outgoingTrackId: trackIdSchema.optional(),
  incomingTrackId: trackIdSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const transitionFeedbackSchema = z.object({
  id: z.string(),
  recipeFingerprint: z.string(),
  outgoingTrackId: z.string().nullable(),
  incomingTrackId: z.string().nullable(),
  setPlanId: z.string().nullable(),
  renderJobId: z.string().nullable(),
  transitionId: z.string().nullable(),
  rendererVersion: z.string().nullable(),
  overall: feedbackRatingValueSchema,
  timing: feedbackRatingValueSchema,
  phrasing: feedbackRatingValueSchema,
  bassClarity: feedbackRatingValueSchema,
  harmonicFit: feedbackRatingValueSchema,
  energyContinuity: feedbackRatingValueSchema,
  vocalClash: feedbackRatingValueSchema,
  note: z.string().nullable(),
  createdAt: z.string(),
});

export const listTransitionFeedbackDataSchema = z.object({
  ratings: z.array(transitionFeedbackSchema),
});

export const getTransitionPreferencesInputSchema = z.object({
  recipeFingerprint: z.string().min(1).optional(),
  outgoingTrackId: trackIdSchema.optional(),
  incomingTrackId: trackIdSchema.optional(),
});

export const transitionPreferenceSchema = z.object({
  recipeFingerprint: z.string().nullable(),
  pairKey: z.string().nullable(),
  likeCount: z.number().int(),
  dislikeCount: z.number().int(),
  noteCount: z.number().int(),
  bonus: z.number(),
});

export const getTransitionPreferencesDataSchema = z.object({
  preferences: z.array(transitionPreferenceSchema),
});

export const selectTrackEvidenceInputSchema = z.object({
  trackId: trackIdSchema,
  rhythmEngine: z.string().min(1).nullable().optional(),
  structureEngine: z.string().min(1).nullable().optional(),
  keyEngine: z.string().min(1).nullable().optional(),
  reason: z.string().max(500).optional(),
});

export const selectTrackEvidenceDataSchema = z.object({
  trackId: z.string(),
  rhythmEngine: z.string().nullable(),
  structureEngine: z.string().nullable(),
  keyEngine: z.string().nullable(),
});
