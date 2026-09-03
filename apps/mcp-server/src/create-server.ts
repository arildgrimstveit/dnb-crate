import type { CatalogService } from "@dnb-crate/catalog";
import {
  APP_NAME,
  APP_VERSION,
  analysisJobSchema,
  analysisReportDataSchema,
  buildDnbSetPromptArgsSchema,
  cancelRenderJobDataSchema,
  cancelRenderJobInputSchema,
  compareTrackAnalysesDataSchema,
  compareTrackAnalysesInputSchema,
  createCuePreviewDataSchema,
  createCuePreviewInputSchema,
  createSetPlanDataSchema,
  createSetPlanInputSchema,
  createTransitionPreviewInputSchema,
  deleteSetPlanDataSchema,
  deleteSetPlanInputSchema,
  emptyInputSchema,
  enrichmentJobSchema,
  enrichmentReportDataSchema,
  findCompatibleTracksDataSchema,
  findCompatibleTracksInputSchema,
  getAnalysisStatusInputSchema,
  getEnrichmentStatusInputSchema,
  getPlanningReadinessInputSchema,
  getRenderManifestInputSchema,
  getRenderStatusInputSchema,
  getSetPlanInputSchema,
  getTrackAnalysisInputSchema,
  getTrackSectionsDataSchema,
  getTrackSectionsInputSchema,
  getTrackDataSchema,
  getTrackInputSchema,
  libraryStatsDataSchema,
  listAnalysisJobsDataSchema,
  listEnrichmentJobsDataSchema,
  listRenderJobsDataSchema,
  listRenderJobsInputSchema,
  listSetPlansDataSchema,
  listSetPlansInputSchema,
  planTransitionDataSchema,
  planTransitionInputSchema,
  planningReadinessDataSchema,
  publicTrackSchema,
  renderJobSchema,
  renderManifestV1Schema,
  scanLibraryDataSchema,
  scanLibraryInputSchema,
  searchTracksDataSchema,
  searchTracksInputSchema,
  serverStatusDataSchema,
  setCuePointsDataSchema,
  setCuePointsInputSchema,
  setPlanV1Schema,
  startMetadataEnrichmentInputSchema,
  startSetRenderInputSchema,
  startTrackAnalysisInputSchema,
  toolResultSchema,
  trackAnalysisSchema,
  updateSetPlanInputSchema,
  updateTrackMetadataInputSchema,
  validateSetPlanDataSchema,
  validateSetPlanInputSchema,
  validateTransitionDataSchema,
  validateTransitionInputSchema,
} from "@dnb-crate/domain";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";

import { toolFailure, toolSuccess } from "./map-result.ts";

export type CreateServerOptions = {
  service: CatalogService;
};

