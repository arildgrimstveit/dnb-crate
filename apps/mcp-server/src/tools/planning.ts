import type { CatalogService } from "@dnb-crate/catalog";
import {
  createSetPlanDataSchema,
  createSetPlanInputSchema,
  findCompatibleTracksDataSchema,
  findCompatibleTracksInputSchema,
  getPlanningReadinessInputSchema,
  getTransitionPreferencesDataSchema,
  getTransitionPreferencesInputSchema,
  inspectTransitionDataSchema,
  inspectTransitionInputSchema,
  listTransitionFeedbackDataSchema,
  listTransitionFeedbackInputSchema,
  planTransitionDataSchema,
  planTransitionInputSchema,
  planningReadinessDataSchema,
  rateTransitionDataSchema,
  rateTransitionInputSchema,
  selectTrackEvidenceDataSchema,
  selectTrackEvidenceInputSchema,
  toolResultSchema,
  validateTransitionDataSchema,
  validateTransitionInputSchema,
} from "@dnb-crate/domain";
import { z } from "zod/v4";
import { trackIdSchema } from "@dnb-crate/domain";
import type { McpServer } from "@modelcontextprotocol/server";
import { toolFailure, toolSuccess } from "../map-result.ts";
export function registerPlanningTools(server: McpServer, service: CatalogService): void {
  server.registerTool(
    "plan_transition",
    {
      title: "Plan transition",
      description:
        "Rank feasible phrase-aligned transition proposals for two track UUIDs (phrase_mix, bass_swap, crossfade). Returns cue times, bar counts, playback rates, and blockers. Does not modify the set plan; use update_set_plan.applyTransition to accept one.",
      inputSchema: planTransitionInputSchema,
      outputSchema: toolResultSchema(planTransitionDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input) => {
      try {
        return toolSuccess(service.planTransition(input));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "inspect_transition",
    {
      title: "Inspect transition",
      description:
        "One structured evidence view for a saved join: the stored treatment and its placed source windows, alignment provenance (offset/period/mode/onset-lock), the groove-gate numbers that selected it (gap, per-side means, measured bars, window positions, abstentions), what the planner would choose today, and per-template alternatives with blockers. Read-only; use to diagnose a bad join without reconstructing source positions by hand.",
      inputSchema: inspectTransitionInputSchema,
      outputSchema: toolResultSchema(inspectTransitionDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input) => {
      try {
        return toolSuccess(service.inspectTransition(input));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "compare_transition_variants",
    {
      title: "Compare transition variants",
      description:
        "Render the stored treatment plus every other feasible aligned template for one saved join on the same frozen windows with comparable loudness. Returns per-variant feasibility, blockers, and preview job ids. Queue the previews, wait for them, present the listen files to the owner, then record the owner's verdict with rate_transition per variant.",
      inputSchema: z.object({
        setPlanId: trackIdSchema,
        transitionId: trackIdSchema,
        windowMs: z.number().int().min(30_000).max(60_000).optional(),
        allowLowConfidence: z.boolean().optional(),
      }),
      outputSchema: toolResultSchema(
        z.object({
          setPlanId: z.string(),
          transitionId: z.string(),
          order: z.number().int(),
          outgoing: z.object({ trackId: z.string(), title: z.string() }),
          incoming: z.object({ trackId: z.string(), title: z.string() }),
          storedTemplate: z.string(),
          variants: z.array(
            z.object({
              template: z.string(),
              isStored: z.boolean(),
              feasible: z.boolean(),
              blockers: z.array(z.string()),
              jobId: z.string().nullable(),
              outputRootRelativePath: z.string().nullable().optional(),
            }),
          ),
        }),
      ),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        const result = await service.compareTransitionVariants(input);
        return toolSuccess(result);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "repair_set_plan",
    {
      title: "Repair set plan",
      description:
        "Surgically replace a join's incoming track while preserving every other adjacency. Protected transitions (by id) keep their stored treatments exactly. Returns the updated plan, a diff of what changed, and validation. Prerequisites for safe repair landed October 2026 (F4 frozen identity, F7 pair-aware invalidation).",
      inputSchema: z.object({
        setPlanId: trackIdSchema,
        entryId: trackIdSchema,
        newIncomingTrackId: trackIdSchema,
        protectedTransitionIds: z.array(trackIdSchema).optional(),
      }),
      outputSchema: toolResultSchema(
        z.object({
          plan: z.object({
            id: z.string(),
            entries: z.array(
              z.object({
                trackId: z.string(),
                order: z.number(),
                transitionToNext: z.object({ type: z.string() }).nullable(),
              }),
            ),
          }),
          diff: z.object({
            changedJoin: z.object({
              order: z.number(),
              fromTitle: z.string(),
              toTitle: z.string(),
            }),
            protectedJoins: z.array(z.number()),
            invalidated: z.array(z.string()),
          }),
          validation: z.object({ valid: z.boolean() }),
        }),
      ),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    (input: Parameters<CatalogService["repairSetPlan"]>[0]) => {
      try {
        const result = service.repairSetPlan(input);
        return toolSuccess(result);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "validate_transition",
    {
      title: "Validate transition",
      description:
        "Check a concrete transition (timing, grids, playback-rate bounds, cue presence). Low-confidence grids fail unless allowLowConfidence is true.",
      inputSchema: validateTransitionInputSchema,
      outputSchema: toolResultSchema(validateTransitionDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input) => {
      try {
        return toolSuccess(service.validateTransition(input));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "get_planning_readiness",
    {
      title: "Get planning readiness",
      description:
        "Report which planning fields (BPM, key, energy, file presence) are missing. Pass a trackId for one track, or omit it for the whole catalog. Use before create_set_plan when metadata looks thin.",
      inputSchema: getPlanningReadinessInputSchema,
      outputSchema: toolResultSchema(planningReadinessDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ trackId }) => {
      try {
        return toolSuccess(service.getPlanningReadiness(trackId));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "find_compatible_tracks",
    {
      title: "Find compatible tracks",
      description:
        "Rank catalog tracks against a source track using deterministic BPM, Camelot, energy, and tag overlap scores. Use when building or revising a set and you need the next candidate. Does not create a plan.",
      inputSchema: findCompatibleTracksInputSchema,
      outputSchema: toolResultSchema(findCompatibleTracksDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input) => {
      try {
        return toolSuccess(service.findCompatibleTracks(input));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "create_set_plan",
    {
      title: "Create set plan",
      description:
        "Generate and persist a deterministic ordered set plan from structured constraints (requested duration, energy arc, start/end tracks, moods, seed, requiredTransitions). Pass targetDurationMinutes or targetDurationMs for the length the user asked for; default 60 minutes only when they omit a length. Translate natural language into these fields first. New plans use strict quality: unexplained risky/unknown/crossfade joins are refused unless a required exception or applicable accepted recipe covers the pair. Pass qualityPolicy off only when the user asks for a draft. Returns the plan, score explanations, validation, and quality report. Does not render audio. May return a partial plan if the library is too small.",
      inputSchema: createSetPlanInputSchema,
      outputSchema: toolResultSchema(createSetPlanDataSchema),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    (input) => {
      try {
        const created = service.createSetPlan(input);
        const warnings = [
          ...created.validation.errors.map((issue) => issue.message),
          ...created.validation.warnings.map((issue) => issue.message),
        ];
        if (created.partial) {
          warnings.unshift(
            "Partial plan: catalog could not fill the target duration or required tracks.",
          );
        }
        return toolSuccess(created, warnings);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "rate_transition",
    {
      title: "Rate transition",
      description:
        "Append a listen rating for an exact recipe fingerprint or track pair. Never overwrites an older rating.",
      inputSchema: rateTransitionInputSchema,
      outputSchema: toolResultSchema(rateTransitionDataSchema),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    (input) => {
      try {
        const rated = service.rateTransition(input);
        return toolSuccess({
          id: rated.id,
          recipeFingerprint: rated.recipeFingerprint,
          createdAt: rated.createdAt,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "list_transition_feedback",
    {
      title: "List transition feedback",
      description: "List stored transition ratings. Historical notes keep their original wording.",
      inputSchema: listTransitionFeedbackInputSchema,
      outputSchema: toolResultSchema(listTransitionFeedbackDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input) => {
      try {
        return toolSuccess(service.listTransitionFeedback(input));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "get_transition_preferences",
    {
      title: "Get transition preferences",
      description:
        "Summarize like/dislike counts and the deterministic planner bonus for a recipe or pair.",
      inputSchema: getTransitionPreferencesInputSchema,
      outputSchema: toolResultSchema(getTransitionPreferencesDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input) => {
      try {
        return toolSuccess(service.getTransitionPreferences(input));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "select_track_evidence",
    {
      title: "Select track evidence",
      description:
        "Choose the rhythm, structure, or key engine for one track. Null keeps the DSP default. Does not re-analyze the crate.",
      inputSchema: selectTrackEvidenceInputSchema,
      outputSchema: toolResultSchema(selectTrackEvidenceDataSchema),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    (input) => {
      try {
        const selected = service.selectTrackEvidence(input);
        return toolSuccess({
          trackId: selected.trackId,
          rhythmEngine: selected.rhythmEngine,
          structureEngine: selected.structureEngine,
          keyEngine: selected.keyEngine,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
