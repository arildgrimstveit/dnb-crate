import * as z from "zod/v4";
import { createSetPlanInputSchema } from "./contracts.ts";
export const startMixWorkflowInputSchema = z.object({
  brief: createSetPlanInputSchema,
  requestToken: z.string().trim().min(1).max(200),
});
export const mixWorkflowIdInputSchema = z.object({ id: z.string().uuid() });
export const mixIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["warning", "error"]),
  stage: z.string(),
  trackIds: z.array(z.string()).optional(),
  count: z.number().optional(),
  retryable: z.boolean(),
  message: z.string(),
  nextAction: z.string(),
});
export const preflightDataSchema = z.object({
  dependencies: z.record(z.string(), z.string().nullable()),
  ready: z.boolean(),
  issues: z.array(mixIssueSchema),
});
export const mixWorkflowDataSchema = z.object({
  id: z.string().uuid(),
  brief: createSetPlanInputSchema,
  status: z.enum(["queued", "running", "blocked", "succeeded", "failed", "cancelled"]),
  stage: z.enum(["preflight", "scan", "analysis", "plan", "validate", "render", "check"]),
  completedStages: z.array(z.string()),
  analysisJobIds: z.array(z.string().uuid()),
  planId: z.string().uuid().nullable(),
  renderJobId: z.string().uuid().nullable(),
  candidates: z.record(z.string(), z.string()).nullable(),
  settingsIdentity: z.string(),
  effectiveSettings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  dependencies: z.record(z.string(), z.string().nullable()),
  renderJobIds: z.array(z.string().uuid()),
  progress: z.object({ completed: z.number(), total: z.number() }).nullable(),
  issues: z.array(mixIssueSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  result: z
    .object({
      verified: z.boolean(),
      master: z.string().nullable(),
      listen: z.string().nullable(),
      trackCount: z.number(),
      durationMs: z.number(),
    })
    .nullable(),
});