export function createDnbCrateMcpServer(options: CreateServerOptions): McpServer {
  const { service } = options;
  const server = new McpServer(
    {
      name: APP_NAME,
      version: APP_VERSION,
      title: "DnB Crate",
      description:
        "Local drum & bass crate: catalog, set planning, beat-grid analysis, and WAV rendering with equal-power, phrase-mix, and bass-swap templates. Identify tracks and plans by UUID.",
    },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.registerTool(
    "get_server_status",
    {
      title: "Get server status",
      description:
        "Confirm process, database, configured library-root count, ffmpeg/ffprobe, and enrichment flags (enabled/musicbrainz/deezer/acoustidConfigured). Use for health checks. Does not expose absolute paths, secrets, API keys, or contact strings.",
      inputSchema: emptyInputSchema,
      outputSchema: toolResultSchema(serverStatusDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      try {
        return toolSuccess(await service.getServerStatus());
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "scan_library",
    {
      title: "Scan library",
      description:
        "Discover supported audio files under the configured library roots and upsert their metadata into the catalog. Use after adding files or when the catalog looks stale. Do not pass paths; roots come from server configuration. dryRun walks without writing.",
      inputSchema: scanLibraryInputSchema,
      outputSchema: toolResultSchema(scanLibraryDataSchema),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ dryRun }) => {
      try {
        const scanned = await service.scanLibrary({ dryRun });
        return toolSuccess(scanned.result, scanned.warnings);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "search_tracks",
    {
      title: "Search tracks",
      description:
        "Search and filter catalogued tracks. Use for questions like “find my Technimatic tracks” or BPM/rating/mood filters. Results are bounded (max 50) and paginated with an opaque cursor. Do not use this to read raw audio or filesystem paths.",
      inputSchema: searchTracksInputSchema,
      outputSchema: toolResultSchema(searchTracksDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input) => {
      try {
        return toolSuccess(service.searchTracks(input));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "get_track",
    {
      title: "Get track",
      description:
        "Return canonical catalog metadata and cue points for one track UUID from search_tracks. Use when you already have an id. Returns TRACK_NOT_FOUND when the id is unknown. Never include source file paths.",
      inputSchema: getTrackInputSchema,
      outputSchema: toolResultSchema(getTrackDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ trackId }) => {
      try {
        return toolSuccess(service.getTrack(trackId));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "update_track_metadata",
    {
      title: "Update track metadata",
      description:
        "Add or correct personal metadata: energy (1–10), rating (1–5), moods, subgenres, tags, notes, album, label, releaseDate, isrc, genres, plus optional manual BPM and musical key. Manual fields survive a later file scan and enrichment. Replacing list fields overwrites the previous list. Never accepts a file path. Requires a track UUID.",
      inputSchema: updateTrackMetadataInputSchema,
      outputSchema: toolResultSchema(publicTrackSchema),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    ({ trackId, ...patch }) => {
      try {
        return toolSuccess(service.updateTrackMetadata(trackId, patch));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "get_library_stats",
    {
      title: "Get library stats",
      description:
        "Return catalog counts, extension breakdown, total duration, and missing-metadata statistics. Use to answer “what metadata is missing” at library scale. Does not list individual file paths.",
      inputSchema: emptyInputSchema,
      outputSchema: toolResultSchema(libraryStatsDataSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    () => {
      try {
        return toolSuccess(service.getLibraryStats());
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "set_cue_points",
    {
      title: "Set cue points",
      description:
        "Replace all cue points on a track with an explicit list. Optional beatAnchorMs reconstructs the stored beat grid from canonical BPM. Positions are milliseconds from the start of the source file.",
      inputSchema: setCuePointsInputSchema,
      outputSchema: toolResultSchema(setCuePointsDataSchema),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    ({ trackId, cuePoints, beatAnchorMs }) => {
      try {
        return toolSuccess(service.setCuePoints(trackId, cuePoints, beatAnchorMs));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "start_track_analysis",
    {
      title: "Start track analysis",
      description:
        "Queue BPM/beat-grid/key/loudness analysis. Pass trackIds (scope ids), planningReadyOnly, or scope unanalyzed|stale|all|planningReady. Whole-library analysis is allowed via scope. Returns a job id; poll get_analysis_status. Analysis is advisory (confidence + provenance).",
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
      description: "Poll enrichment jobs. Pass enrichmentJobId for one job, or omit to list recent jobs.",
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
        "Generate and persist a deterministic ordered set plan from structured constraints (duration, energy arc, start/end tracks, moods, seed). Translate natural language into these fields first. Returns the plan, score explanations, and validation. Does not render audio. May return a partial plan if the library is too small.",
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
        "Return errors, warnings, duration delta, energy-arc diagnostics, and render-readiness (FFmpeg, fingerprints, trims). Use after create or update. Errors mean the plan is not structurally valid; renderReadiness.ready must be true before start_set_render.",
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

  server.registerTool(
    "create_transition_preview",
    {
      title: "Create transition preview",
      description:
        "Queue a 30–60 second WAV preview around one planned transition. Optional template phrase_mix or bass_swap (default: the plan’s type). Identical previews are cached by content hash. Low-confidence grids cannot enter aligned previews unless allowLowConfidence is true.",
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
        "Validate a saved set plan and queue a full WAV render. Phrase-mix and bass-swap use beat-aligned templates; crossfade remains equal-power. Returns a job id immediately. Poll get_render_status. WAV only. Pass allowLowConfidence / allowExcessiveTempo to override analysis and ±3% rate bounds.",
      inputSchema: startSetRenderInputSchema,
      outputSchema: toolResultSchema(renderJobSchema),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
    },
    async ({ setPlanId, edgeFadeMs, allowLowConfidence, allowExcessiveTempo }) => {
      try {
        const started = await service.startSetRender({
          setPlanId,
          edgeFadeMs,
          allowLowConfidence,
          allowExcessiveTempo,
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
        "Poll a preview or full-render job. progress is 0–1. On success, outputRootRelativePath is under the configured output directory (not an absolute path). Use get_render_manifest for checksums and loudness.",
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

  server.registerResource(
    "track",
    new ResourceTemplate("dnbcrate://tracks/{trackId}", {
      list: () => ({
        resources: service.listTrackResources().map((track) => ({
          uri: `dnbcrate://tracks/${track.id}`,
          name: `${track.artist ?? "Unknown"} – ${track.title}`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Track",
      description:
        "Canonical public metadata for one catalogued track. Does not include source file paths or audio.",
      mimeType: "application/json",
    },
    (uri, { trackId }) => {
      const id = Array.isArray(trackId) ? trackId[0] : trackId;
      if (typeof id !== "string") {
        throw new Error("trackId is required");
      }
      const track = service.getTrack(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(track, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "track-analysis",
    new ResourceTemplate("dnbcrate://tracks/{trackId}/analysis", {
      list: () => ({
        resources: service.listAnalysisResources().map((analysis) => ({
          uri: `dnbcrate://tracks/${analysis.trackId}/analysis`,
          name: `analysis ${analysis.trackId}`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Track analysis",
      description:
        "Advisory beat grid, BPM, key, bands, and suggested cues for one track. Not canonical metadata.",
      mimeType: "application/json",
    },
    (uri, { trackId }) => {
      const id = Array.isArray(trackId) ? trackId[0] : trackId;
      if (typeof id !== "string") {
        throw new Error("trackId is required");
      }
      const analysis = service.getTrackAnalysis(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(analysis, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "set-plan",
    new ResourceTemplate("dnbcrate://set-plans/{setPlanId}", {
      list: () => ({
        resources: service.listSetPlans(100).plans.map((plan) => ({
          uri: `dnbcrate://set-plans/${plan.id}`,
          name: plan.name,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Set plan",
      description: "Saved ordered set plan (timing only, no rendered audio).",
      mimeType: "application/json",
    },
    (uri, { setPlanId }) => {
      const id = Array.isArray(setPlanId) ? setPlanId[0] : setPlanId;
      if (typeof id !== "string") {
        throw new Error("setPlanId is required");
      }
      const plan = service.getSetPlan(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(plan, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "render-manifest",
    new ResourceTemplate("dnbcrate://renders/{renderJobId}/manifest", {
      list: () => ({
        resources: service.listRenderResources().map((job) => ({
          uri: `dnbcrate://renders/${job.id}/manifest`,
          name: job.outputFileName ?? `render ${job.id}`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Render manifest",
      description:
        "Versioned manifest for a succeeded render job. Metadata only — not the audio file.",
      mimeType: "application/json",
    },
    (uri, { renderJobId }) => {
      const id = Array.isArray(renderJobId) ? renderJobId[0] : renderJobId;
      if (typeof id !== "string") {
        throw new Error("renderJobId is required");
      }
      const manifest = service.getRenderManifest(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(manifest, null, 2),
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "build-dnb-set",
    {
      title: "Build a DnB set",
      description:
        "Turn a natural-language set brief into structured create_set_plan arguments, then validate and revise.",
      argsSchema: buildDnbSetPromptArgsSchema,
    },
    ({ request }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `The user wants a drum & bass set from their local crate.

Brief:
${request}

Workflow:
1. Call get_planning_readiness if metadata may be incomplete. Optionally start_track_analysis for selected UUIDs or scope stale/unanalyzed with engines ["dnb-crate-dsp"] and poll get_analysis_status. Inspect get_track_analysis / get_track_sections.
2. Use search_tracks to resolve named tracks to UUIDs (never filesystem paths). Filter on energy, sub-bass, and brightness when the brief is sonic.
3. Call create_set_plan with structured fields only: name, targetDurationMs, requestedArc, preferredMoods/Subgenres/Artists, startTrackId/endTrackId, artistRepeatSpacing, seed. The planner chooses phrase_mix/bass_swap from the join (head/tail sections), tempo-matches aligned pairs within ±3%, and uses an 8s crossfade on tempo mismatch. Playable windows come from mix-in/mix-out sections, not file bounds.
4. Call validate_set_plan. If there are errors or important warnings, call update_set_plan with explicit entry edits.
5. For a pair you want to override: plan_transition, then update_set_plan.applyTransition (keeps the outgoing start so the proposal applies). Use create_transition_preview or create_cue_preview to audition. Low-confidence grids must not be treated as facts unless the user sets allowLowConfidence.
6. start_set_render. Poll get_render_status; read get_render_manifest when succeeded (includes downbeatOffsetMs, alignmentMode, and per-band automation).
7. Summarize the tracklist with timeline times, why tracks were scored in, remaining warnings, and render job id.

Do not invent BPM, key, energy, or cue points. Analysis is advisory. Provenance is manual > published > analyzed > tag. Playback-rate changes stay within ±3% unless allowExcessiveTempo.`,
          },
        },
      ],
    }),
  );

  return server;
}
