import * as z from "zod/v4";

export const recordHourFeedbackSchema = z.object({
  renderJobId: z.string().uuid(),
  outputChecksum: z.string().regex(/^[a-f0-9]{64}$/i),
  accepted: z.boolean(),
  quote: z.string().trim().min(1).max(20000),
});
export const listHourFeedbackSchema = z.object({ renderJobId: z.string().uuid().optional() });

export const hourFeedbackSchema = z.object({
  id: z.string(),
  renderJobId: z.string(),
  outputChecksum: z.string(),
  setPlanId: z.string(),
  planContentHash: z.string(),
  accepted: z.boolean(),
  quote: z.string(),
  createdAt: z.string(),
});
export const recordHourFeedbackDataSchema = hourFeedbackSchema;
export const listHourFeedbackDataSchema = z.object({
  ratings: z.array(hourFeedbackSchema),
});
