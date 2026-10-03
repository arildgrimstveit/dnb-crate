import type { CatalogService } from "@dnb-crate/catalog";
import {
  createSetPlanDataSchema,
  createSetPlanInputSchema,
  findCompatibleTracksDataSchema,
  findCompatibleTracksInputSchema,
  getPlanningReadinessInputSchema,
  getTransitionPreferencesDataSchema,
  getTransitionPreferencesInputSchema,
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
