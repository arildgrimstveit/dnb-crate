import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";

import type {
  AnalysisJob,
  AppConfig,
  CompatibleTrack,
  CreateSetPlanInput,
  CreateSetPlanResult,
  CuePoint,
  CuePointType,
  EnrichmentJob,
  EnrichmentReport,
  EnrichmentScope,
  LibraryStats,
  Logger,
  PlanningReadiness,
  PublicTrack,
  RenderJob,
  RenderManifestV1,
  ScanLibraryResult,
  SearchTracksInput,
  SearchTracksResult,
  ServerStatus,
  SetPlanSummary,
  SetPlanV1,
  Track,
  TrackAnalysisView,
  TrackMetadataPatch,
  TransitionProposal,
  TransitionValidation,
  ValidateSetPlanResult,
  AnalysisEngineId,
} from "@dnb-crate/domain";
import {
  APP_NAME,
  APP_VERSION,
  COMPATIBLE_TRACKS_LIMIT_MAX,
  DEFAULT_ANALYSIS_ENGINE,
  DomainError,
  MIN_ANALYSIS_CONFIDENCE,
  RESOURCE_LIST_LIMIT,
  SCAN_WARNING_LIMIT,
  assertPlaybackRate,
  DNB_BPM_MAX,
  DNB_BPM_MIN,
  keyAgreement,
  normalizeDnbBpm,
  resolveBpmHint,
  resolveCanonicalBpm,
  scoreCandidate,
  effectiveEnergy,
  genresMatchFilter,
  matchesDescriptorFilters,
  resolveDescriptorFilters,
  toPublicTrack,
} from "@dnb-crate/domain";
import { ffmpegMixReady } from "@dnb-crate/audio-renderer";

import type { SqliteDatabase } from "./db.ts";
import { fingerprintFile } from "./fingerprint.ts";
import { extractAudioMetadata } from "./metadata.ts";
import { isPathInsideAnyRoot } from "./paths.ts";
import { draftSetPlan } from "./planning/planner.ts";
import { analysisToTimeline, buildEntries } from "./planning/timeline.ts";
import { validateSetPlan } from "./planning/validate.ts";
import type { TrackRepository } from "./repository.ts";
import { resolveLibraryRoots, walkLibrary } from "./scanner.ts";
import type { SetPlanRepository } from "./set-plan-repository.ts";
import type { RenderCoordinator } from "./render/coordinator.ts";
import type { AnalysisCoordinator } from "./analysis/coordinator.ts";
import type { AnalysisRepository } from "./analysis-repository.ts";
import type { EnrichmentCoordinator } from "./enrichment/coordinator.ts";
import { planTransition, validateTransition } from "./planning/transition-planner.ts";
import { probePythonEngine } from "./analysis/python-engine.ts";

export type CatalogRuntime = {
  db: SqliteDatabase;
  repository: TrackRepository;
  service: CatalogService;
  close: () => void;
};

function capWarnings(warnings: string[]): string[] {
  if (warnings.length <= SCAN_WARNING_LIMIT) {
    return warnings;
  }
  const extra = warnings.length - SCAN_WARNING_LIMIT;
  return [...warnings.slice(0, SCAN_WARNING_LIMIT), `…and ${extra} more warning(s)`];
}

