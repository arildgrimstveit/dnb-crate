import * as z from "zod/v4";
export const recordHourFeedbackSchema = z.object({
  renderJobId: z.uuid(),
  outputChecksum: z.string().regex(/^[a-f0-9]{64}$/i),
  accepted: z.boolean(),
  quote: z.string().trim().min(1).max(20000),
});
export const listHourFeedbackSchema = z.object({ renderJobId: z.uuid().optional() });
