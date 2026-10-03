import type { CatalogService } from "@dnb-crate/catalog";
import {
  emptyInputSchema,
  getTrackDataSchema,
  getTrackInputSchema,
  libraryStatsDataSchema,
  publicTrackSchema,
  scanLibraryDataSchema,
  scanLibraryInputSchema,
  searchTracksDataSchema,
  searchTracksInputSchema,
  serverStatusDataSchema,
  setCuePointsDataSchema,
  setCuePointsInputSchema,
  toolResultSchema,
  updateTrackMetadataInputSchema,
} from "@dnb-crate/domain";
import type { McpServer } from "@modelcontextprotocol/server";
import { toolFailure, toolSuccess } from "../map-result.ts";
export function registerCatalogTools(server: McpServer, service: CatalogService): void {
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
        "Search and filter catalogued tracks. Use for artist/title queries or BPM/rating/mood filters. Results are bounded (max 50) and paginated with an opaque cursor. Do not use this to read raw audio or filesystem paths.",
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
}
