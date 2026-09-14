import type { ApprovedRecipeRecord } from "@dnb-crate/domain";
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
  PlanQualityReport,
  RateTransitionInput,
  TransitionFeedback,
  TransitionPreference,
} from "@dnb-crate/domain";
import {
  APP_NAME,
  recordHourFeedbackSchema,
  APP_VERSION,
  COMPATIBLE_TRACKS_LIMIT_MAX,
  DomainError,
  MIN_ANALYSIS_CONFIDENCE,
  RESOURCE_LIST_LIMIT,
  assertPlaybackRate,
  DNB_BPM_MAX,
  DNB_BPM_MIN,
  keyAgreement,
  normalizeDnbBpm,
  resolveBpmHint,
  recipeFingerprint,
  renderJoinFingerprint,
  renderSequenceFingerprint,
  resolveCanonicalBpm,
  resolveCanonicalKeyConfidence,
  scoreCandidate,
  effectiveEnergy,
  genresMatchFilter,
  matchesDescriptorFilters,
  resolveDescriptorFilters,
  toPublicTrack,
} from "@dnb-crate/domain";
import { ffmpegMixReady, sha256Json } from "@dnb-crate/audio-renderer";
import type { HourFeedbackRepository } from "./hour-feedback-repository.ts";

import { draftSetPlan } from "./planning/planner.ts";
import { PlanningConstraintError } from "./planning/constraints.ts";
import { reportSetPlanQuality, type TrackQualityEvidence } from "./planning/quality.ts";
import { analysisToTimeline, buildEntries } from "./planning/timeline.ts";
import { validateSetPlan } from "./planning/validate.ts";
import type { TrackRepository } from "./repository.ts";
import { resolveLibraryRoots } from "./scanner.ts";
import { scanLibrary } from "./library-scan.ts";
import type { SetPlanRepository } from "./set-plan-repository.ts";
import type { RenderCoordinator } from "./render/coordinator.ts";
import type { AnalysisCoordinator } from "./analysis/coordinator.ts";
import type { AnalysisRepository } from "./analysis-repository.ts";
import type { EnrichmentCoordinator } from "./enrichment/coordinator.ts";
import { planTransition, validateTransition } from "./planning/transition-planner.ts";
import type { FeedbackRepository } from "./feedback-repository.ts";
import type { ApprovedRecipeRepository } from "./approved-recipe-repository.ts";
import type { TrackEvidenceSelection } from "./analysis-repository.ts";
import {
  analysisForTimeline,
  assertEvidenceEnginesExist,
  isFrozenSnapshot,
  resolveTrackEvidence,
} from "./evidence.ts";
import type { FrozenRenderRequest } from "./render-job-repository.ts";

import type { MixWorkflowCoordinator } from "./mix-workflow.ts";

export class CatalogService {
  workflows!: MixWorkflowCoordinator;
  constructor(
    private readonly config: AppConfig,
    private readonly repository: TrackRepository,
    private readonly setPlans: SetPlanRepository,
    private readonly renders: RenderCoordinator,
    private readonly analysis: AnalysisCoordinator,
    private readonly analyses: AnalysisRepository,
    private readonly enrichment: EnrichmentCoordinator,
    private readonly feedback: FeedbackRepository,
    private readonly recipes: ApprovedRecipeRepository,
    private readonly logger: Logger,
    private readonly hourFeedback: HourFeedbackRepository,
  ) {}

  recordHourFeedback(input: {
    renderJobId: string;
    outputChecksum: string;
    accepted: boolean;
    quote: string;
  }) {
    const parsed = recordHourFeedbackSchema.parse(input);
    const manifest = this.renders.getManifest(parsed.renderJobId);
    if (
      manifest.kind !== "full" ||
      manifest.outputChecksumSha256.toLowerCase() !== parsed.outputChecksum.toLowerCase()
    ) {
      throw new DomainError(
        "INVALID_SET_PLAN",
        "Hour feedback must reference the full render's actual checksum",
      );
    }
    return this.hourFeedback.record(manifest, parsed.accepted, parsed.quote);
  }

  listHourFeedback(renderJobId?: string) {
    return this.hourFeedback.list(renderJobId);
  }

