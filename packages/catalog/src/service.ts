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
  DomainError,
  RESOURCE_LIST_LIMIT,
  resolveBpmHint,
  recipeFingerprint,
  renderJoinFingerprint,
  renderSequenceFingerprint,
  resolveCanonicalBpm,
  resolveCanonicalKeyConfidence,
  resolveDescriptorFilters,
  toPublicTrack,
  VARIETY_AUTO_HISTORY_SCAN,
  VARIETY_RECENT_PLAN_WINDOW,
} from "@dnb-crate/domain";
import { ffmpegMixReady } from "@dnb-crate/audio-renderer";
import type { HourFeedbackRepository } from "./hour-feedback-repository.ts";

import { buildAnalysisReport, type AnalysisReport } from "./service/analysis-report.ts";
import {
  findCompatibleTracks as searchCompatibleTracks,
  type CompatibleTracksInput,
} from "./service/compatible-tracks.ts";
import {
  applySetPlanUpdate,
  cloneSetPlanInto,
  type UpdateSetPlanInput,
} from "./service/plan-editor.ts";
import {
  audioEndMsByTrackId,
  effectiveEnergyByTrackId,
  firstDropStartMsByTrackId,
  keyConfidenceByTrackId,
  qualityFor,
  qualityForPlan,
  type QualityEvidenceContext,
} from "./service/quality-evidence.ts";
import type { RecipeRecallLookup } from "./planning/recall.ts";
import { draftSetPlan } from "./planning/planner.ts";
import { primaryArtistKey } from "./planning/shared.ts";
import { PlanningConstraintError } from "./planning/constraints.ts";
import type { TrackQualityEvidence } from "./planning/quality.ts";
import { analysisToTimeline } from "./planning/timeline.ts";
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
  resolveTrackEvidence,
} from "./evidence.ts";
import type { FrozenRenderRequest } from "./render-job-repository.ts";

import type { MixWorkflowCoordinator } from "./mix-workflow.ts";

