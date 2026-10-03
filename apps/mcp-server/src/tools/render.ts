import type { CatalogService } from "@dnb-crate/catalog";
import {
  cancelRenderJobDataSchema,
  cancelRenderJobInputSchema,
  createTransitionPreviewInputSchema,
  getRenderManifestInputSchema,
  getRenderStatusInputSchema,
  listRenderJobsDataSchema,
  listRenderJobsInputSchema,
  renderJobSchema,
  renderManifestV1Schema,
  startSetRenderInputSchema,
  toolResultSchema,
} from "@dnb-crate/domain";
import type { McpServer } from "@modelcontextprotocol/server";
import { toolFailure, toolSuccess } from "../map-result.ts";
export function registerRenderTools(server: McpServer, service: CatalogService): void {
  server.registerTool(
    "create_transition_preview",
    {
      title: "Create transition preview",
      description:
        "Queue a 30–60 second FLAC preview around one planned transition. Optional template phrase_mix or bass_swap (default: the plan’s type). Identical previews are cached by content hash. Low-confidence grids cannot enter aligned previews unless allowLowConfidence is true.",
      inputSchema: createTransitionPreviewInputSchema,
      outputSchema: toolResultSchema(renderJobSchema),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        const started = await service.createTransitionPreview(input);
        return toolSuccess(started.job, started.warnings);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "start_set_render",
    {
      title: "Start set render",
      description:
        "Validate a saved set plan and queue a full render: 24-bit 48 kHz FLAC master (job id filename) plus a 16-bit 48 kHz listen FLAC named from the plan. Phrase-mix and bass-swap use beat-aligned templates; crossfade remains equal-power. Returns a job id immediately. Poll get_render_status. Pass allowLowConfidence / allowExcessiveTempo to override analysis and ±3% rate bounds. Pass allowOverlongDuration when the only blockers are duration / the hour audition window.",
      inputSchema: startSetRenderInputSchema,
      outputSchema: toolResultSchema(renderJobSchema),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
    },
    async ({
      setPlanId,
      edgeFadeMs,
      allowLowConfidence,
      allowExcessiveTempo,
      allowOverlongDuration,
    }) => {
      try {
        const started = await service.startSetRender({
          setPlanId,
          edgeFadeMs,
          allowLowConfidence,
          allowExcessiveTempo,
          allowOverlongDuration,
        });
        return toolSuccess(started.job, started.warnings);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "get_render_status",
    {
      title: "Get render status",
      description:
        "Poll a preview or full-render job. progress is 0–1. On success, outputRootRelativePath is the 24-bit master and listenRootRelativePath is the 16-bit named listen copy, both under the configured output directory (not absolute paths). Use get_render_manifest for checksums and loudness. Point the user at the listen file for playback. Do not copy the master to a second 24-bit file.",
      inputSchema: getRenderStatusInputSchema,
      outputSchema: toolResultSchema(renderJobSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ renderJobId }) => {
      try {
        return toolSuccess(service.getRenderStatus(renderJobId));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "list_render_jobs",
    {
      title: "List render jobs",
      description:
        "List recent preview and full-render jobs with bounded pagination. Optional setPlanId filter. Does not include manifests.",
      inputSchema: listRenderJobsInputSchema,
      outputSchema: toolResultSchema(listRenderJobsDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ limit, cursor, setPlanId }) => {
      try {
        return toolSuccess(service.listRenderJobs(limit, cursor, setPlanId));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "cancel_render_job",
    {
      title: "Cancel render job",
      description:
        "Cancel a queued or running render. Requires confirm=true. Kills the FFmpeg child process. No-op for already terminal jobs (returns cancelled=false).",
      inputSchema: cancelRenderJobInputSchema,
      outputSchema: toolResultSchema(cancelRenderJobDataSchema),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ renderJobId, confirm }) => {
      try {
        return toolSuccess(service.cancelRenderJob(renderJobId, confirm));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "get_render_manifest",
    {
      title: "Get render manifest",
      description:
        "Return the versioned render manifest after a job succeeds: fingerprints, trims, gains, FFmpeg version, LUFS, true peak, checksum. Available as resource dnbcrate://renders/{renderJobId}/manifest. Fails until status is succeeded.",
      inputSchema: getRenderManifestInputSchema,
      outputSchema: toolResultSchema(renderManifestV1Schema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ renderJobId }) => {
      try {
        return toolSuccess(service.getRenderManifest(renderJobId));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