export class CatalogService {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: TrackRepository,
    private readonly setPlans: SetPlanRepository,
    private readonly renders: RenderCoordinator,
    private readonly analysis: AnalysisCoordinator,
    private readonly analyses: AnalysisRepository,
    private readonly enrichment: EnrichmentCoordinator,
    private readonly logger: Logger,
  ) {}

  async getServerStatus(): Promise<ServerStatus> {
    const { resolved } = await resolveLibraryRoots(this.config.libraryRoots);
    let outputRootConfigured = false;
    try {
      await access(this.config.outputRoot, constants.F_OK);
      outputRootConfigured = true;
    } catch {
      outputRootConfigured = this.config.outputRoot.length > 0;
    }

    const python = await probePythonEngine(this.config);
    const detected = await this.renders.detect();
    const ffmpegReady = ffmpegMixReady(detected);

    return {
      name: APP_NAME,
      version: APP_VERSION,
      databaseReady: true,
      libraryRootCount: this.config.libraryRoots.length,
      libraryRootsReady: resolved.length,
      outputRootConfigured,
      ffmpegAvailable: ffmpegReady,
      ffprobeAvailable: detected !== null,
      ffmpegVersion: detected?.ffmpegVersion ?? null,
      ffprobeVersion: detected?.ffprobeVersion ?? null,
      supportedExtensions: this.config.supportedExtensions,
      pythonAnalyzerAvailable: python.available,
      pythonAnalyzerEngines: python.engines,
      enrichment: {
        enabled: this.config.enrichment?.enabled === true,
        musicbrainz: this.config.enrichment?.musicbrainz?.enabled !== false,
        deezer: this.config.enrichment?.deezer?.enabled !== false,
        acoustidConfigured: Boolean(this.config.enrichment?.acoustid?.apiKey),
      },
    };
  }

  async scanLibrary(options: { dryRun?: boolean } = {}): Promise<{
    result: ScanLibraryResult;
    warnings: string[];
  }> {
    const dryRun = options.dryRun ?? false;
    const walk = await walkLibrary(this.config, this.logger);
    const warnings = [...walk.warnings];
    const seenPaths = new Set<string>();
    let upserted = 0;
    let moved = 0;
    let skippedMalformed = 0;

    const { resolved } = await resolveLibraryRoots(this.config.libraryRoots);

    for (const file of walk.files) {
      seenPaths.add(file.realPath);
      try {
        const metadata = await extractAudioMetadata(file.realPath);
        const fileFingerprint = await fingerprintFile(file.realPath, {
          size: file.size,
          mtimeMs: file.mtimeMs,
        });
        if (dryRun) {
          upserted += 1;
          continue;
        }
        const written = this.repository.upsertFromScan({
          filePath: file.realPath,
          fileFingerprint,
          artist: metadata.artist,
          title: metadata.title,
          album: metadata.album,
          durationMs: metadata.durationMs,
          sampleRateHz: metadata.sampleRateHz,
          channels: metadata.channels,
          bpm: metadata.bpm,
          bpmSource: metadata.bpmSource,
          musicalKey: metadata.musicalKey,
          camelotKey: metadata.camelotKey,
          keySource: metadata.keySource,
          label: metadata.label,
          releaseDate: metadata.releaseDate,
          isrc: metadata.isrc,
          recordingMbid: metadata.recordingMbid,
          genres: metadata.genres,
        });
        upserted += 1;
        if (written.moved) {
          moved += 1;
        }
      } catch (error) {
        skippedMalformed += 1;
        warnings.push(`Malformed or unreadable audio: ${file.relativeFromRoot} (${String(error)})`);
        this.logger.warn(
          { file: file.relativeFromRoot, err: String(error) },
          "skipped malformed audio",
        );
      }
    }

    let markedMissing = 0;
    if (!dryRun) {
      const missingIds: string[] = [];
      for (const entry of this.repository.listPathIndex()) {
        if (!isPathInsideAnyRoot(entry.filePath, resolved)) {
          continue;
        }
        if (!seenPaths.has(entry.filePath)) {
          missingIds.push(entry.id);
        }
      }
      this.repository.markMissing(missingIds);
      markedMissing = missingIds.length;
    }

    return {
      result: {
        dryRun,
        rootsScanned: resolved.length,
        filesSeen: walk.files.length,
        upserted,
        moved,
        skippedUnsupported: walk.skippedUnsupported,
        skippedMalformed,
        markedMissing,
      },
      warnings: capWarnings(warnings),
    };
  }

  searchTracks(input: SearchTracksInput): SearchTracksResult {
    return this.repository.search(input);
  }

  getTrack(trackId: string): PublicTrack & { cuePoints: CuePoint[] } {
    const track = this.repository.findById(trackId);
    if (!track) {
      throw new DomainError("TRACK_NOT_FOUND", `No track with id ${trackId}`);
    }
    return { ...toPublicTrack(track), cuePoints: this.repository.listCuePoints(trackId) };
  }

  updateTrackMetadata(trackId: string, patch: TrackMetadataPatch): PublicTrack {
    if (
      patch.energy !== undefined &&
      patch.energy !== null &&
      (!Number.isInteger(patch.energy) || patch.energy < 1 || patch.energy > 10)
    ) {
      throw new DomainError("INVALID_METADATA", "energy must be an integer from 1 to 10");
    }
    if (
      patch.rating !== undefined &&
      patch.rating !== null &&
      (!Number.isInteger(patch.rating) || patch.rating < 1 || patch.rating > 5)
    ) {
      throw new DomainError("INVALID_METADATA", "rating must be an integer from 1 to 5");
    }
    if (patch.bpm !== undefined && patch.bpm !== null && !(patch.bpm > 0 && patch.bpm <= 400)) {
      throw new DomainError("INVALID_METADATA", "bpm must be between 0 and 400");
    }
    return toPublicTrack(this.repository.updateMetadata(trackId, patch));
  }

  setCuePoints(
    trackId: string,
    cuePoints: Array<{
      type: CuePointType;
      positionMs: number;
      beatIndex?: number | null;
      barIndex?: number | null;
      confidence?: number | null;
      label?: string | null;
    }>,
    beatAnchorMs?: number,
  ): { trackId: string; cuePoints: CuePoint[] } {
    const result = { trackId, cuePoints: this.repository.replaceCuePoints(trackId, cuePoints) };
    if (beatAnchorMs !== undefined) {
      this.analysis.setBeatAnchor(trackId, beatAnchorMs);
    }
    return result;
  }

  startTrackAnalysis(input: {
    trackIds?: string[];
    planningReadyOnly?: boolean;
    scope?: "ids" | "planningReady" | "unanalyzed" | "stale" | "all";
    engines?: AnalysisEngineId[];
  }): {
    job: AnalysisJob;
  } {
    const scope =
      input.scope ?? (input.planningReadyOnly === true ? "planningReady" : "ids");
    const ids = new Set<string>();
    for (const id of input.trackIds ?? []) {
      ids.add(id);
    }
    if (scope === "unanalyzed" || scope === "stale" || scope === "all") {
      for (const id of this.analyses.listIdsForScope(scope)) {
        ids.add(id);
      }
    }
    if (scope === "planningReady" || input.planningReadyOnly === true) {
      for (const row of this.getPlanningReadiness().tracks) {
        if (row.ready) {
          ids.add(row.trackId);
        }
      }
    }
    if (ids.size === 0) {
      throw new DomainError(
        "ANALYSIS_FAILED",
        "No tracks to analyze. Pass trackIds, planningReadyOnly=true, or scope unanalyzed|stale|all|planningReady.",
      );
    }
    return this.analysis.start(
      [...ids],
      input.engines ?? [this.config.analysis?.defaultEngine ?? DEFAULT_ANALYSIS_ENGINE],
    );
  }

  getAnalysisStatus(analysisJobId?: string): { jobs: AnalysisJob[] } {
    return this.analysis.getStatus(analysisJobId);
  }

  getTrackAnalysis(trackId: string, engine?: string): TrackAnalysisView {
    const track = this.requireTrack(trackId);
    const stored = this.analyses.findByTrackId(trackId, engine);
    const view = this.analyses.toView(track, stored);
    if (!view) {
      throw new DomainError(
        "ANALYSIS_FAILED",
        `No analysis for track ${trackId}. Call start_track_analysis first.`,
        { retryable: true },
      );
    }
    return view;
  }

  toToolAnalysis(view: TrackAnalysisView): Omit<TrackAnalysisView, "beatTimesMs" | "downbeatTimesMs"> {
    const { beatTimesMs: _b, downbeatTimesMs: _d, ...rest } = view;
    return rest;
  }

  compareTrackAnalyses(trackId: string): {
    trackId: string;
    engines: Array<{
      analyzerName: string;
      analyzerVersion: string;
      bpm: number | null;
      bpmConfidence: number | null;
      gridRejected: boolean;
      musicalKey: string | null;
      keyConfidence: number | null;
      downbeatConfidence: number | null;
      sectionCount: number;
      engineRuntimeMs: number | null;
      analyzedAt: string;
      chromaVector: number[] | null;
      energy: number | null;
      danceability: number | null;
      acousticness: number | null;
      melodicness: number | null;
      valence: number | null;
    }>;
  } {
    this.requireTrack(trackId);
    const rows = this.analyses.listByTrackId(trackId);
    return {
      trackId,
      engines: rows.map((row) => ({
        analyzerName: row.analyzerName,
        analyzerVersion: row.analyzerVersion,
        bpm: row.bpm,
        bpmConfidence: row.bpmConfidence,
        gridRejected: row.gridRejected,
        musicalKey: row.musicalKey,
        keyConfidence: row.keyConfidence,
        downbeatConfidence: row.downbeatConfidence,
        sectionCount: row.sections.length,
        engineRuntimeMs: row.engineRuntimeMs,
        analyzedAt: row.analyzedAt,
        chromaVector: row.descriptors?.chromaVector ?? null,
        energy: row.descriptors?.energy ?? null,
        danceability: row.descriptors?.danceability ?? null,
        acousticness: row.descriptors?.acousticness ?? null,
        melodicness: row.descriptors?.melodicness ?? null,
        valence: row.descriptors?.valence ?? null,
      })),
    };
  }

  getTrackSections(trackId: string, engine?: string): {
    trackId: string;
    analyzerName: string;
    sections: TrackAnalysisView["sections"];
  } {
    const analysis = this.getTrackAnalysis(trackId, engine);
    return {
      trackId,
      analyzerName: analysis.analyzerName,
      sections: analysis.sections,
    };
  }

  getAnalysisReport(): {
    trackCount: number;
    engineCounts: Record<string, number>;
    inRange: { count: number; withinHalf: number; accepted: number; acceptedExact: number };
    outOfRange: { count: number };
    publishedOrManualCompared: number;
    dspWithinHalfBpm: number;
    engines: Array<{
      trackId: string;
      title: string;
      analyzerName: string;
      bpm: number | null;
      bpmConfidence: number | null;
      gridRejected: boolean;
      gridSource: "analyzed" | "reference" | "anchor" | "sidecar" | null;
      keyAgreement: "exact" | "relative" | "number_pm1" | "clash" | null;
      sectionCount: number;
    }>;
    gridSourceCounts: { analyzed: number; reference: number; anchor: number; sidecar: number };
    keyAgreementCounts: {
      exact: number;
      relative: number;
      number_pm1: number;
      clash: number;
      unknown: number;
    };
    needsReview: Array<{
      trackId: string;
      title: string;
      reason: "out-of-range" | "disagreement";
      canonicalBpm: number | null;
      canonicalSource: string | null;
      publishedFolded: number | null;
      dspBpm: number | null;
      engines: Record<string, number | null>;
    }>;
    disagreements: Array<{
      trackId: string;
      title: string;
      canonicalBpm: number | null;
      canonicalSource: string | null;
      engines: Record<string, number | null>;
    }>;
  } {
    const engineCounts: Record<string, number> = {};
    const disagreements: Array<{
      trackId: string;
      title: string;
      canonicalBpm: number | null;
      canonicalSource: string | null;
      engines: Record<string, number | null>;
    }> = [];
    const needsReview: Array<{
      trackId: string;
      title: string;
      reason: "out-of-range" | "disagreement";
      canonicalBpm: number | null;
      canonicalSource: string | null;
      publishedFolded: number | null;
      dspBpm: number | null;
      engines: Record<string, number | null>;
    }> = [];
    const engineRows: Array<{
      trackId: string;
      title: string;
      analyzerName: string;
      bpm: number | null;
      bpmConfidence: number | null;
      gridRejected: boolean;
      gridSource: "analyzed" | "reference" | "anchor" | "sidecar" | null;
      keyAgreement: "exact" | "relative" | "number_pm1" | "clash" | null;
      sectionCount: number;
    }> = [];
    const gridSourceCounts = { analyzed: 0, reference: 0, anchor: 0, sidecar: 0 };
    const keyAgreementCounts = {
      exact: 0,
      relative: 0,
      number_pm1: 0,
      clash: 0,
      unknown: 0,
    };
    let inRangeCount = 0;
    let withinHalf = 0;
    let accepted = 0;
    let acceptedExact = 0;
    let outOfRangeCount = 0;
    for (const track of this.repository.listAll()) {
      const rows = this.analyses.listByTrackId(track.id);
      if (rows.length === 0) {
        continue;
      }
      for (const row of rows) {
        engineCounts[row.analyzerName] = (engineCounts[row.analyzerName] ?? 0) + 1;
      }
      const view = this.analyses.toView(track, this.analyses.findByTrackId(track.id));
      if (!view) {
        continue;
      }
      const engines: Record<string, number | null> = {};
      for (const row of rows) {
        engines[row.analyzerName] = row.bpm;
        const refKey =
          view.canonicalKeySource === "manual" || view.canonicalKeySource === "published"
            ? view.canonicalKey
            : null;
        engineRows.push({
          trackId: track.id,
          title: track.title,
          analyzerName: row.analyzerName,
          bpm: row.bpm,
          bpmConfidence: row.bpmConfidence,
          gridRejected: row.gridRejected,
          gridSource: row.gridSource ?? "analyzed",
          keyAgreement: keyAgreement(row.musicalKey, refKey),
          sectionCount: row.sections.length,
        });
        const agreement = keyAgreement(row.musicalKey, refKey);
        if (agreement) {
          keyAgreementCounts[agreement] += 1;
        } else {
          keyAgreementCounts.unknown += 1;
        }
        const source = row.gridSource ?? "analyzed";
        if (
          source === "reference" ||
          source === "anchor" ||
          source === "analyzed" ||
          source === "sidecar"
        ) {
          gridSourceCounts[source] += 1;
        }
      }
      const ref =
        view.canonicalBpmSource === "manual" || view.canonicalBpmSource === "published"
          ? view.canonicalBpm
          : null;
      if (ref == null) {
        continue;
      }
      const dsp = engines["dnb-crate-dsp"];
      const inRange = ref >= DNB_BPM_MIN - 1e-6 && ref <= DNB_BPM_MAX + 1e-6;
      const folded = normalizeDnbBpm(ref)?.bpm ?? null;
      if (!inRange) {
        outOfRangeCount += 1;
        needsReview.push({
          trackId: track.id,
          title: track.title,
          reason: "out-of-range",
          canonicalBpm: view.canonicalBpm,
          canonicalSource: view.canonicalBpmSource,
          publishedFolded: folded,
          dspBpm: dsp ?? null,
          engines,
        });
        continue;
      }
      inRangeCount += 1;
      if (dsp != null && Math.abs(dsp - ref) <= 0.5) {
        withinHalf += 1;
      }
      const dspRow = rows.find((row) => row.analyzerName === "dnb-crate-dsp");
      const dspAccepted =
        dspRow != null &&
        !dspRow.gridRejected &&
        (dspRow.bpmConfidence ?? 0) >= MIN_ANALYSIS_CONFIDENCE &&
        dspRow.bpm != null;
      if (dspAccepted) {
        accepted += 1;
        if (Math.abs(dspRow.bpm! - ref) <= 0.5) {
          acceptedExact += 1;
        }
      }
      const values = Object.values(engines).filter((bpm): bpm is number => bpm != null);
      const spread = values.length >= 2 && Math.max(...values) - Math.min(...values) > 1;
      const off = dsp != null && Math.abs(dsp - ref) > 0.5;
      if (spread || off) {
        const row = {
          trackId: track.id,
          title: track.title,
          canonicalBpm: view.canonicalBpm,
          canonicalSource: view.canonicalBpmSource,
          engines,
        };
        disagreements.push(row);
        needsReview.push({
          ...row,
          reason: "disagreement",
          publishedFolded: folded,
          dspBpm: dsp ?? null,
        });
      }
    }
    return {
      trackCount: this.repository.listAll().length,
      engineCounts,
      inRange: { count: inRangeCount, withinHalf, accepted, acceptedExact },
      outOfRange: { count: outOfRangeCount },
      publishedOrManualCompared: inRangeCount + outOfRangeCount,
      dspWithinHalfBpm: withinHalf,
      gridSourceCounts,
      keyAgreementCounts,
      engines: engineRows.slice(0, 200),
      needsReview: needsReview.slice(0, 50),
      disagreements: disagreements.slice(0, 50),
    };
  }

  async createCuePreview(input: {
    trackId: string;
    cue?: "intro_start" | "drop" | "breakdown" | "outro_start";
    windowMs?: number;
  }): Promise<{ trackId: string; cue: "intro_start" | "drop" | "breakdown" | "outro_start"; positionMs: number; outputRelpath: string }> {
    const track = this.requireTrack(input.trackId);
    const analysis = this.getTrackAnalysis(track.id);
    const cueType = input.cue ?? "drop";
    const cue =
      analysis.suggestedCues.find((item) => item.type === cueType) ??
      analysis.sections.find((section) =>
        cueType === "intro_start"
          ? section.type === "intro"
          : cueType === "outro_start"
            ? section.type === "outro"
            : section.type === cueType,
      );
    const positionMs =
      cue && "positionMs" in cue
        ? cue.positionMs
        : cue && "startMs" in cue
          ? cue.startMs
          : Math.round(track.durationMs * 0.25);
    const windowMs = input.windowMs ?? 8000;
    const startMs = Math.max(0, positionMs - Math.round(windowMs / 4));
    const endMs = Math.min(track.durationMs, startMs + windowMs);
    const relPath = `previews/${track.id}-${cueType}.wav`;
    const rendered = await this.renders.renderCuePreview({
      filePath: track.filePath,
      startMs,
      endMs,
      relPath,
    });
    return { trackId: track.id, cue: cueType, positionMs, outputRelpath: rendered.outputRelpath };
  }

  listAnalysisResources(limit = RESOURCE_LIST_LIMIT): TrackAnalysisView[] {
    const out: TrackAnalysisView[] = [];
    for (const track of this.repository.listAll()) {
      const view = this.analyses.toView(track, this.analyses.findByTrackId(track.id));
      if (view) {
        out.push(view);
      }
      if (out.length >= limit) {
        break;
      }
    }
    return out;
  }

  planTransition(input: {
    outgoingTrackId: string;
    incomingTrackId: string;
    preferredType?: "phrase_mix" | "bass_swap" | "crossfade" | "any";
    barCount?: 8 | 16 | 32;
    targetBpm?: number;
    allowExcessiveTempo?: boolean;
    allowLowConfidence?: boolean;
    allowDropIn?: boolean;
  }): {
    outgoingTrackId: string;
    incomingTrackId: string;
    targetBpm: number | null;
    proposals: TransitionProposal[];
  } {
    return planTransition(
      this.bundle(input.outgoingTrackId),
      this.bundle(input.incomingTrackId),
      input,
    );
  }

  validateTransition(input: {
    outgoingTrackId: string;
    incomingTrackId: string;
    type: "crossfade" | "phrase_mix" | "bass_swap";
    barCount?: 8 | 16 | 32;
    durationMs?: number;
    targetBpm?: number;
    outgoingPlaybackRate?: number;
    incomingPlaybackRate?: number;
    allowExcessiveTempo?: boolean;
    allowLowConfidence?: boolean;
    maxTempoDeviation?: number;
  }): TransitionValidation {
    return validateTransition(
      this.bundle(input.outgoingTrackId),
      this.bundle(input.incomingTrackId),
      input,
    );
  }

  waitForAnalysisJob(analysisJobId: string, timeoutMs?: number) {
    return this.analysis.waitForJob(analysisJobId, timeoutMs);
  }

  startMetadataEnrichment(input: {
    scope?: EnrichmentScope;
    trackIds?: string[];
    dryRun?: boolean;
    limit?: number;
  }): { job: EnrichmentJob } {
    const trackIds = this.enrichment.selectTrackIds(input);
    return this.enrichment.start({ trackIds, dryRun: input.dryRun === true });
  }

  getEnrichmentStatus(enrichmentJobId?: string): { jobs: EnrichmentJob[] } {
    return this.enrichment.getStatus(enrichmentJobId);
  }

  getEnrichmentReport(): EnrichmentReport {
    return this.enrichment.getReport();
  }

  waitForEnrichmentJob(enrichmentJobId: string, timeoutMs?: number) {
    return this.enrichment.waitForJob(enrichmentJobId, timeoutMs);
  }

  getPlanningReadiness(trackId?: string): {
    tracks: PlanningReadiness[];
    readyCount: number;
    totalCount: number;
  } {
    const tracks = trackId ? [this.requireTrack(trackId)] : this.repository.listAll();
    const reports = tracks.map((track) => {
      const missing: string[] = [];
      const stored = this.analyses.findByTrackId(track.id);
      const hint = stored ? resolveBpmHint(stored) : { bpm: null, confidence: null };
      let bpmSource: PlanningReadiness["bpmSource"] = track.bpmSource;
      if (track.bpm === null) {
        if (hint.bpm != null) {
          bpmSource = "hint";
        } else {
          missing.push("bpm");
        }
      }
      if (track.camelotKey === null) missing.push("key");
      if (track.energy === null) missing.push("energy");
      if (track.fileMissing) missing.push("file");
      const cuePointTypes = this.repository.listCuePoints(track.id).map((cue) => cue.type);
      return {
        trackId: track.id,
        title: track.title,
        ready: missing.length === 0,
        missing,
        cuePointTypes,
        bpmSource,
      };
    });
    return {
      tracks: reports,
      readyCount: reports.filter((item) => item.ready).length,
      totalCount: reports.length,
    };
  }

  findCompatibleTracks(input: {
    sourceTrackId: string;
    direction?: "up" | "down" | "any";
    limit?: number;
    preferredMoods?: string[];
    preferredSubgenres?: string[];
    preferredTags?: string[];
    harmonicImportance?: number;
    subBassMin?: number;
    brightnessMin?: number;
    energyMin?: number;
    energyMax?: number;
    descriptors?: CreateSetPlanInput["descriptors"];
    genres?: CreateSetPlanInput["genres"];
  }): { sourceTrackId: string; candidates: CompatibleTrack[] } {
    const source = this.requireTrack(input.sourceTrackId);
    const limit = Math.min(input.limit ?? 10, COMPATIBLE_TRACKS_LIMIT_MAX);
    const scored = this.repository
      .listAll()
      .filter((track) => {
        if (track.id === source.id || track.fileMissing) {
          return false;
        }
        if (input.energyMin !== undefined) {
          const energy = track.energy ?? this.analyses.findByTrackId(track.id)?.descriptors?.suggestedEnergy;
          if (energy == null || energy < input.energyMin) {
            return false;
          }
        }
        if (input.energyMax !== undefined) {
          const energy = track.energy ?? this.analyses.findByTrackId(track.id)?.descriptors?.suggestedEnergy;
          if (energy == null || energy > input.energyMax) {
            return false;
          }
        }
        const desc = this.analyses.findByTrackId(track.id)?.descriptors ?? null;
        if (input.subBassMin !== undefined && (desc?.subBassRatio ?? -1) < input.subBassMin) {
          return false;
        }
        if (input.brightnessMin !== undefined && (desc?.brightness ?? -1) < input.brightnessMin) {
          return false;
        }
        const descriptorMatch = matchesDescriptorFilters(track, desc, input.descriptors);
        if (!descriptorMatch.ok) {
          return false;
        }
        const genreMatch = genresMatchFilter(track.genres, input.genres);
        if (!genreMatch.ok) {
          return false;
        }
        return true;
      })
      .map((track) => {
        const candA = this.analyses.findByTrackId(track.id);
        const srcA = this.analyses.findByTrackId(source.id);
        return {
        track,
        score: scoreCandidate({
          source,
          candidate: track,
          targetEnergy: null,
          direction: input.direction ?? "any",
          preferredMoods: input.preferredMoods ?? [],
          preferredSubgenres: input.preferredSubgenres ?? [],
          preferredTags: input.preferredTags ?? [],
          preferredArtists: [],
          recentArtistIds: [source.artist],
          artistRepeatSpacing: 1,
          harmonicImportance: input.harmonicImportance ?? 1,
          explorationWeight: 0,
          seed: 1,
          alreadyUsed: false,
          suggestedEnergy: candA?.descriptors?.suggestedEnergy ?? null,
          sourceSuggestedEnergy: srcA?.descriptors?.suggestedEnergy ?? null,
          outgoingOutroMs:
            srcA?.sections.find((s) => s.type === "outro")
              ? (srcA.sections.find((s) => s.type === "outro")!.endMs -
                srcA.sections.find((s) => s.type === "outro")!.startMs)
              : null,
          incomingIntroMs:
            candA?.sections.find((s) => s.type === "intro")
              ? (candA.sections.find((s) => s.type === "intro")!.endMs -
                candA.sections.find((s) => s.type === "intro")!.startMs)
              : null,
          bpmHint: candA ? resolveBpmHint(candA).bpm : null,
          sourceBpmHint: srcA ? resolveBpmHint(srcA).bpm : null,
          descriptors: candA?.descriptors ?? null,
          sourceDescriptors: srcA?.descriptors ?? null,
          candidateKeyConfidence: candA?.keyConfidence ?? null,
          sourceKeyConfidence: srcA?.keyConfidence ?? null,
          candidateGridOk: Boolean(candA && !candA.gridRejected),
          sourceGridOk: Boolean(srcA && !srcA.gridRejected),
          candidateLufs: candA?.integratedLufs ?? null,
          sourceLufs: srcA?.integratedLufs ?? null,
          candidateGenres: track.genres,
        }),
      };
      })
      .sort((a, b) => b.score.total - a.score.total || a.track.id.localeCompare(b.track.id))
      .slice(0, limit);
    return {
      sourceTrackId: source.id,
      candidates: scored.map((item) => ({
        track: {
          id: item.track.id,
          artist: item.track.artist,
          title: item.track.title,
          bpm: item.track.bpm,
          musicalKey: item.track.musicalKey,
          camelotKey: item.track.camelotKey,
          energy: item.track.energy,
          rating: item.track.rating,
        },
        score: item.score,
      })),
    };
  }

  createSetPlan(input: CreateSetPlanInput): CreateSetPlanResult {
    try {
      const analyses = new Map(
        this.repository
          .listAll()
          .map((track) => [track.id, this.toTimeline(track)] as const)
          .filter((entry): entry is readonly [string, NonNullable<ReturnType<typeof analysisToTimeline>>] => entry[1] != null),
      );
      const drafted = draftSetPlan(this.repository.listAll(), {
        ...input,
        descriptors: resolveDescriptorFilters(
          input.descriptors,
          this.getLibraryStats().descriptorPercentiles,
        ),
      }, analyses, { percentiles: this.getLibraryStats().descriptorPercentiles });
      const tracksById = new Map(this.repository.listAll().map((track) => [track.id, track]));
      const validation = validateSetPlan(drafted.plan, tracksById, {
        artistRepeatSpacing: input.artistRepeatSpacing,
        audioEndMsByTrackId: this.audioEndMsByTrackId(),
        effectiveEnergyByTrackId: this.effectiveEnergyByTrackId(),
      });
      const stored = this.setPlans.save(
        drafted.plan,
        drafted.explanation.seed,
        drafted.explanation,
      );
      return {
        plan: stored.plan,
        explanation: stored.explanation,
        validation,
        partial: drafted.partial,
      };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("TRACK_NOT_FOUND:")) {
        const parts = error.message.split(":");
        throw new DomainError(
          "TRACK_NOT_FOUND",
          `Required ${parts[2] ?? "track"} ${parts[1]} is not in the eligible catalog`,
        );
      }
      throw error;
    }
  }

  getSetPlan(setPlanId: string): SetPlanV1 {
    return this.requirePlan(setPlanId).plan;
  }

  cloneSetPlan(input: { setPlanId: string; name: string; replan?: boolean }): CreateSetPlanResult {
    const stored = this.requirePlan(input.setPlanId);
    const tracksById = new Map(this.repository.listAll().map((track) => [track.id, track]));
    const ordered = [...stored.plan.entries].sort((a, b) => a.order - b.order);
    const orderedTracks = ordered.map((entry) => {
      const track = tracksById.get(entry.trackId);
      if (!track) {
        throw new DomainError("TRACK_NOT_FOUND", `Track ${entry.trackId} is missing`);
      }
      return track;
    });
    const now = new Date().toISOString();
    const entries = input.replan
      ? buildEntries(
          this.timelineTracksFor(orderedTracks),
          undefined,
          new Map(
            ordered
              .filter((entry) => entry.gainDb !== 0)
              .map((entry) => [entry.trackId, { gainDb: entry.gainDb }]),
          ),
          { dropAnchored: true },
        )
      : ordered.map((entry) => ({
          ...entry,
          id: crypto.randomUUID(),
          transitionToNext: entry.transitionToNext
            ? { ...entry.transitionToNext, id: crypto.randomUUID() }
            : null,
        }));
    const plan: SetPlanV1 = {
      ...stored.plan,
      id: crypto.randomUUID(),
      name: input.name,
      entries,
      createdAt: now,
      updatedAt: now,
    };
    const validation = validateSetPlan(plan, tracksById, {
      audioEndMsByTrackId: this.audioEndMsByTrackId(),
      effectiveEnergyByTrackId: this.effectiveEnergyByTrackId(),
    });
    const saved = this.setPlans.save(plan, stored.seed, stored.explanation);
    return {
      plan: saved.plan,
      explanation: saved.explanation,
      validation,
      partial: false,
    };
  }

  async validateSavedSetPlan(setPlanId: string): Promise<ValidateSetPlanResult> {
    return this.renders.validatePlan(setPlanId);
  }

  startSetRender(input: {
    setPlanId: string;
    edgeFadeMs?: number;
    allowLowConfidence?: boolean;
    allowExcessiveTempo?: boolean;
  }) {
    return this.renders.startFullRender(input);
  }

  createTransitionPreview(input: {
    setPlanId: string;
    transitionId: string;
    windowMs?: number;
    template?: "crossfade" | "phrase_mix" | "bass_swap";
    barCount?: 8 | 16 | 32;
    allowLowConfidence?: boolean;
  }) {
    return this.renders.startPreview(input);
  }

  getRenderStatus(renderJobId: string): RenderJob {
    return this.renders.getStatus(renderJobId);
  }

  getRenderManifest(renderJobId: string): RenderManifestV1 {
    return this.renders.getManifest(renderJobId);
  }

  checkRender(renderJobId: string) {
    return this.renders.checkRender(renderJobId);
  }

  listRenderJobs(limit?: number, cursor?: string, setPlanId?: string) {
    return this.renders.list(limit, cursor, setPlanId);
  }

  cancelRenderJob(renderJobId: string, confirm: true) {
    return this.renders.cancel(renderJobId, confirm);
  }

  waitForRenderJob(renderJobId: string, timeoutMs?: number) {
    return this.renders.waitForJob(renderJobId, timeoutMs);
  }

  listRenderResources(limit = RESOURCE_LIST_LIMIT): RenderJob[] {
    return this.renders.list(limit).jobs.filter((job) => job.status === "succeeded");
  }

  listSetPlans(
    limit?: number,
    cursor?: string,
  ): { plans: SetPlanSummary[]; nextCursor: string | null } {
    return this.setPlans.list(limit, cursor);
  }

  deleteSetPlan(setPlanId: string, confirm: true): { deleted: boolean; setPlanId: string } {
    if (confirm !== true) {
      throw new DomainError("INVALID_SET_PLAN", "delete_set_plan requires confirm=true");
    }
    this.requirePlan(setPlanId);
    const deleted = this.setPlans.delete(setPlanId);
    return { deleted, setPlanId };
  }

  updateSetPlan(input: {
    setPlanId: string;
    name?: string;
    replaceTrack?: { entryId: string; trackId: string };
    setTrim?: { entryId: string; sourceStartMs: number; sourceEndMs: number };
    setTransition?: {
      entryId: string;
      type: "crossfade" | "phrase_mix" | "bass_swap" | "double_drop";
      durationMs: number;
      outgoingCuePointId?: string | null;
      incomingCuePointId?: string | null;
      parameters?: Record<string, number | string | boolean>;
    };
    setPlaybackRate?: { entryId: string; playbackRate: number };
    applyTransition?: {
      entryId: string;
      type: "crossfade" | "phrase_mix" | "bass_swap";
      durationMs: number;
      outgoingCuePointId?: string | null;
      incomingCuePointId?: string | null;
      outgoingPlaybackRate: number;
      incomingPlaybackRate: number;
      outgoingSourceStartMs: number;
      outgoingSourceEndMs: number;
      incomingSourceStartMs: number;
      incomingSourceEndMs: number;
      parameters?: Record<string, number | string | boolean>;
    };
    moveEntry?: { entryId: string; toOrder: number };
  }): CreateSetPlanResult {
    const stored = this.requirePlan(input.setPlanId);
    const entries = [...stored.plan.entries].sort((a, b) => a.order - b.order);
    if (input.replaceTrack) {
      const entry = entries.find((item) => item.id === input.replaceTrack!.entryId);
      if (!entry) {
        throw new DomainError("INVALID_SET_PLAN", `No entry ${input.replaceTrack.entryId}`);
      }
      const track = this.requireTrack(input.replaceTrack.trackId);
      entry.trackId = track.id;
      entry.sourceStartMs = 0;
      entry.sourceEndMs = track.durationMs;
    }
    if (input.setTrim) {
      const entry = entries.find((item) => item.id === input.setTrim!.entryId);
      if (!entry) {
        throw new DomainError("INVALID_SET_PLAN", `No entry ${input.setTrim.entryId}`);
      }
      entry.sourceStartMs = input.setTrim.sourceStartMs;
      entry.sourceEndMs = input.setTrim.sourceEndMs;
    }
    if (input.setTransition) {
      const entry = entries.find((item) => item.id === input.setTransition!.entryId);
      if (!entry) {
        throw new DomainError("INVALID_SET_PLAN", `No entry ${input.setTransition.entryId}`);
      }
      if (entry.transitionToNext === null) {
        throw new DomainError("INVALID_SET_PLAN", "The last entry has no transition to next");
      }
      entry.transitionToNext = {
        ...entry.transitionToNext,
        type: input.setTransition.type,
        durationMs: input.setTransition.durationMs,
        outgoingCuePointId:
          input.setTransition.outgoingCuePointId !== undefined
            ? input.setTransition.outgoingCuePointId
            : entry.transitionToNext.outgoingCuePointId,
        incomingCuePointId:
          input.setTransition.incomingCuePointId !== undefined
            ? input.setTransition.incomingCuePointId
            : entry.transitionToNext.incomingCuePointId,
        parameters: input.setTransition.parameters ?? entry.transitionToNext.parameters,
      };
    }
    if (input.setPlaybackRate) {
      const entry = entries.find((item) => item.id === input.setPlaybackRate!.entryId);
      if (!entry) {
        throw new DomainError("INVALID_SET_PLAN", `No entry ${input.setPlaybackRate.entryId}`);
      }
      assertPlaybackRate(input.setPlaybackRate.playbackRate, { allowExcessive: true });
      entry.playbackRate = input.setPlaybackRate.playbackRate;
    }
    if (input.applyTransition) {
      const index = entries.findIndex((item) => item.id === input.applyTransition!.entryId);
      if (index < 0 || index >= entries.length - 1) {
        throw new DomainError(
          "INVALID_SET_PLAN",
          `No transition from entry ${input.applyTransition.entryId}`,
        );
      }
      const outgoing = entries[index]!;
      const incoming = entries[index + 1]!;
      if (outgoing.transitionToNext === null) {
        throw new DomainError("INVALID_SET_PLAN", "The last entry has no transition to next");
      }
      assertPlaybackRate(input.applyTransition.outgoingPlaybackRate, { allowExcessive: true });
      assertPlaybackRate(input.applyTransition.incomingPlaybackRate, { allowExcessive: true });
      outgoing.sourceStartMs = Math.min(
        outgoing.sourceStartMs,
        input.applyTransition.outgoingSourceStartMs,
      );
      outgoing.sourceEndMs = input.applyTransition.outgoingSourceEndMs;
      outgoing.playbackRate = input.applyTransition.outgoingPlaybackRate;
      incoming.sourceStartMs = input.applyTransition.incomingSourceStartMs;
      if (incoming.transitionToNext === null) {
        incoming.sourceEndMs = input.applyTransition.incomingSourceEndMs;
      }
      incoming.playbackRate = input.applyTransition.incomingPlaybackRate;
      outgoing.transitionToNext = {
        ...outgoing.transitionToNext,
        type: input.applyTransition.type,
        durationMs: input.applyTransition.durationMs,
        outgoingCuePointId:
          input.applyTransition.outgoingCuePointId !== undefined
            ? input.applyTransition.outgoingCuePointId
            : outgoing.transitionToNext.outgoingCuePointId,
        incomingCuePointId:
          input.applyTransition.incomingCuePointId !== undefined
            ? input.applyTransition.incomingCuePointId
            : outgoing.transitionToNext.incomingCuePointId,
        parameters: input.applyTransition.parameters ?? outgoing.transitionToNext.parameters,
      };
    }
    if (input.moveEntry) {
      const from = entries.findIndex((item) => item.id === input.moveEntry!.entryId);
      if (from < 0) {
        throw new DomainError("INVALID_SET_PLAN", `No entry ${input.moveEntry.entryId}`);
      }
      const [moved] = entries.splice(from, 1);
      const to = Math.min(input.moveEntry.toOrder, entries.length);
      entries.splice(to, 0, moved!);
    }
    const tracksById = new Map(this.repository.listAll().map((track) => [track.id, track]));
    const orderedTracks = entries.map((entry) => {
      const track = tracksById.get(entry.trackId);
      if (!track) {
        throw new DomainError("TRACK_NOT_FOUND", `Track ${entry.trackId} is missing`);
      }
      return track;
    });
    const rebuilt = buildEntries(
      orderedTracks.map((track) => ({ ...track, analysis: this.toTimeline(track) })),
      undefined,
      new Map(entries.map((entry) => [entry.trackId, entry])),
    );
    const plan: SetPlanV1 = {
      ...stored.plan,
      name: input.name ?? stored.plan.name,
      entries: rebuilt,
      updatedAt: new Date().toISOString(),
    };
    const validation = validateSetPlan(plan, tracksById, {
      audioEndMsByTrackId: this.audioEndMsByTrackId(),
      effectiveEnergyByTrackId: this.effectiveEnergyByTrackId(),
    });
    if (!validation.valid) {
      throw new DomainError(
        "INVALID_SET_PLAN",
        validation.errors.map((issue) => issue.message).join("; "),
        {
          details: { errors: validation.errors },
        },
      );
    }
    const saved = this.setPlans.save(plan, stored.seed, stored.explanation);
    return {
      plan: saved.plan,
      explanation: saved.explanation,
      validation,
      partial: false,
    };
  }

  private bundle(trackId: string) {
    const track = this.requireTrack(trackId);
    return {
      track,
      analysis: this.analyses.findByTrackId(trackId),
      cues: this.repository.listCuePoints(trackId),
    };
  }

  private timelineTracksFor(tracks: Track[]) {
    return tracks.map((track) => ({ ...track, analysis: this.toTimeline(track) }));
  }

  private toTimeline(track: Track) {
    const row = this.analyses.findByTrackId(track.id);
    const canon = resolveCanonicalBpm(track, row);
    return analysisToTimeline(
      row,
      canon.bpm,
      this.repository.listCuePoints(track.id),
      track.durationMs,
    );
  }

  private audioEndMsByTrackId(): Map<string, number> {
    const map = new Map<string, number>();
    for (const track of this.repository.listAll()) {
      const end = this.analyses.findByTrackId(track.id)?.descriptors?.audioEndMs;
      if (typeof end === "number") {
        map.set(track.id, end);
      }
    }
    return map;
  }

  private requireTrack(trackId: string) {
    const track = this.repository.findById(trackId);
    if (!track) {
      throw new DomainError("TRACK_NOT_FOUND", `No track with id ${trackId}`);
    }
    return track;
  }

  private requirePlan(setPlanId: string) {
    const stored = this.setPlans.findById(setPlanId);
    if (!stored) {
      throw new DomainError("SET_PLAN_NOT_FOUND", `No set plan with id ${setPlanId}`);
    }
    return stored;
  }

  private effectiveEnergyByTrackId(): Map<string, number> {
    const out = new Map<string, number>();
    for (const track of this.repository.listAll()) {
      const energy = effectiveEnergy(track, this.analyses.findByTrackId(track.id)?.descriptors ?? null);
      if (energy != null) {
        out.set(track.id, energy);
      }
    }
    return out;
  }

  getLibraryStats(): LibraryStats {
    return this.repository.stats();
  }

  listTrackResources(limit = RESOURCE_LIST_LIMIT): PublicTrack[] {
    return this.repository.listForResource(limit);
  }

  async ensureOutputRoot(): Promise<void> {
    await mkdir(this.config.outputRoot, { recursive: true });
  }
}