export class CatalogService {
  workflows!: MixWorkflowCoordinator;
  constructor(
    private readonly config: AppConfig,
    readonly repository: TrackRepository,
    readonly setPlans: SetPlanRepository,
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
        musicbrainz:
          this.config.enrichment?.enabled === true &&
          this.config.enrichment?.musicbrainz?.enabled !== false,
        deezer:
          this.config.enrichment?.enabled === true &&
          this.config.enrichment?.deezer?.enabled !== false,
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
      if (!Number.isFinite(cue.positionMs) || cue.positionMs < 0) {
        throw new DomainError(
          "INVALID_METADATA",
          `Cue ${cue.type} position must be a non-negative number of milliseconds`,
        );
      }
      if (cue.positionMs > track.durationMs) {
        throw new DomainError(
          "INVALID_METADATA",
          `Cue ${cue.type} at ${cue.positionMs}ms is past track duration ${track.durationMs}ms`,
        );
      }
    }
    if (beatAnchorMs !== undefined && (beatAnchorMs < 0 || beatAnchorMs > track.durationMs)) {
      throw new DomainError("INVALID_BEAT_GRID", "Beat anchor is outside the track duration");
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
    const explicitIds = (input.trackIds ?? []).length > 0;
    for (const id of input.trackIds ?? []) {
      ids.add(id);
    }
    if (scope === "unanalyzed" || scope === "stale" || scope === "all") {
      for (const id of this.analyses.listIdsForScope(scope, {
        bpmMin: this.config.analysis?.bpmMin,
        bpmMax: this.config.analysis?.bpmMax,
      })) {
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
        "INVALID_METADATA",
        "No tracks to analyze. Pass trackIds, planningReadyOnly=true, or scope unanalyzed|stale|all|planningReady.",
      );
    }
    // A pure explicit-ids request (scope defaults to "ids") or a whole-library
    // request means "recompute now" and must not be defeated by the freshness
    // skip (F9). Selector scopes (unanalyzed/stale/planningReady) stay
    // freshness-gated — including when ids are unioned in — and with the
    // input identity now covering tempo bounds and anchors, a config change
    // correctly re-analyzes through them too.
    const forceDsp = (scope === "ids" && explicitIds) || scope === "all";
    return this.analysis.start([...ids], { forceDsp });
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

  getAnalysisReport(): AnalysisReport {
    return buildAnalysisReport(this.repository, this.analyses);
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

  /** Join inspector (batch 9 first slice): one structured evidence view for
   * a saved join — the stored treatment, its placed windows, the alignment
   * provenance, the groove-gate numbers that selected it, and what the
   * planner would choose today (with per-template blockers), so a bad join
   * can be diagnosed without reconstructing source positions by hand. */
  inspectTransition(input: { setPlanId: string; transitionId: string }): {
    setPlanId: string;
    transitionId: string;
    order: number;
    stored: {
      type: string;
      durationMs: number;
      barCount: number | null;
      targetBpm: number | null;
      selectionReason: string | null;
      pairStampTrackId: string | null;
      appliedRecipeId: string | null;
    };
    outgoing: {
      trackId: string;
      title: string;
      sourceStartMs: number;
      sourceEndMs: number;
      playbackRate: number;
      overlapStartSourceMs: number;
    };
    incoming: {
      trackId: string;
      title: string;
      sourceStartMs: number;
      sourceEndMs: number;
      playbackRate: number;
    };
    alignment: {
      offsetMs: number | null;
      periodMs: number | null;
      mode: string | null;
      onsetLockBeats: number | null;
    };
    groove: {
      gap: number | null;
      outgoingMean: number | null;
      incomingMean: number | null;
      outgoingBars: number | null;
      incomingBars: number | null;
      outgoingWindowMs: number | null;
      incomingWindowMs: number | null;
      abstain: string | null;
    };
    freshView: {
      type: string;
      reason: string | null;
      rateInfeasible: boolean;
    } | null;
    alternatives: Array<{
      type: string;
      feasible: boolean;
      blockers: string[];
      score: number;
    }>;
  } {
    const stored = this.requirePlan(input.setPlanId);
    const entries = [...stored.plan.entries].sort((a, b) => a.order - b.order);
    const index = entries.findIndex((item) => item.transitionToNext?.id === input.transitionId);
    if (index < 0 || index >= entries.length - 1) {
      throw new DomainError(
        "INVALID_SET_PLAN",
        `No transition ${input.transitionId} on plan ${input.setPlanId}`,
      );
    }
    const outgoingEntry = entries[index]!;
    const incomingEntry = entries[index + 1]!;
    const transition = outgoingEntry.transitionToNext!;
    const outgoingTrack = this.requireTrack(outgoingEntry.trackId);
    const incomingTrack = this.requireTrack(incomingEntry.trackId);
    const overlapMs = transition.durationMs;
    const outRate = outgoingEntry.playbackRate > 0 ? outgoingEntry.playbackRate : 1;

    // What the planner would choose for this pair today, plus per-template
    // eligibility (F6 parity) as the alternatives view.
    const planned = planTransition(
      this.bundle(outgoingEntry.trackId),
      this.bundle(incomingEntry.trackId),
      {
        outgoingTrackId: outgoingEntry.trackId,
        incomingTrackId: incomingEntry.trackId,
        preferredType: "any",
        targetBpm:
          typeof transition.parameters.targetBpm === "number"
            ? transition.parameters.targetBpm
            : undefined,
      },
    );
    const best = planned.proposals[0] ?? null;
    const params = transition.parameters;
    const number = (key: string): number | null =>
      typeof params[key] === "number" ? params[key] : null;
    const pairStamp = typeof params.incomingTrackId === "string" ? params.incomingTrackId : null;
    return {
      setPlanId: input.setPlanId,
      transitionId: input.transitionId,
      order: index,
      stored: {
        type: transition.type,
        durationMs: transition.durationMs,
        barCount: number("barCount"),
        targetBpm: number("targetBpm"),
        selectionReason: typeof params.selectionReason === "string" ? params.selectionReason : null,
        pairStampTrackId: pairStamp,
        appliedRecipeId: typeof params.appliedRecipeId === "string" ? params.appliedRecipeId : null,
      },
      outgoing: {
        trackId: outgoingEntry.trackId,
        title: outgoingTrack.title,
        sourceStartMs: outgoingEntry.sourceStartMs,
        sourceEndMs: outgoingEntry.sourceEndMs,
        playbackRate: outgoingEntry.playbackRate,
        overlapStartSourceMs: outgoingEntry.sourceEndMs - overlapMs * outRate,
      },
      incoming: {
        trackId: incomingEntry.trackId,
        title: incomingTrack.title,
        sourceStartMs: incomingEntry.sourceStartMs,
        sourceEndMs: incomingEntry.sourceEndMs,
        playbackRate: incomingEntry.playbackRate,
      },
      alignment: {
        offsetMs: number("downbeatOffsetMs"),
        periodMs: number("alignmentPeriodMs"),
        mode: typeof params.alignmentMode === "string" ? params.alignmentMode : null,
        onsetLockBeats: number("onsetLockBeats"),
      },
      groove: {
        gap: number("grooveGap"),
        outgoingMean: number("grooveOutSync"),
        incomingMean: number("grooveInSync"),
        outgoingBars: number("grooveOutBars"),
        incomingBars: number("grooveInBars"),
        outgoingWindowMs: number("grooveOutWindowMs"),
        incomingWindowMs: number("grooveInWindowMs"),
        abstain: typeof params.grooveAbstain === "string" ? params.grooveAbstain : null,
      },
      freshView: best
        ? {
            type: best.type,
            reason: typeof best.reasons[0] === "string" ? best.reasons[0] : null,
            rateInfeasible: planned.targetBpm == null,
          }
        : null,
      alternatives: planned.proposals.map((proposal) => ({
        type: proposal.type,
        feasible: proposal.feasible,
        blockers: proposal.blockers,
        score: proposal.score,
      })),
    };
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
    if (this.config.enrichment?.enabled !== true) {
      throw new DomainError(
        "CONFIG_INVALID",
        "Metadata enrichment is disabled. Set enrichment.enabled in the config to use it.",
        { retryable: false },
      );
    }
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

  findCompatibleTracks(input: CompatibleTracksInput): {
    sourceTrackId: string;
    candidates: CompatibleTrack[];
  } {
    const source = this.requireTrack(input.sourceTrackId);
    return searchCompatibleTracks(this.repository, this.analyses, source, input);
  }

  createSetPlan(
    input: CreateSetPlanInput,
    candidateTrackIds?: ReadonlySet<string>,
  ): CreateSetPlanResult {
    try {
      // F8 (repository review 2026-10-08): the freshness-history resolution is
      // explicit and recorded. Explicit referencePlanIds win ("explicit");
      // otherwise "auto" (default) diversifies against the most recent
      // QUALIFYING plans — filtering for eligibility BEFORE limiting, so a
      // page of short drafts cannot hide older qualifying history — and
      // "off" disables automatic history entirely. The resolved ids, mode,
      // artist-rotation counts and policy version are persisted with the
      // explanation, so "same catalog + brief + seed" is no longer an
      // implicit reproducibility claim.
      //
      // Replay (review feature 4): replayFromPlanId reuses the referenced
      // plan's PERSISTED frozen context — its reference plans' track IDs,
      // pairs, and artist-use counts — and its seed. The replay does not
      // re-resolve history from the live catalog, so newer plans added
      // since the reference cannot change the outcome.
      let replaySeed: number | undefined;
      if (input.replayFromPlanId) {
        const replaySource = this.requirePlan(input.replayFromPlanId);
        replaySeed = replaySource.seed;
        const frozenVariety = replaySource.explanation.variety;
        if (frozenVariety) {
          const varietyHistory = {
            trackIds: frozenVariety.trackIds,
            pairs: frozenVariety.pairs,
            recentArtistUses: frozenVariety.recentArtistUses ?? {},
            mode: "replay" as const,
          };
          return this.createSetPlanWithHistory(
            { ...input, seed: replaySeed ?? input.seed },
            varietyHistory,
            frozenVariety.referencePlanIds,
            candidateTrackIds,
          );
        }
        // No variety context to replay: plain replan with the same seed.
        return this.createSetPlanWithHistory(
          { ...input, seed: replaySeed ?? input.seed },
          { trackIds: [], pairs: [], recentArtistUses: {}, mode: "off" as const },
          [],
          candidateTrackIds,
        );
      }
      const historyPreference = input.variety?.history ?? "auto";
      const explicitReferenceIds = input.variety?.referencePlanIds ?? [];
      let referencePlanIds = explicitReferenceIds;
      let historyMode: "auto" | "explicit" | "off";
      if (explicitReferenceIds.length > 0) {
        historyMode = "explicit";
      } else if (historyPreference === "off") {
        historyMode = "off";
        referencePlanIds = [];
      } else {
        historyMode = "auto";
        const recent = this.setPlans.list(VARIETY_AUTO_HISTORY_SCAN).plans;
        referencePlanIds = recent
          .filter((summary) => summary.entryCount >= 8)
          .slice(0, VARIETY_RECENT_PLAN_WINDOW)
          .map((summary) => summary.id);
      }
      const referencePlans = referencePlanIds.map((id) => this.requirePlan(id).plan);
      const recentArtistUses: Record<string, number> = {};
      const trackIds = new Set<string>();
      const pairs: Array<{ outgoingTrackId: string; incomingTrackId: string }> = [];
      for (const plan of referencePlans) {
        const artistsThisPlan = new Set<string>();
        for (const entry of plan.entries) {
          trackIds.add(entry.trackId);
        }
        for (let i = 0; i + 1 < plan.entries.length; i += 1) {
          pairs.push({
            outgoingTrackId: plan.entries[i]!.trackId,
            incomingTrackId: plan.entries[i + 1]!.trackId,
          });
        }
        for (const entry of plan.entries) {
          const track = this.repository.findById(entry.trackId);
          const key = track ? primaryArtistKey(track) : null;
          if (key) artistsThisPlan.add(key);
        }
        for (const key of artistsThisPlan) {
          recentArtistUses[key] = (recentArtistUses[key] ?? 0) + 1;
        }
      }
      const varietyHistory = {
        trackIds: [...trackIds],
        pairs,
        recentArtistUses,
        mode: historyMode,
      };
      return this.createSetPlanWithHistory(
        input,
        varietyHistory,
        referencePlanIds,
        candidateTrackIds,
      );
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

  /** Shared planning pipeline: draft, validate, store. Both the normal
   *  history-resolving path and the replay path (frozen context from a
   *  referenced plan) feed into this. */
  private createSetPlanWithHistory(
    input: CreateSetPlanInput,
    varietyHistory: {
      trackIds: string[];
      pairs: Array<{ outgoingTrackId: string; incomingTrackId: string }>;
      recentArtistUses: Record<string, number>;
      mode: "auto" | "explicit" | "off" | "replay";
    },
    referencePlanIds: string[],
    candidateTrackIds?: ReadonlySet<string>,
  ): CreateSetPlanResult {
    const allTracks = this.repository.listAll();
    const descriptorPercentiles = this.getLibraryStats().descriptorPercentiles;
    const analyses = new Map(
      allTracks
        .map((track) => [track.id, this.toTimeline(track)] as const)
        .filter(
          (entry): entry is readonly [string, NonNullable<ReturnType<typeof analysisToTimeline>>] =>
            entry[1] != null,
        ),
    );
    const drafted = draftSetPlan(
      allTracks.filter((track) => !candidateTrackIds || candidateTrackIds.has(track.id)),
      {
        ...input,
        descriptors: resolveDescriptorFilters(input.descriptors, descriptorPercentiles),
        // The brief the planner and its explanation see carries the
        // RESOLVED reference ids, not the user's raw input.
        variety: {
          referencePlanIds,
          ...(input.variety?.strength != null ? { strength: input.variety.strength } : {}),
        },
      },
      analyses,
      {
        percentiles: descriptorPercentiles,
        feedback: this.feedback.index(),
        recipes: this.recipes,
        varietyHistory,
      },
    );
    const tracksById = new Map(allTracks.map((track) => [track.id, track]));
    const validation = validateSetPlan(drafted.plan, tracksById, {
      artistRepeatSpacing: input.artistRepeatSpacing,
      audioEndMsByTrackId: this.audioEndMsByTrackId(),
      effectiveEnergyByTrackId: this.effectiveEnergyByTrackId(),
      keyConfidenceByTrackId: this.keyConfidenceByTrackId(),
      firstDropStartMsByTrackId: this.firstDropStartMsByTrackId(),
    });
    const stored = this.setPlans.save(drafted.plan, drafted.explanation.seed, drafted.explanation);
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
  }

  getSetPlan(setPlanId: string): SetPlanV1 {
    return this.requirePlan(setPlanId).plan;
  }

  cloneSetPlan(input: { setPlanId: string; name: string; replan?: boolean }): CreateSetPlanResult {
    return cloneSetPlanInto(this, input);
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
    allowGridResidual?: boolean;
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

  /** Variant comparison (batch 9): render the stored treatment plus every
   *  other feasible aligned template for one saved join, on the same frozen
   *  windows with comparable loudness, so the owner can A/B by ear and
   *  rate each variant. The review's highest-value remaining feature. */
  async compareTransitionVariants(input: {
    setPlanId: string;
    transitionId: string;
    windowMs?: number;
    allowLowConfidence?: boolean;
  }): Promise<{
    setPlanId: string;
    transitionId: string;
    order: number;
    outgoing: { trackId: string; title: string };
    incoming: { trackId: string; title: string };
    storedTemplate: string;
    variants: Array<{
      template: string;
      isStored: boolean;
      feasible: boolean;
      blockers: string[];
      jobId: string | null;
      outputRootRelativePath: string | null;
    }>;
  }> {
    const stored = this.requirePlan(input.setPlanId);
    const entries = [...stored.plan.entries].sort((a, b) => a.order - b.order);
    const index = entries.findIndex((item) => item.transitionToNext?.id === input.transitionId);
    if (index < 0 || index >= entries.length - 1) {
      throw new DomainError(
        "INVALID_SET_PLAN",
        `No transition ${input.transitionId} on plan ${input.setPlanId}`,
      );
    }
    const outgoingEntry = entries[index]!;
    const incomingEntry = entries[index + 1]!;
    const transition = outgoingEntry.transitionToNext!;
    const outgoingTrack = this.requireTrack(outgoingEntry.trackId);
    const incomingTrack = this.requireTrack(incomingEntry.trackId);

    // Determine feasibility for each template (F6 parity set).
    const planned = this.planTransition({
      outgoingTrackId: outgoingEntry.trackId,
      incomingTrackId: incomingEntry.trackId,
      preferredType: "any",
      targetBpm:
        typeof transition.parameters.targetBpm === "number"
          ? transition.parameters.targetBpm
          : undefined,
      allowLowConfidence: input.allowLowConfidence,
    });

    const templates: Array<"crossfade" | "phrase_mix" | "bass_swap"> = [
      "phrase_mix",
      "bass_swap",
      "crossfade",
    ];
    const variants: Array<{
      template: string;
      isStored: boolean;
      feasible: boolean;
      blockers: string[];
      jobId: string | null;
      outputRootRelativePath: string | null;
    }> = [];
    for (const template of templates) {
      const proposal = planned.proposals.find((item) => item.type === template);
      const isStored = transition.type === template;
      const feasible = proposal?.feasible ?? false;
      const blockers = proposal?.blockers ?? [];
      let jobId: string | null = null;
      const outputPath: string | null = null;
      if (feasible || isStored) {
        try {
          const started = await this.renders.startPreview({
            setPlanId: input.setPlanId,
            transitionId: input.transitionId,
            windowMs: input.windowMs,
            template,
            allowLowConfidence: input.allowLowConfidence,
          });
          jobId = started.job.id;
        } catch {
          // Preview failed; report it without blocking the others.
          blockers.push("preview render failed");
        }
      }
      variants.push({
        template,
        isStored,
        feasible,
        blockers,
        jobId,
        outputRootRelativePath: outputPath,
      });
    }
    return {
      setPlanId: input.setPlanId,
      transitionId: input.transitionId,
      order: index,
      outgoing: { trackId: outgoingEntry.trackId, title: outgoingTrack.title },
      incoming: { trackId: incomingEntry.trackId, title: incomingTrack.title },
      storedTemplate: transition.type,
      variants,
    };
  }

  /** Surgical repair (batch 9): replace a join's incoming track while
   *  preserving every other adjacency. The F7 pair-aware invalidation IS
   *  the protection: only the two joins touching the replaced track are
   *  replanned; every other join keeps its stored treatment exactly. No
   *  explicit protection flag — the invariant is the guarantee. Returns
   *  the updated plan plus an honest before/after diff of every join. */
  repairSetPlan(input: { setPlanId: string; entryId: string; newIncomingTrackId: string }): {
    plan: SetPlanV1;
    diff: {
      replacedTrack: { fromTitle: string; toTitle: string; order: number };
      changedJoins: Array<{
        order: number;
        pair: string;
        reason: string;
        beforeType: string | null;
        afterType: string | null;
      }>;
      preservedJoins: Array<{ order: number; pair: string; type: string }>;
    };
    validation: ValidateSetPlanResult;
  } {
    const stored = this.requirePlan(input.setPlanId);
    const beforeEntries = [...stored.plan.entries].sort((a, b) => a.order - b.order);
    const index = beforeEntries.findIndex((item) => item.id === input.entryId);
    if (index < 0 || index >= beforeEntries.length - 1) {
      throw new DomainError(
        "INVALID_SET_PLAN",
        `Entry ${input.entryId} has no transition to repair (last entry or not found)`,
      );
    }
    const newTrack = this.requireTrack(input.newIncomingTrackId);
    const oldTrack = this.requireTrack(beforeEntries[index + 1]!.trackId);

    // Apply via updateSetPlan's replaceTrack, which handles adjacency
    // invalidation (F7) correctly: only the changed pair is replanned.
    const result = this.updateSetPlan({
      setPlanId: input.setPlanId,
      replaceTrack: { entryId: beforeEntries[index + 1]!.id, trackId: input.newIncomingTrackId },
    });

    // Honest before/after diff: report EVERY join that changed and every
    // join that kept its exact treatment. A join "changed" if its
    // transition ID differs (the old one was invalidated and a new one
    // was created) or its type changed.
    const afterEntries = [...result.plan.entries].sort((a, b) => a.order - b.order);
    const titleOf = new Map(this.repository.listAll().map((track) => [track.id, track.title]));
    const changedJoins: Array<{
      order: number;
      pair: string;
      reason: string;
      beforeType: string | null;
      afterType: string | null;
    }> = [];
    const preservedJoins: Array<{ order: number; pair: string; type: string }> = [];
    for (let i = 0; i < afterEntries.length - 1; i += 1) {
      const before = beforeEntries[i]?.transitionToNext ?? null;
      const after = afterEntries[i]?.transitionToNext ?? null;
      const pair = `${titleOf.get(afterEntries[i]!.trackId) ?? "?"} -> ${titleOf.get(afterEntries[i + 1]!.trackId) ?? "?"}`;
      const beforeId = before?.id ?? null;
      const afterId = after?.id ?? null;
      const beforeType = before?.type ?? null;
      const afterType = after?.type ?? null;
      if (beforeId !== afterId || beforeType !== afterType) {
        const reason =
          i === index
            ? `outgoing join of the replaced track (${oldTrack.title} -> ${newTrack.title})`
            : i === index + 1
              ? `incoming join of the replaced track (${oldTrack.title} -> ${newTrack.title})`
              : "unexpected change — this join does not touch the replaced track";
        changedJoins.push({ order: i, pair, reason, beforeType, afterType });
      } else if (after) {
        preservedJoins.push({ order: i, pair, type: after.type });
      }
    }
    return {
      plan: result.plan,
      diff: {
        replacedTrack: {
          fromTitle: oldTrack.title,
          toTitle: newTrack.title,
          order: index + 1,
        },
        changedJoins,
        preservedJoins,
      },
      validation: result.validation,
    };
  }

  getRenderStatus(renderJobId: string): RenderJob {
    return this.renders.getStatus(renderJobId);
  }

  getRenderManifest(renderJobId: string): RenderManifestV1 {
    return this.renders.getManifest(renderJobId);
  }

  checkRender(
    renderJobId: string,
    abortSignal?: AbortSignal,
    options?: { audioVerification?: "off" | "fast" | "full" },
  ) {
    return this.renders.checkRender(renderJobId, abortSignal, options);
  }

  listRenderJobs(limit?: number, cursor?: string, setPlanId?: string) {
    return this.renders.list(limit, cursor, setPlanId);
  }

  cancelRenderJob(renderJobId: string, confirm: true) {
    if (confirm !== true) {
      throw new DomainError("INVALID_METADATA", "Pass confirm: true to cancel a render job");
    }
    return this.renders.cancel(renderJobId, confirm);
  }

  waitForRenderJob(renderJobId: string, timeoutMs?: number) {
    return this.renders.waitForJob(renderJobId, timeoutMs);
  }

  listRenderResources(limit = RESOURCE_LIST_LIMIT): RenderJob[] {
    // Filter in SQL so pagination is not wasted on non-succeeded pages.
    return this.renders.list(limit, undefined, undefined, "succeeded").jobs;
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

  updateSetPlan(input: UpdateSetPlanInput): CreateSetPlanResult {
    return applySetPlanUpdate(this, input);
  }
  bundle(trackId: string) {
    const track = this.requireTrack(trackId);
    return {
      track,
      analysis: analysisForTimeline(resolveTrackEvidence(this.analyses, trackId)),
      cues: this.repository.listCuePoints(trackId),
    };
  }

  toTimeline(track: Track) {
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

  recipeLookupFor(plan: SetPlanV1): RecipeRecallLookup {
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

  private qualityContext(): QualityEvidenceContext {
    return {
      repository: this.repository,
      analyses: this.analyses,
      recipes: this.recipes,
      hourFeedback: this.hourFeedback,
      toTimeline: (track) => this.toTimeline(track),
    };
  }

  keyConfidenceByTrackId(): Map<string, number> {
    return keyConfidenceByTrackId(this.qualityContext());
  }

  qualityForPlan(plan: SetPlanV1, evidence?: FrozenRenderRequest["evidence"]): PlanQualityReport {
    return qualityForPlan(this.qualityContext(), plan, evidence);
  }

  qualityFor(
    plan: SetPlanV1,
    options: {
      validation: ValidateSetPlanResult;
      partial?: boolean;
      partialReasons?: string[];
      evidenceByTrackId?: Map<string, TrackQualityEvidence>;
    },
  ): PlanQualityReport {
    return qualityFor(this.qualityContext(), plan, options);
  }

  audioEndMsByTrackId(): Map<string, number> {
    return audioEndMsByTrackId(this.qualityContext());
  }

  firstDropStartMsByTrackId(): Map<string, number> {
    return firstDropStartMsByTrackId(this.qualityContext());
  }

  effectiveEnergyByTrackId(): Map<string, number> {
    return effectiveEnergyByTrackId(this.qualityContext());
  }
  requireTrack(trackId: string) {
    const track = this.repository.findById(trackId);
    if (!track) {
      throw new DomainError("TRACK_NOT_FOUND", `No track with id ${trackId}`);
    }
    return track;
  }

  requirePlan(setPlanId: string) {
    const stored = this.setPlans.findById(setPlanId);
    if (!stored) {
      throw new DomainError("SET_PLAN_NOT_FOUND", `No set plan with id ${setPlanId}`);
    }
    return stored;
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
