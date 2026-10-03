import type { CatalogService } from "@dnb-crate/catalog";
import {
  analysisJobSchema,
  analysisReportDataSchema,
  compareTrackAnalysesDataSchema,
  compareTrackAnalysesInputSchema,
  createCuePreviewDataSchema,
  createCuePreviewInputSchema,
  emptyInputSchema,
  enrichmentJobSchema,
  enrichmentReportDataSchema,
  getAnalysisStatusInputSchema,
  getEnrichmentStatusInputSchema,
  getTrackAnalysisInputSchema,
  getTrackSectionsDataSchema,
  getTrackSectionsInputSchema,
  listAnalysisJobsDataSchema,
  listEnrichmentJobsDataSchema,
  startMetadataEnrichmentInputSchema,
  startTrackAnalysisInputSchema,
  toolResultSchema,
  trackAnalysisSchema,
} from "@dnb-crate/domain";
import type { McpServer } from "@modelcontextprotocol/server";
import { toolFailure, toolSuccess } from "../map-result.ts";
export function registerAnalysisTools(server: McpServer, service: CatalogService): void {
  server.registerTool(
    "start_track_analysis",
    {
      title: "Start track analysis",
      description:
        "Queue BPM/beat-grid/loudness analysis with dnb-crate-dsp (the only analysis engine). Pass trackIds (scope ids), planningReadyOnly, or scope unanalyzed|stale|all|planningReady. Whole-library analysis is allowed via scope. Returns a job id; poll get_analysis_status. Analysis is advisory (confidence + provenance).",
      inputSchema: startTrackAnalysisInputSchema,
      outputSchema: toolResultSchema(analysisJobSchema),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    (input) => {
      try {
        const started = service.startTrackAnalysis(input);
        return toolSuccess(started.job);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "get_analysis_status",
    {
      title: "Get analysis status",
      description:
        "Poll analysis jobs. Pass analysisJobId for one job, or omit to list recent jobs. Does not return audio.",
      inputSchema: getAnalysisStatusInputSchema,
      outputSchema: toolResultSchema(listAnalysisJobsDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ analysisJobId }) => {
      try {
        return toolSuccess(service.getAnalysisStatus(analysisJobId));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "get_track_analysis",
    {
      title: "Get track analysis",
      description:
        "Return grid summary, BPM, key with mode, sections, descriptors, and canonical provenance. Beat arrays are omitted (use the analysis resource). Fails until start_track_analysis has completed.",
      inputSchema: getTrackAnalysisInputSchema,
      outputSchema: toolResultSchema(trackAnalysisSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ trackId, engine }) => {
      try {
        return toolSuccess(service.toToolAnalysis(service.getTrackAnalysis(trackId, engine)));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "compare_track_analyses",
    {
      title: "Compare track analyses",
      description: "Side-by-side BPM/key/sections from every stored engine for one track UUID.",
      inputSchema: compareTrackAnalysesInputSchema,
      outputSchema: toolResultSchema(compareTrackAnalysesDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ trackId }) => {
      try {
        return toolSuccess(service.compareTrackAnalyses(trackId));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "get_track_sections",
    {
      title: "Get track sections",
      description: "Return intro/build/drop/breakdown/bridge/outro sections for a track UUID.",
      inputSchema: getTrackSectionsInputSchema,
      outputSchema: toolResultSchema(getTrackSectionsDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ trackId, engine }) => {
      try {
        return toolSuccess(service.getTrackSections(trackId, engine));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "get_analysis_report",
    {
      title: "Get analysis report",
      description:
        "Library-wide engine agreement vs published/manual BPM. Splits in-range (160–190) references from out-of-range published values so a miss is not confused with a label outside DnB tempo. Use after analyzing a crate, or via CLI analysis:gate.",
      inputSchema: emptyInputSchema,
      outputSchema: toolResultSchema(analysisReportDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    () => {
      try {
        return toolSuccess(service.getAnalysisReport());
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "start_metadata_enrichment",
    {
      title: "Start metadata enrichment",
      description:
        "Look up MusicBrainz / Deezer / AcoustID metadata. scope unmatched (default) skips already matched rows; all re-checks; ids uses trackIds. dryRun looks up without writing track fields. Never overwrites manual fields. Does not write tags to audio files. Secrets never appear in results.",
      inputSchema: startMetadataEnrichmentInputSchema,
      outputSchema: toolResultSchema(enrichmentJobSchema),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    (input) => {
      try {
        const started = service.startMetadataEnrichment(input);
        return toolSuccess(started.job);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "get_enrichment_status",
    {
      title: "Get enrichment status",
      description:
        "Poll enrichment jobs. Pass enrichmentJobId for one job, or omit to list recent jobs.",
      inputSchema: getEnrichmentStatusInputSchema,
      outputSchema: toolResultSchema(listEnrichmentJobsDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ enrichmentJobId }) => {
      try {
        return toolSuccess(service.getEnrichmentStatus(enrichmentJobId));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "get_enrichment_report",
    {
      title: "Get enrichment report",
      description:
        "Library-wide match counts by method, unmatched, needsReview, published BPM writes, BPM disagreements, and duplicate recording groups. Does not include API keys or contact strings.",
      inputSchema: emptyInputSchema,
      outputSchema: toolResultSchema(enrichmentReportDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    () => {
      try {
        return toolSuccess(service.getEnrichmentReport());
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "create_cue_preview",
    {
      title: "Create cue preview",
      description:
        "Render an 8-second WAV around a detected intro/drop/breakdown/outro cue for ear-checking.",
      inputSchema: createCuePreviewInputSchema,
      outputSchema: toolResultSchema(createCuePreviewDataSchema),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        return toolSuccess(await service.createCuePreview(input));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
