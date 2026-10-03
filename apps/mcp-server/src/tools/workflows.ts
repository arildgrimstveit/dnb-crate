import type { CatalogService } from "@dnb-crate/catalog";
import {
  startMixWorkflowInputSchema,
  mixWorkflowIdInputSchema,
  mixWorkflowDataSchema,
  preflightDataSchema,
  emptyInputSchema,
  toolResultSchema,
} from "@dnb-crate/domain";
import type { McpServer } from "@modelcontextprotocol/server";
import { toolFailure, toolSuccess } from "../map-result.ts";
export function registerWorkflowsTools(server: McpServer, service: CatalogService): void {
  server.registerTool(
    "start_mix_workflow",
    {
      title: "Create a verified first mix",
      description:
        "Preferred first-run operation: preflight configured roots, scan, analyze rhythm and keys, create and validate a strict plan, render and verify master/listen output. Returns promptly; poll get_mix_workflow. Reuse requestToken only for the same brief. Never accepts filesystem paths.",
      inputSchema: startMixWorkflowInputSchema,
      outputSchema: toolResultSchema(mixWorkflowDataSchema),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    (input) => {
      try {
        return toolSuccess(service.workflows.start(input));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
  for (const name of ["get_mix_workflow", "resume_mix_workflow", "cancel_mix_workflow"] as const) {
    server.registerTool(
      name,
      {
        title: name.replaceAll("_", " "),
        description:
          name === "get_mix_workflow"
            ? "Read persisted stage progress, issues, child IDs and verified output references."
            : name === "resume_mix_workflow"
              ? "Resume an interrupted or blocked mix; preserve plans and completed valid work. Changed planned sources require a new workflow."
              : "Cancel this workflow and exclusively owned child jobs. Cleanup settles before worker ownership is released.",
        inputSchema: mixWorkflowIdInputSchema,
        outputSchema: toolResultSchema(mixWorkflowDataSchema),
        annotations: { readOnlyHint: name === "get_mix_workflow", idempotentHint: true },
      },
      async ({ id }) => {
        try {
          return toolSuccess(
            name === "get_mix_workflow"
              ? service.workflows.get(id)
              : name === "resume_mix_workflow"
                ? await service.workflows.resume(id)
                : service.workflows.cancel(id),
          );
        } catch (error) {
          return toolFailure(error);
        }
      },
    );
  }
  server.registerTool(
    "get_mix_preflight",
    {
      title: "Check first-mix prerequisites",
      description:
        "Check configured roots, output writability, FFmpeg capabilities and KeyFinder. Brief-specific readiness and conditional stretching requirements are checked against the actual plan.",
      inputSchema: emptyInputSchema,
      outputSchema: toolResultSchema(preflightDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      try {
        return toolSuccess(await service.workflows.preflight.check());
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
