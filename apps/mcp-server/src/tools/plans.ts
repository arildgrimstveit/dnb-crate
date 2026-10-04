import type { CatalogService } from "@dnb-crate/catalog";
import {
  listHourFeedbackDataSchema,
  listHourFeedbackSchema,
  recordHourFeedbackDataSchema,
  recordHourFeedbackSchema,
  createSetPlanDataSchema,
  deleteSetPlanDataSchema,
  deleteSetPlanInputSchema,
  getSetPlanInputSchema,
  listApprovedRecipesDataSchema,
  listApprovedRecipesInputSchema,
  listSetPlansDataSchema,
  listSetPlansInputSchema,
  setPlanV1Schema,
  toolResultSchema,
  updateSetPlanInputSchema,
  validateSetPlanDataSchema,
  validateSetPlanInputSchema,
} from "@dnb-crate/domain";
import type { McpServer } from "@modelcontextprotocol/server";
import { toolFailure, toolSuccess } from "../map-result.ts";
export function registerPlansTools(server: McpServer, service: CatalogService): void {
  server.registerTool(
    "get_set_plan",
    {
      title: "Get set plan",
      description:
        "Retrieve a saved set plan by UUID. Use after create_set_plan or list_set_plans. Returns SET_PLAN_NOT_FOUND when unknown.",
      inputSchema: getSetPlanInputSchema,
      outputSchema: toolResultSchema(setPlanV1Schema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ setPlanId }) => {
      try {
        return toolSuccess(service.getSetPlan(setPlanId));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "validate_set_plan",
    {
      title: "Validate set plan",
      description:
        "Return errors, warnings, duration delta, energy-arc diagnostics, render-readiness, and the per-join quality report (harmonic class, fallback reasons, recipe status, readyForAudition). Use after create or update. Errors mean the plan is not structurally valid; qualityChecksPassed is independent of structural validity; renderReadiness.ready must be true before start_set_render.",
      inputSchema: validateSetPlanInputSchema,
      outputSchema: toolResultSchema(validateSetPlanDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ setPlanId }) => {
      try {
        return toolSuccess(await service.validateSavedSetPlan(setPlanId));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "update_set_plan",
    {
      title: "Update set plan",
      description:
        "Apply an explicit edit: rename, replace a track, change a trim, change a transition, set playback rate, apply a plan_transition proposal, or reorder an entry. The server rebuilds timeline positions.",
      inputSchema: updateSetPlanInputSchema,
      outputSchema: toolResultSchema(createSetPlanDataSchema),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    (input) => {
      try {
        const updated = service.updateSetPlan(input);
        return toolSuccess(
          updated,
          updated.validation.warnings.map((issue) => issue.message),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "list_set_plans",
    {
      title: "List set plans",
      description:
        "List saved set plans with bounded pagination. Use to find a plan id. Does not include full entry lists.",
      inputSchema: listSetPlansInputSchema,
      outputSchema: toolResultSchema(listSetPlansDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ limit, cursor }) => {
      try {
        return toolSuccess(service.listSetPlans(limit, cursor));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "record_hour_feedback",
    {
      title: "Record whole-hour feedback",
      description:
        "Record the user's explicit whole-hour verdict and original words against an exact full render/checksum. Never infer per-join ratings.",
      inputSchema: recordHourFeedbackSchema,
      outputSchema: toolResultSchema(recordHourFeedbackDataSchema),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (input) => {
      try {
        return toolSuccess(service.recordHourFeedback(input));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
  server.registerTool(
    "list_hour_feedback",
    {
      title: "List whole-hour feedback",
      description:
        "Read artifact-specific whole-hour verdicts, newest first. Changed plans and new renders do not inherit these verdicts.",
      inputSchema: listHourFeedbackSchema,
      outputSchema: toolResultSchema(listHourFeedbackDataSchema),
      annotations: { readOnlyHint: true },
    },
    ({ renderJobId }) => {
      try {
        return toolSuccess({ feedback: service.listHourFeedback(renderJobId) });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
  server.registerTool(
    "list_approved_recipes",
    {
      title: "List approved recipes",
      description:
        "List stored accepted/protected recipes so a named join can be resolved to track IDs and an optional recipeId for requiredTransitions.",
      inputSchema: listApprovedRecipesInputSchema,
      outputSchema: toolResultSchema(listApprovedRecipesDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ outgoingTrackId, incomingTrackId }) => {
      try {
        const recipes = service
          .listApprovedRecipes(outgoingTrackId, incomingTrackId)
          .map((row) => ({
            id: row.id,
            status: row.status,
            outgoingTrackId: row.payload.outgoingTrackId,
            incomingTrackId: row.payload.incomingTrackId,
            outgoingTitle: row.outgoingTitle,
            incomingTitle: row.incomingTitle,
            note: row.note,
            createdAt: row.createdAt,
            type: row.payload.type,
            barCount: row.payload.barCount,
            phraseShape: row.payload.phraseShape,
          }));
        return toolSuccess({ recipes });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "delete_set_plan",
    {
      title: "Delete set plan",
      description:
        "Permanently delete a saved set plan. Requires confirm=true. Use only when the user explicitly asks to delete. Irreversible.",
      inputSchema: deleteSetPlanInputSchema,
      outputSchema: toolResultSchema(deleteSetPlanDataSchema),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ setPlanId, confirm }) => {
      try {
        return toolSuccess(service.deleteSetPlan(setPlanId, confirm));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