  async getServerStatus(): Promise<ServerStatus> {
    const { resolved } = await resolveLibraryRoots(this.config.libraryRoots);
    let outputRootConfigured = false;
    try {
      await access(this.config.outputRoot, constants.F_OK);
      outputRootConfigured = true;
    } catch {
      outputRootConfigured = this.config.outputRoot.length > 0;
    }

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
      enrichment: {
        enabled: this.config.enrichment?.enabled === true,
        musicbrainz: this.config.enrichment?.musicbrainz?.enabled !== false,
        deezer: this.config.enrichment?.deezer?.enabled !== false,
        acoustidConfigured: Boolean(this.config.enrichment?.acoustid?.apiKey),
      },
    };
  }

  scanLibrary(options: { dryRun?: boolean } = {}): Promise<{
    result: ScanLibraryResult;
    warnings: string[];
  }> {
    return scanLibrary(this.config, this.repository, this.logger, options);
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
    const track = this.requireTrack(trackId);
    for (const cue of cuePoints) {
      if (cue.positionMs > track.durationMs) {
        throw new DomainError(
          "INVALID_METADATA",
          `Cue ${cue.type} at ${cue.positionMs}ms is past track duration ${track.durationMs}ms`,
        );
      }
    }
    if (beatAnchorMs !== undefined && beatAnchorMs > track.durationMs) {
      throw new DomainError("INVALID_BEAT_GRID", "Beat anchor is past the track duration");
    }
    return this.repository.withTransaction(() => {
      const result = { trackId, cuePoints: this.repository.replaceCuePoints(trackId, cuePoints) };
      if (beatAnchorMs !== undefined) {
        this.analysis.setBeatAnchor(trackId, beatAnchorMs);
      }
      return result;
    });
  }

  startTrackAnalysis(input: {
    trackIds?: string[];
    planningReadyOnly?: boolean;
    scope?: "ids" | "planningReady" | "unanalyzed" | "stale" | "all";
    engines?: AnalysisEngineId[];
  }): {
    job: AnalysisJob;
  } {
    const scope = input.scope ?? (input.planningReadyOnly === true ? "planningReady" : "ids");
    const ids = new Set<string>();
    for (const id of input.trackIds ?? []) {
      ids.add(id);
    }
    if (scope === "unanalyzed" || scope === "stale" || scope === "all") {
      for (const id of this.analyses.listIdsForScope(scope)) {
        ids.add(id);
      }
    }
    if (scope === "stale" && this.config.analysis?.keyAnalysis !== "off") {
      for (const track of this.repository.listAll()) {
        if (this.needsKeyBackfill(track)) ids.add(track.id);
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
    return this.analysis.start([...ids]);
  }

  private needsKeyBackfill(track: Track): boolean {
    if (track.fileMissing || track.keySource === "manual" || track.keySource === "published") {
      return false;
    }
    const stage = this.analyses.getStage(track.id, "key");
    return stage?.state !== "succeeded" || stage.fingerprint !== track.fileFingerprint;
  }

  getAnalysisStatus(analysisJobId?: string): { jobs: AnalysisJob[] } {
    return this.analysis.getStatus(analysisJobId);
  }

  getTrackAnalysis(trackId: string, engine?: string): TrackAnalysisView {
    const track = this.requireTrack(trackId);
    const stored = engine
      ? this.analyses.findByTrackId(trackId, engine)
      : analysisForTimeline(resolveTrackEvidence(this.analyses, trackId));
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

  toToolAnalysis(
    view: TrackAnalysisView,
  ): Omit<TrackAnalysisView, "beatTimesMs" | "downbeatTimesMs"> {
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

  getTrackSections(
    trackId: string,
    engine?: string,
  ): {
    trackId: string;
    analyzerName: string;
    sections: TrackAnalysisView["sections"];
  } {
    if (engine) {
      const analysis = this.getTrackAnalysis(trackId, engine);
      return {
        trackId,
        analyzerName: analysis.analyzerName,
        sections: analysis.sections,
      };
    }
    const evidence = resolveTrackEvidence(this.analyses, trackId);
    const analysis = this.getTrackAnalysis(trackId);
    return {
      trackId,
      analyzerName: evidence.structure?.analyzerName ?? analysis.analyzerName,
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
  }): Promise<{
    trackId: string;
    cue: "intro_start" | "drop" | "breakdown" | "outro_start";
    positionMs: number;
    outputRelpath: string;
  }> {
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
    const analysisOf = (trackId: string) =>
      analysisForTimeline(resolveTrackEvidence(this.analyses, trackId));
    const srcA = analysisOf(source.id);
    const sectionMs = (
      analysis: ReturnType<typeof analysisOf>,
      type: "intro" | "outro",
    ): number | null => {
      const section = analysis?.sections.find((row) => row.type === type);
      return section ? section.endMs - section.startMs : null;
    };
    const scored = this.repository
      .listAll()
      .filter((track) => {
        if (track.id === source.id || track.fileMissing) {
          return false;
        }
        const desc = analysisOf(track.id)?.descriptors ?? null;
        if (input.energyMin !== undefined) {
          const energy = track.energy ?? desc?.suggestedEnergy;
          if (energy == null || energy < input.energyMin) {
            return false;
          }
        }
        if (input.energyMax !== undefined) {
          const energy = track.energy ?? desc?.suggestedEnergy;
          if (energy == null || energy > input.energyMax) {
            return false;
          }
        }
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
        const candA = analysisOf(track.id);
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
            outgoingOutroMs: sectionMs(srcA, "outro"),
            incomingIntroMs: sectionMs(candA, "intro"),
            bpmHint: candA ? resolveBpmHint(candA).bpm : null,
            sourceBpmHint: srcA ? resolveBpmHint(srcA).bpm : null,
            descriptors: candA?.descriptors ?? null,
            sourceDescriptors: srcA?.descriptors ?? null,
            candidateKeyConfidence: resolveCanonicalKeyConfidence(track, candA),
            sourceKeyConfidence: resolveCanonicalKeyConfidence(source, srcA),
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

  createSetPlan(
    input: CreateSetPlanInput,
    candidateTrackIds?: ReadonlySet<string>,
  ): CreateSetPlanResult {
    try {
      const referencePlans = (input.variety?.referencePlanIds ?? []).map(
        (id) => this.requirePlan(id).plan,
      );
      const varietyHistory = {
        trackIds: [
          ...new Set(referencePlans.flatMap((plan) => plan.entries.map((entry) => entry.trackId))),
        ],
        pairs: referencePlans.flatMap((plan) =>
          plan.entries.slice(1).map((entry, i) => ({
            outgoingTrackId: plan.entries[i]!.trackId,
            incomingTrackId: entry.trackId,
          })),
        ),
      };
      const analyses = new Map(
        this.repository
          .listAll()
          .map((track) => [track.id, this.toTimeline(track)] as const)
          .filter(
            (
              entry,
            ): entry is readonly [string, NonNullable<ReturnType<typeof analysisToTimeline>>] =>
              entry[1] != null,
          ),
      );
      const drafted = draftSetPlan(
        this.repository
          .listAll()
          .filter((track) => !candidateTrackIds || candidateTrackIds.has(track.id)),
        {
          ...input,
          descriptors: resolveDescriptorFilters(
            input.descriptors,
            this.getLibraryStats().descriptorPercentiles,
          ),
        },
        analyses,
        {
          percentiles: this.getLibraryStats().descriptorPercentiles,
          feedback: this.feedback.index(),
          recipes: this.recipes,
          varietyHistory,
        },
      );
      const tracksById = new Map(this.repository.listAll().map((track) => [track.id, track]));
      const validation = validateSetPlan(drafted.plan, tracksById, {
        artistRepeatSpacing: input.artistRepeatSpacing,
        audioEndMsByTrackId: this.audioEndMsByTrackId(),
        effectiveEnergyByTrackId: this.effectiveEnergyByTrackId(),
        keyConfidenceByTrackId: this.keyConfidenceByTrackId(),
        firstDropStartMsByTrackId: this.firstDropStartMsByTrackId(),
      });
      const stored = this.setPlans.save(
        drafted.plan,
        drafted.explanation.seed,
        drafted.explanation,
      );
      const quality = this.qualityFor(stored.plan, {
        validation,
        partial: drafted.partial,
        partialReasons: drafted.partialReasons,
      });
      return {
        plan: stored.plan,
        explanation: stored.explanation,
        validation: { ...validation, quality },
        partial: quality.partial,
        quality,
      };
    } catch (error) {
      if (
        error instanceof PlanningConstraintError ||
        (error instanceof Error && error.message.startsWith("CONSTRAINT_INVALID:"))
      ) {
        throw new DomainError(
          "INVALID_SET_PLAN",
          error.message.replace(/^CONSTRAINT_INVALID:/, ""),
        );
      }
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
          {
            dropAnchored: true,
            targetBpm: stored.plan.targetBpm,
            recall: this.recipeLookupFor(stored.plan),
          },
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
      keyConfidenceByTrackId: this.keyConfidenceByTrackId(),
      firstDropStartMsByTrackId: this.firstDropStartMsByTrackId(),
    });
    const saved = this.setPlans.save(plan, stored.seed, stored.explanation);
    const quality = this.qualityFor(saved.plan, { validation, partial: false });
    return {
      plan: saved.plan,
      explanation: saved.explanation,
      validation: { ...validation, quality },
      partial: quality.partial,
      quality,
    };
  }

  async validateSavedSetPlan(setPlanId: string): Promise<ValidateSetPlanResult> {
    const validation = await this.renders.validatePlan(setPlanId);
    const plan = this.requirePlan(setPlanId).plan;
    const quality = this.qualityFor(plan, { validation });
    return { ...validation, quality };
  }

  reportSetPlanQuality(setPlanId: string): PlanQualityReport {
    const stored = this.requirePlan(setPlanId);
    const tracksById = new Map(this.repository.listAll().map((track) => [track.id, track]));
    const validation = validateSetPlan(stored.plan, tracksById, {
      artistRepeatSpacing: stored.plan.planningConstraints?.artistRepeatSpacing,
      audioEndMsByTrackId: this.audioEndMsByTrackId(),
      effectiveEnergyByTrackId: this.effectiveEnergyByTrackId(),
      keyConfidenceByTrackId: this.keyConfidenceByTrackId(),
      firstDropStartMsByTrackId: this.firstDropStartMsByTrackId(),
    });
    return this.qualityFor(stored.plan, { validation });
  }

  refreshRenderDependencies(): void {
    this.renders.resetDependencyCache();
  }

  startSetRender(input: {
    setPlanId: string;
    workflowJobId?: string;
    shouldEnqueue?: () => boolean;
    edgeFadeMs?: number;
    allowLowConfidence?: boolean;
    allowExcessiveTempo?: boolean;
    allowOverlongDuration?: boolean;
  }) {
    this.assertPlanReadyForRender(input.setPlanId, {
      allowOverlongDuration: input.allowOverlongDuration,
    });
    return this.renders.startFullRender(input);
  }

  assertPlanReadyForRender(
    planOrId: string | SetPlanV1,
    options: {
      allowOverlongDuration?: boolean;
      evidence?: FrozenRenderRequest["evidence"];
    } = {},
  ): void {
    const plan = typeof planOrId === "string" ? this.requirePlan(planOrId).plan : planOrId;
    const quality = this.qualityForPlan(plan, options.evidence);
    const invalidApplication = plan.entries.some(
      (entry, index) =>
        entry.transitionToNext?.parameters.appliedRecipeId != null &&
        quality.joins[index]?.recipeStatus !== "applied",
    );
    const durationOnly =
      quality.partialReasons.length > 0 &&
      quality.partialReasons.every(
        (reason) => reason === "DURATION" || reason === "AUDITION_DURATION",
      );
    const allowOverlong =
      options.allowOverlongDuration === true &&
      quality.qualityChecksPassed &&
      quality.structurallyValid &&
      durationOnly;
    if (
      quality.partialReasons.includes("REQUIRED_TRANSITION_UNSATISFIED") ||
      quality.partialReasons.includes("CONSTRAINT_UNSATISFIED") ||
      invalidApplication ||
      (quality.qualityPolicy === "strict" && !quality.readyForAudition && !allowOverlong)
    ) {
      throw new DomainError(
        "INVALID_SET_PLAN",
        "Plan is not ready: resolve quality, duration and required-transition blockers before rendering",
      );
    }
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

  checkRender(renderJobId: string, abortSignal?: AbortSignal) {
    return this.renders.checkRender(renderJobId, abortSignal);
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
      const index = entries.indexOf(entry);
      if (index > 0) {
        entries[index - 1] = { ...entries[index - 1]!, transitionToNext: null };
      }
      if (index + 1 < entries.length) {
        const next = { ...entries[index + 1]! };
        delete (next as { sourceStartMs?: number }).sourceStartMs;
        entries[index + 1] = next;
      }
      entries[index] = {
        id: entry.id,
        trackId: track.id,
        order: entry.order,
        timelineStartMs: entry.timelineStartMs,
        playbackRate: 1,
        gainDb: entry.gainDb,
        transitionToNext: null,
      } as (typeof entries)[number];
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
      { targetBpm: stored.plan.targetBpm, recall: this.recipeLookupFor(stored.plan) },
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
      keyConfidenceByTrackId: this.keyConfidenceByTrackId(),
      firstDropStartMsByTrackId: this.firstDropStartMsByTrackId(),
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
    const quality = this.qualityFor(saved.plan, { validation, partial: false });
    return {
      plan: saved.plan,
      explanation: saved.explanation,
      validation: { ...validation, quality },
      partial: quality.partial,
      quality,
    };
  }

  private bundle(trackId: string) {
    const track = this.requireTrack(trackId);
    return {
      track,
      analysis: analysisForTimeline(resolveTrackEvidence(this.analyses, trackId)),
      cues: this.repository.listCuePoints(trackId),
    };
  }

  private timelineTracksFor(tracks: Track[]) {
    return tracks.map((track) => ({ ...track, analysis: this.toTimeline(track) }));
  }

  private toTimeline(track: Track) {
    const evidence = resolveTrackEvidence(this.analyses, track.id);
    const row = analysisForTimeline(evidence);
    const canon = resolveCanonicalBpm(track, evidence.rhythm ?? row);
    const timeline = analysisToTimeline(
      row,
      canon.bpm,
      this.repository.listCuePoints(track.id),
      track.durationMs,
    );
    if (timeline) {
      timeline.keyConfidence = resolveCanonicalKeyConfidence(track, evidence.key ?? row);
    }
    return timeline;
  }

  selectTrackEvidence(input: {
    trackId: string;
    rhythmEngine?: string | null;
    structureEngine?: string | null;
    keyEngine?: string | null;
    reason?: string;
  }): TrackEvidenceSelection {
    this.requireTrack(input.trackId);
    assertEvidenceEnginesExist(this.analyses, input.trackId, input);
    return this.analyses.setSelection(input.trackId, input);
  }

  getTrackEvidence(trackId: string): TrackEvidenceSelection | null {
    this.requireTrack(trackId);
    return this.analyses.getSelection(trackId);
  }

  rateTransition(input: RateTransitionInput): TransitionFeedback {
    if (input.renderJobId) {
      const manifest = this.renders.getManifest(input.renderJobId);
      if (!input.transitionId) {
        const fingerprint = renderSequenceFingerprint(manifest);
        if (input.recipeFingerprint && input.recipeFingerprint !== fingerprint) {
          throw new Error("Rating fields disagree with the stored render");
        }
        input = {
          ...input,
          setPlanId: manifest.setPlanId,
          rendererVersion: manifest.rendererVersion,
          recipeFingerprint: fingerprint,
        };
      } else {
        const index = manifest.tracks.findIndex(
          (track) => track.transitionId === input.transitionId,
        );
        const outgoing = manifest.tracks[index];
        const incoming = manifest.tracks[index + 1];
        if (index < 0 || !outgoing || !incoming)
          throw new Error("Transition not found in the heard render");
        const fingerprint = renderJoinFingerprint(manifest, input.transitionId);
        if (
          (input.outgoingTrackId && input.outgoingTrackId !== outgoing.trackId) ||
          (input.incomingTrackId && input.incomingTrackId !== incoming.trackId) ||
          (input.recipeFingerprint && input.recipeFingerprint !== fingerprint)
        ) {
          throw new Error("Rating fields disagree with the stored render join");
        }
        input = {
          ...input,
          outgoingTrackId: outgoing.trackId,
          incomingTrackId: incoming.trackId,
          setPlanId: manifest.setPlanId,
          rendererVersion: manifest.rendererVersion,
          recipeFingerprint: fingerprint,
        };
      }
    }
    const fingerprint =
      input.recipeFingerprint ??
      recipeFingerprint({
        type: input.type ?? "phrase_mix",
        barCount: input.barCount,
        intent: input.intent,
        phraseShape: input.phraseShape,
        outgoingRate: input.outgoingRate,
        incomingRate: input.incomingRate,
        mixInMs: input.mixInMs,
        mixOutMs: input.mixOutMs,
        recipeVersion: input.recipeVersion,
        outgoingTrackId: input.outgoingTrackId,
        incomingTrackId: input.incomingTrackId,
      });
    return this.feedback.insert({
      recipeFingerprint: fingerprint,
      outgoingTrackId: input.outgoingTrackId ?? null,
      incomingTrackId: input.incomingTrackId ?? null,
      setPlanId: input.setPlanId ?? null,
      renderJobId: input.renderJobId ?? null,
      transitionId: input.transitionId ?? null,
      rendererVersion: input.rendererVersion ?? null,
      overall: input.overall ?? "not_assessed",
      timing: input.timing ?? "not_assessed",
      phrasing: input.phrasing ?? "not_assessed",
      bassClarity: input.bassClarity ?? "not_assessed",
      harmonicFit: input.harmonicFit ?? "not_assessed",
      energyContinuity: input.energyContinuity ?? "not_assessed",
      vocalClash: input.vocalClash ?? "not_assessed",
      note: input.note ?? null,
    });
  }

  listTransitionFeedback(input: {
    recipeFingerprint?: string;
    outgoingTrackId?: string;
    incomingTrackId?: string;
    limit?: number;
  }): { ratings: TransitionFeedback[] } {
    return { ratings: this.feedback.list(input) };
  }

  getTransitionPreferences(input: {
    recipeFingerprint?: string;
    outgoingTrackId?: string;
    incomingTrackId?: string;
  }): { preferences: TransitionPreference[] } {
    return { preferences: this.feedback.summarize(input) };
  }

  importApprovedRecipe(row: Omit<ApprovedRecipeRecord, "id" | "createdAt"> & { id?: string }): {
    inserted: boolean;
    recipe: ApprovedRecipeRecord;
  } {
    const existing = this.recipes.findDuplicate({
      reusableFingerprint: row.reusableFingerprint,
      status: row.status,
      note: row.note,
    });
    if (existing) {
      return { inserted: false, recipe: existing };
    }
    return { inserted: true, recipe: this.recipes.insert(row) };
  }

  listApprovedRecipes(outgoingTrackId?: string, incomingTrackId?: string) {
    if (outgoingTrackId && incomingTrackId) {
      return this.recipes.listForPair(outgoingTrackId, incomingTrackId);
    }
    return this.recipes.listAll();
  }

  private recipeLookupFor(plan: SetPlanV1) {
    return {
      listForPair: (outgoingTrackId: string, incomingTrackId: string) =>
        this.recipes.listForPair(outgoingTrackId, incomingTrackId),
      recipeIdForPair: (outgoingTrackId: string, incomingTrackId: string) =>
        plan.planningConstraints?.requiredTransitions?.find(
          (row) =>
            row.outgoingTrackId === outgoingTrackId &&
            row.incomingTrackId === incomingTrackId &&
            row.reuse === "recipe",
        )?.recipeId,
      reuseForPair: (outgoingTrackId: string, incomingTrackId: string) =>
        plan.planningConstraints?.requiredTransitions?.find(
          (row) =>
            row.outgoingTrackId === outgoingTrackId && row.incomingTrackId === incomingTrackId,
        )?.reuse,
    };
  }

  private keyConfidenceByTrackId(): Map<string, number> {
    const out = new Map<string, number>();
    for (const track of this.repository.listAll()) {
      const keyRow = this.analyses.findKeyAnalysis(track.id);
      out.set(track.id, resolveCanonicalKeyConfidence(track, keyRow));
    }
    return out;
  }

  private qualityEvidenceByTrackId(): Map<string, TrackQualityEvidence> {
    const out = new Map<string, TrackQualityEvidence>();
    for (const track of this.repository.listAll()) {
      const rhythm = this.analyses.findByTrackId(track.id);
      const keyRow = this.analyses.findKeyAnalysis(track.id) ?? rhythm;
      const timeline = this.toTimeline(track);
      out.set(track.id, {
        musicalKey:
          track.keySource === "manual" || track.keySource === "published"
            ? track.musicalKey
            : (keyRow?.musicalKey ?? track.musicalKey),
        camelotKey:
          track.keySource === "manual" || track.keySource === "published"
            ? track.camelotKey
            : (keyRow?.camelotKey ?? track.camelotKey),
        keySource: track.keySource,
        keyConfidence: resolveCanonicalKeyConfidence(track, keyRow),
        keyAnalyzerName: keyRow?.analyzerName ?? null,
        nativeBpm: resolveCanonicalBpm(track, rhythm).bpm,
        gridOk: timeline?.gridOk ?? false,
        gridEngine: rhythm?.analyzerName ?? null,
      });
    }
    return out;
  }

  private qualityForPlan(
    plan: SetPlanV1,
    evidence?: FrozenRenderRequest["evidence"],
  ): PlanQualityReport {
    const tracksById = new Map(this.repository.listAll().map((track) => [track.id, track]));
    const audioEndMsByTrackId = this.audioEndMsByTrackId();
    const keyConfidenceByTrackId = this.keyConfidenceByTrackId();
    const firstDropStartMsByTrackId = this.firstDropStartMsByTrackId();
    const evidenceByTrackId = this.qualityEvidenceByTrackId();
    if (evidence) {
      for (const [trackId, row] of Object.entries(evidence)) {
        if (!isFrozenSnapshot(row)) {
          continue;
        }
        if (typeof row.audioEndMs === "number") {
          audioEndMsByTrackId.set(trackId, row.audioEndMs);
        }
        if (typeof row.keyConfidence === "number") {
          keyConfidenceByTrackId.set(trackId, row.keyConfidence);
        }
        const drops = row.sections.filter((section) => section.type === "drop");
        const drop = drops[0];
        if (drop && Number.isFinite(drop.startMs)) {
          firstDropStartMsByTrackId.set(trackId, drop.startMs);
        }
        const track = tracksById.get(trackId);
        evidenceByTrackId.set(trackId, {
          musicalKey: row.musicalKey ?? track?.musicalKey ?? null,
          camelotKey: row.camelotKey ?? track?.camelotKey ?? null,
          keySource: track?.keySource ?? null,
          keyConfidence: row.keyConfidence ?? 0,
          keyAnalyzerName: row.keyEngine ?? null,
          nativeBpm: row.bpm,
          gridOk: row.present && !row.gridRejected,
          gridEngine: row.rhythmEngine ?? null,
        });
      }
    }
    const validation = validateSetPlan(plan, tracksById, {
      artistRepeatSpacing: plan.planningConstraints?.artistRepeatSpacing,
      audioEndMsByTrackId,
      effectiveEnergyByTrackId: this.effectiveEnergyByTrackId(),
      keyConfidenceByTrackId,
      firstDropStartMsByTrackId,
    });
    return this.qualityFor(plan, { validation, evidenceByTrackId });
  }

  private qualityFor(
    plan: SetPlanV1,
    options: {
      validation: ValidateSetPlanResult;
      partial?: boolean;
      partialReasons?: string[];
      evidenceByTrackId?: Map<string, TrackQualityEvidence>;
    },
  ): PlanQualityReport {
    return reportSetPlanQuality({
      plan,
      tracksById: new Map(this.repository.listAll().map((track) => [track.id, track])),
      evidenceByTrackId: options.evidenceByTrackId ?? this.qualityEvidenceByTrackId(),
      validation: options.validation,
      recipes: this.recipes,
      constraints: plan.planningConstraints ?? null,
      partial: options.partial,
      partialReasons: options.partialReasons,
      hourAccepted: this.hourFeedback.acceptedPlan(plan.id, sha256Json(plan)),
    });
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

  private firstDropStartMsByTrackId(): Map<string, number> {
    const map = new Map<string, number>();
    for (const track of this.repository.listAll()) {
      const drop = analysisForTimeline(
        resolveTrackEvidence(this.analyses, track.id),
      )?.sections?.find((section) => section.type === "drop");
      if (drop && Number.isFinite(drop.startMs)) {
        map.set(track.id, drop.startMs);
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
      const energy = effectiveEnergy(
        track,
        this.analyses.findByTrackId(track.id)?.descriptors ?? null,
      );
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
