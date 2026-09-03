import * as z from "zod/v4";

import { trackIdSchema } from "./contracts.ts";

export const enrichmentScopeSchema = z.enum(["ids", "unmatched", "all"]);

export const startMetadataEnrichmentInputSchema = z
  .object({
    scope: enrichmentScopeSchema
      .optional()
      .describe("unmatched (default) skips already matched rows; all re-checks; ids uses trackIds"),
    trackIds: z.array(trackIdSchema).min(1).max(2000).optional(),
    dryRun: z.boolean().optional().describe("Look up and report without writing track fields"),
    limit: z.number().int().min(1).max(2000).optional(),
  })
  .refine((value) => value.scope !== "ids" || (value.trackIds?.length ?? 0) > 0, {
    message: "scope ids requires trackIds",
  });

export const getEnrichmentStatusInputSchema = z.object({
  enrichmentJobId: z.string().uuid().optional(),
});

export const getEnrichmentReportInputSchema = z.object({});

export const enrichmentJobSchema = z.object({
  id: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  progress: z.number(),
  trackIds: z.array(z.string()),
  completedTrackIds: z.array(z.string()),
  failedTrackIds: z.array(z.string()),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retryable: z.boolean(),
  dryRun: z.boolean(),
  progressMessage: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const listEnrichmentJobsDataSchema = z.object({
  jobs: z.array(enrichmentJobSchema),
});

export const enrichmentReportRowSchema = z.object({
  trackId: z.string(),
  title: z.string(),
  method: z.enum(["file-tags", "isrc", "acoustid", "search"]).nullable(),
  score: z.number().nullable(),
  needsReview: z.boolean(),
  bpmWritten: z.boolean(),
  bpmDisagreement: z.boolean(),
});

export const enrichmentReportDataSchema = z.object({
  matchedByMethod: z.record(z.string(), z.number().int()),
  unmatched: z.number().int(),
  needsReview: z.number().int(),
  bpmWritten: z.number().int(),
  bpmDisagreements: z.number().int(),
  duplicateGroups: z.number().int(),
  rows: z.array(enrichmentReportRowSchema),
});

export type EnrichmentJob = z.infer<typeof enrichmentJobSchema>;
export type EnrichmentReport = z.infer<typeof enrichmentReportDataSchema>;
export type EnrichmentScope = z.infer<typeof enrichmentScopeSchema>;
