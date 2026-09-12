import { access, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import {
  APP_VERSION,
  DEFAULT_LOUDNESS_TARGET_LUFS,
  DEFAULT_PREVIEW_WINDOW_MS,
  DEFAULT_RENDER_CHANNELS,
  DEFAULT_RENDER_EDGE_FADE_MS,
  DEFAULT_RENDER_OUTPUT_EXTENSION,
  DEFAULT_RENDER_OUTPUT_FORMAT,
  DEFAULT_RENDER_SAMPLE_RATE_HZ,
  DEFAULT_RENDER_WORKER_LIMIT,
  DEFAULT_TRUE_PEAK_CEILING_DB,
  DomainError,
  MIN_ANALYSIS_CONFIDENCE,
  RENDER_CHECK_LEVEL_STEP_FAIL_LU,
  RENDER_CHECK_RESIDUAL_FAIL_MS,
  RENDERER_VERSION,
  LISTEN_RENDER_BIT_DEPTH,
  listenRenderRelPath,
  analyzerVersionLessThan,
  assertPlaybackRate,
  clampMixPresetParams,
  resolveRenderPhraseShape,
  expandPreset,
  normalizePhraseBars,
  outputToSourceMs,
  isDomainError,
  sectionAtMs,
  sequentialHandoffLabel,
  resolvePlanRateRegionsVersion,
  resolveRateRegions,
  outputPositionToSourceMs,
  type AppConfig,
  type AutomationEvent,
  type Logger,
  type MixPresetParams,
  type RenderJob,
  type RenderManifestTrack,
  type RenderManifestV1,
  type RenderReadiness,
  type SetPlanEntry,
  type SetPlanV1,
  type Track,
  type TransitionType,
  type ValidateSetPlanResult,
  type ValidationIssue,
  effectiveEnergy,
  resolveCanonicalKeyConfidence,
} from "@dnb-crate/domain";
import {
  detectFfmpeg,
  ffmpegAlignedReady,
  ffmpegMixReady,
  requireAlignedFfmpeg,
  requireFfmpeg,
  renderMix,
  encodeListenFlac,
  applyAlignmentOffset,
  planAlignmentOffsetMs,
  mixTagsFromTracklist,
  parseSilenceSpans,
  sha256File,
  sha256Json,
  trackCredit,
  type FfmpegBinaries,
  type MixSegment,
  type MixTransitionSpec,
  type ProcessRunner,
} from "@dnb-crate/audio-renderer";

import {
  evaluateDurationError,
  firstDropMs,
  freezeJoinEvidence,
  joinCamelotDistance,
  measureLevelStepLu,
  paramNumber,
  paramString,
  plannedLevelStepLu,
  storedGridFromEvidence,
} from "./check-metrics.ts";
import { fingerprintFile } from "../fingerprint.ts";
import { isPathInsideAnyRoot, isPathInsideRoot } from "../paths.ts";
import { sectionEnergyAt } from "../planning/cues.ts";
import { planDurationMs, plannedMixDurationMs, playableOutputMs } from "../planning/timeline.ts";
import { validateSetPlan } from "../planning/validate.ts";
import type { TrackRepository } from "../repository.ts";
import type { SetPlanRepository } from "../set-plan-repository.ts";
import type { RenderJobRepository, StoredRenderJob } from "../render-job-repository.ts";
import type { AnalysisRepository } from "../analysis-repository.ts";

export type RenderCheckJoin = {
  order: number;
  outgoingTitle: string;
  incomingTitle: string;
  template: string;
  barCount: number | null;
  phraseShape: string | null;
  exitKind: string | null;
  mixOutMs: number | null;
  mixInMs: number | null;
  incomingDropMs: number | null;
  outgoingLufs: number | null;
  incomingLufs: number | null;
  outgoingGainDb: number;
  incomingGainDb: number;
  camelotDistance: number | null;
  residualMs: number | null;
  storedGridResidualMs: number | null;
  residualKind: "stored-grid-consistency";
  evidenceSource: "frozen-manifest" | "missing";
  audioStatus: "unmeasured" | "pass" | "review" | "fail" | "advisory";
  levelStepLu: number | null;
  lowOverlapSec: number | null;
  outgoingRate: number;
  incomingRate: number;
  downbeatOffsetMs: number | null;
  alignmentPeriodMs: number | null;
  alignmentMode: "bar" | "beat" | "phrase" | null;
  windowInSilence: boolean;
  overlapAtMs: number | null;
};

export type RenderCheckResult = {
  renderJobId: string;
  outputPath: string;
  durationMs: number;
  plannedDurationMs: number | null;
  durationErrorMs: number | null;
  durationStatus: "pass" | "warning" | "fail" | "unmeasured";
  interiorSilence: Array<{ startMs: number; endMs: number; durationMs: number }>;
  joins: RenderCheckJoin[];
  failures: string[];
  warnings: string[];
  ok: boolean;
};

export type PreparedSegment = MixSegment & {
  trackId: string;
  entryId: string;
  fingerprint: string;
  artist: string | null;
  title: string;
  timelineStartMs: number;
  playbackRate: number;
  overlapToNextMs: number | null;
  transitionId: string | null;
  requestedTransitionType: TransitionType | null;
  analysisVersion: string | null;
  bpmConfidence: number | null;
  downbeatTimesMs: number[];
  analysisBpm: number | null;
  targetBpm: number | null;
  downbeatOffsetMs: number | null;
  alignmentPeriodMs: number | null;
  alignmentMode: "bar" | "beat" | "phrase" | null;
  downbeatConfidence: number | null;
  mixParams: Partial<MixPresetParams> | null;
  mixOutMs: number | null;
  mixInMs: number | null;
  exitKind: string | null;
  incomingDropMs: number | null;
  beatTimesMs: number[];
  camelotKey: string | null;
  audioEndMs: number | null;
  tailEnergy: number | null;
  headEnergy: number | null;
  recipeVersion: number | null;
};

type RenderSettings = {
  loudnessTargetLufs: number;
  truePeakCeilingDb: number;
  sampleRateHz: number;
  workerLimit: number;
  previewWindowMs: number;
  edgeFadeMs: number;
  ffmpegPath: string;
  ffprobePath: string;
  rubberbandCliPath: string | null;
};

function settingsFrom(config: AppConfig, rubberbandCliPath: string | null): RenderSettings {
  return {
    loudnessTargetLufs: config.loudnessTargetLufs ?? DEFAULT_LOUDNESS_TARGET_LUFS,
    truePeakCeilingDb: config.truePeakCeilingDb ?? DEFAULT_TRUE_PEAK_CEILING_DB,
    sampleRateHz: config.renderSampleRateHz ?? DEFAULT_RENDER_SAMPLE_RATE_HZ,
    workerLimit: config.renderWorkerLimit ?? DEFAULT_RENDER_WORKER_LIMIT,
    previewWindowMs: config.previewWindowMs ?? DEFAULT_PREVIEW_WINDOW_MS,
    edgeFadeMs: config.renderEdgeFadeMs ?? DEFAULT_RENDER_EDGE_FADE_MS,
    ffmpegPath: config.ffmpegPath ?? "ffmpeg",
    ffprobePath: config.ffprobePath ?? "ffprobe",
    rubberbandCliPath,
  };
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: string }).name === "AbortError")
  );
}

function toPublicJob(job: StoredRenderJob): RenderJob {
  const { cacheKey: _c, manifest: _m, params: _p, ...rest } = job;
  return rest;
}

export class RenderCoordinator {
  /** Revalidate queued full jobs against the actual plan before decoding sources. */
  validateFullPlan?: (setPlanId: string, options?: { allowOverlongDuration?: boolean }) => void;
  private running = 0;
  private stopped = false;
  private binaries: FfmpegBinaries | null | undefined;
  private readonly aborts = new Map<string, AbortController>();
  private readonly settings: RenderSettings;

  constructor(
    private readonly config: AppConfig,
    private readonly tracks: TrackRepository,
    private readonly plans: SetPlanRepository,
    private readonly jobs: RenderJobRepository,
    private readonly analyses: AnalysisRepository,
    private readonly runner: ProcessRunner,
    private readonly logger: Logger,
    rubberbandCliPath: string | null = null,
  ) {
    this.settings = settingsFrom(config, rubberbandCliPath);
  }

  recoverInterrupted(): number {
    return this.jobs.failRunningAsInterrupted();
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.aborts.values()) {
      controller.abort();
    }
  }

  kick(): void {
    this.pump();
  }

  async detect(): Promise<FfmpegBinaries | null> {
    if (this.binaries !== undefined) {
      return this.binaries;
    }
    this.binaries = await detectFfmpeg(this.runner, {
      ffmpegPath: this.settings.ffmpegPath,
      ffprobePath: this.settings.ffprobePath,
    });
    return this.binaries;
  }

  async renderCuePreview(input: {
    filePath: string;
    startMs: number;
    endMs: number;
    relPath: string;
  }): Promise<{ outputRelpath: string }> {
    const binaries = requireFfmpeg(await this.detect());
    await mkdir(this.config.outputRoot, { recursive: true });
    const absOut = path.resolve(this.config.outputRoot, input.relPath);
    await mkdir(path.dirname(absOut), { recursive: true });
    await renderMix(this.runner, binaries, {
      segments: [
        {
          filePath: input.filePath,
          sourceStartMs: input.startMs,
          sourceEndMs: input.endMs,
          gainDb: 0,
          playbackRate: 1,
        },
      ],
      overlapMs: [],
      outputPath: absOut,
      sampleRateHz: this.settings.sampleRateHz,
      truePeakCeilingDb: this.settings.truePeakCeilingDb,
      loudnessTargetLufs: this.settings.loudnessTargetLufs,
      edgeFadeMs: 20,
      postProcess: false,
      rubberbandCliPath: this.settings.rubberbandCliPath,
    });
    return { outputRelpath: input.relPath.split(path.sep).join("/") };
  }

  async validatePlan(
    setPlanId: string,
    options: { allowLowConfidence?: boolean; allowExcessiveTempo?: boolean } = {},
  ): Promise<ValidateSetPlanResult> {
    const stored = this.requirePlan(setPlanId);
    const tracksById = new Map(this.tracks.listAll().map((track) => [track.id, track]));
    const effectiveEnergyByTrackId = new Map<string, number>();
    for (const track of tracksById.values()) {
      const energy = effectiveEnergy(track, this.analyses.findByTrackId(track.id)?.descriptors ?? null);
      if (energy != null) {
        effectiveEnergyByTrackId.set(track.id, energy);
      }
    }
    const structural = validateSetPlan(stored.plan, tracksById, {
      audioEndMsByTrackId: this.audioEndMsByTrackId(),
      firstDropStartMsByTrackId: this.firstDropStartMsByTrackId(),
      effectiveEnergyByTrackId,
      keyConfidenceByTrackId: new Map(
        [...tracksById.values()].map((track) => [
          track.id,
          resolveCanonicalKeyConfidence(track, this.analyses.findKeyAnalysis(track.id)),
        ]),
      ),
    });
    const renderReadiness = await this.assessReadiness(stored.plan, tracksById, options);
    return { ...structural, renderReadiness };
  }

  async startFullRender(input: {
    setPlanId: string;
    edgeFadeMs?: number;
    allowLowConfidence?: boolean;
    allowExcessiveTempo?: boolean;
    allowOverlongDuration?: boolean;
  }): Promise<{ job: RenderJob; warnings: string[] }> {
    const stored = this.requirePlan(input.setPlanId);
    const validation = await this.validatePlan(input.setPlanId, {
      allowLowConfidence: input.allowLowConfidence,
      allowExcessiveTempo: input.allowExcessiveTempo,
    });
    if (!validation.valid) {
      throw new DomainError(
        "INVALID_SET_PLAN",
        validation.errors.map((issue) => issue.message).join("; "),
        { details: { errors: validation.errors } },
      );
    }
    const binaries = requireFfmpeg(await this.detect());
    if (planHasAlignedTransition(stored.plan)) {
      requireAlignedFfmpeg(binaries);
    }
    if (!validation.renderReadiness?.ready) {
      throw new DomainError(
        "INVALID_SET_PLAN",
        validation.renderReadiness?.issues.map((issue) => issue.message).join("; ") ??
          "Plan is not ready to render",
        { details: { issues: validation.renderReadiness?.issues } },
      );
    }
    const warnings = [
      ...validation.warnings.map((issue) => issue.message),
      ...validation.renderReadiness.issues.map((issue) => issue.message),
    ];
    const job = this.jobs.insertQueued({
      id: crypto.randomUUID(),
      kind: "full",
      setPlanId: stored.plan.id,
      warnings,
      params: {
        edgeFadeMs: input.edgeFadeMs ?? this.settings.edgeFadeMs,
        allowLowConfidence: input.allowLowConfidence,
        allowExcessiveTempo: input.allowExcessiveTempo,
        allowOverlongDuration: input.allowOverlongDuration,
      },
    });
    this.kick();
    return { job: toPublicJob(job), warnings };
  }

  async startPreview(input: {
    setPlanId: string;
    transitionId: string;
    windowMs?: number;
    template?: "crossfade" | "phrase_mix" | "bass_swap";
    barCount?: 8 | 16 | 32;
    allowLowConfidence?: boolean;
  }): Promise<{ job: RenderJob; warnings: string[] }> {
    const stored = this.requirePlan(input.setPlanId);
    const pair = findTransitionPair(stored.plan, input.transitionId);
    if (!pair) {
      throw new DomainError(
        "INVALID_SET_PLAN",
        `No transition ${input.transitionId} on this set plan`,
      );
    }
    const validation = await this.validatePlan(input.setPlanId, {
      allowLowConfidence: input.allowLowConfidence,
    });
    const binaries = requireFfmpeg(await this.detect());
    const effectiveType = input.template ?? pair.outgoing.transitionToNext?.type ?? "crossfade";
    if (effectiveType === "phrase_mix" || effectiveType === "bass_swap") {
      requireAlignedFfmpeg(binaries);
      this.assertPairAligned(
        pair.outgoing.trackId,
        pair.incoming.trackId,
        input.allowLowConfidence === true,
      );
    }
    const blocking = validation.renderReadiness?.issues.filter(
      (issue) => issue.trackId === pair.outgoing.trackId || issue.trackId === pair.incoming.trackId,
    );
    const fatal = blocking?.filter(
      (issue) =>
        issue.code === "AUDIO_FILE_UNAVAILABLE" ||
        issue.code === "FINGERPRINT_MISMATCH" ||
        issue.code === "INVALID_TRIM",
    );
    if (fatal && fatal.length > 0) {
      throw new DomainError(
        "AUDIO_FILE_UNAVAILABLE",
        fatal.map((issue) => issue.message).join("; "),
      );
    }
    const windowMs = input.windowMs ?? this.settings.previewWindowMs;
    const cacheKey = sha256Json({
      rendererVersion: RENDERER_VERSION,
      sampleRateHz: this.settings.sampleRateHz,
      windowMs,
      template: input.template ?? pair.outgoing.transitionToNext?.type ?? "crossfade",
      barCount: input.barCount ?? null,
      transitionId: input.transitionId,
      transition: pair.outgoing.transitionToNext,
      outgoing: {
        trackId: pair.outgoing.trackId,
        start: pair.outgoing.sourceStartMs,
        end: pair.outgoing.sourceEndMs,
        gain: pair.outgoing.gainDb,
        rate: pair.outgoing.playbackRate,
        overlap: pair.outgoing.transitionToNext?.durationMs,
      },
      incoming: {
        trackId: pair.incoming.trackId,
        start: pair.incoming.sourceStartMs,
        end: pair.incoming.sourceEndMs,
        gain: pair.incoming.gainDb,
        rate: pair.incoming.playbackRate,
      },
      fingerprints: [
        this.tracks.findById(pair.outgoing.trackId)?.fileFingerprint,
        this.tracks.findById(pair.incoming.trackId)?.fileFingerprint,
      ],
    });
    const cached = this.jobs.findSucceededByCacheKey(cacheKey);
    if (cached?.outputRootRelativePath) {
      const abs = path.resolve(this.config.outputRoot, cached.outputRootRelativePath);
      try {
        await access(abs, constants.F_OK);
        const cloned = this.jobs.insertSucceededCache({
          id: crypto.randomUUID(),
          kind: "preview",
          setPlanId: stored.plan.id,
          transitionId: input.transitionId,
          cacheKey,
          source: cached,
        });
        return { job: toPublicJob(cloned), warnings: cloned.warnings };
      } catch {
        this.logger.warn({ cacheKey }, "Cached preview file missing; re-rendering");
      }
    }
    const job = this.jobs.insertQueued({
      id: crypto.randomUUID(),
      kind: "preview",
      setPlanId: stored.plan.id,
      transitionId: input.transitionId,
      cacheKey,
      warnings: validation.warnings.map((issue) => issue.message),
      params: {
        windowMs,
        template: input.template,
        barCount: input.barCount,
        allowLowConfidence: input.allowLowConfidence,
      },
    });
    this.kick();
    return { job: toPublicJob(job), warnings: job.warnings };
  }

  getStatus(renderJobId: string): RenderJob {
    return toPublicJob(this.jobs.require(renderJobId));
  }

  getManifest(renderJobId: string): RenderManifestV1 {
    const job = this.jobs.require(renderJobId);
    if (job.status !== "succeeded" || !job.manifest) {
      throw new DomainError(
        job.status === "running" || job.status === "queued" ? "RENDER_FAILED" : "RENDER_FAILED",
        "Render manifest is available after the job succeeds. Poll get_render_status.",
        { retryable: job.status === "queued" || job.status === "running" },
      );
    }
    return job.manifest;
  }

  async checkRender(renderJobId: string): Promise<RenderCheckResult> {
    const job = this.getStatus(renderJobId);
    if (job.status !== "succeeded" || !job.outputRootRelativePath) {
      throw new DomainError(
        "RENDER_FAILED",
        `Render ${renderJobId} is ${job.status}; check needs a succeeded job`,
      );
    }
    const manifest = this.getManifest(renderJobId);
    const outputPath = path.resolve(this.config.outputRoot, job.outputRootRelativePath);
    const binaries = requireFfmpeg(await this.detect());
    const silenceRun = await this.runner.run({
      executable: binaries.ffmpegPath,
      args: [
        "-nostdin",
        "-hide_banner",
        "-i",
        outputPath,
        "-af",
        "silencedetect=noise=-50dB:d=1",
        "-f",
        "null",
        "-",
      ],
    });
    const spans = parseSilenceSpans(`${silenceRun.stderr}\n${silenceRun.stdout}`);
    const durationMs = manifest.outputDurationMs;
    const interiorSilence = spans
      .filter(
        (span) =>
          span.startMs > 500 &&
          span.endMs !== null &&
          span.endMs < durationMs - 500,
      )
      .map((span) => ({
        startMs: span.startMs,
        endMs: span.endMs as number,
        durationMs: (span.endMs as number) - span.startMs,
      }));
    const last = manifest.tracks.at(-1);
    const plannedDurationMs = last
      ? plannedMixDurationMs(
          manifest.tracks,
          analyzerVersionLessThan(manifest.rendererVersion, "6.10.0") ? "all" : "overlap",
          manifest.rateRegionsVersion,
        )
      : null;
    const duration = evaluateDurationError(durationMs, plannedDurationMs, manifest.kind);
    const joins: RenderCheckJoin[] = [];
    for (let i = 0; i < manifest.tracks.length - 1; i += 1) {
      const outgoing = manifest.tracks[i]!;
      const incoming = manifest.tracks[i + 1]!;
      const outTrack = this.tracks.findById(outgoing.trackId);
      const inTrack = this.tracks.findById(incoming.trackId);
      const evidence = manifest.joinEvidence?.find(
        (item) => item.outgoingTrackId === outgoing.trackId && item.incomingTrackId === incoming.trackId,
      );
      const audioEnd = evidence?.outgoingAudioEndMs ?? null;
      const overlap = outgoing.overlapToNextMs ?? 0;
      const windowInSilence = audioEnd !== null && outgoing.sourceEndMs > audioEnd + 250;
      const alignmentMode =
        incoming.alignmentMode === "bar" ||
        incoming.alignmentMode === "beat" ||
        incoming.alignmentMode === "phrase"
          ? incoming.alignmentMode
          : null;
      const prevOverlap = i > 0 ? (manifest.tracks[i - 1]!.overlapToNextMs ?? 0) : 0;
      const outgoingPlayable = analyzerVersionLessThan(manifest.rendererVersion, "6.10.0")
        ? (outgoing.sourceEndMs - outgoing.sourceStartMs) /
          (outgoing.playbackRate > 0 ? outgoing.playbackRate : 1)
        : playableOutputMs(
            {
              sourceStartMs: outgoing.sourceStartMs,
              sourceEndMs: outgoing.sourceEndMs,
              playbackRate: outgoing.playbackRate,
              overlapToNextMs: outgoing.overlapToNextMs,
            },
            prevOverlap,
            manifest.rateRegionsVersion,
          );
      const overlapAtMs =
        overlap > 0
          ? Math.round(outgoing.timelineStartMs + outgoingPlayable - overlap)
          : null;
      const outOverlapStart =
        outgoing.sourceEndMs - outputToSourceMs(overlap, outgoing.playbackRate);
      const storedGrid = storedGridFromEvidence(
        evidence,
        outOverlapStart,
        incoming.sourceStartMs,
        outgoing.playbackRate,
        incoming.playbackRate,
        incoming.downbeatOffsetMs,
        incoming.alignmentPeriodMs ?? null,
      );
      const tailEnergy = evidence?.outgoingTailEnergy ?? 0;
      const headEnergy = evidence?.incomingHeadEnergy ?? 0;
      const lowOverlapSec =
        overlap > 0 && tailEnergy >= 0.25 && headEnergy >= 0.15
          ? Number((overlap / 1000).toFixed(2))
          : overlap > 0
            ? 0
            : null;
      const levelStepLu =
        overlapAtMs != null
          ? await measureLevelStepLu(
              this.runner,
              binaries.ffmpegPath,
              outputPath,
              overlapAtMs,
              durationMs,
              overlap,
            )
          : null;
      joins.push({
        order: i,
        outgoingTitle: outTrack?.title ?? outgoing.trackId,
        incomingTitle: inTrack?.title ?? incoming.trackId,
        template: outgoing.transitionTemplate,
        barCount: outgoing.barCount ?? null,
        phraseShape: outgoing.phraseShape ?? null,
        exitKind: outgoing.exitKind ?? null,
        mixOutMs: outgoing.mixOutMs ?? null,
        mixInMs: outgoing.mixInMs ?? null,
        incomingDropMs: outgoing.incomingDropMs ?? evidence?.incomingDropMs ?? null,
        outgoingLufs: outgoing.outgoingLufs ?? null,
        incomingLufs: outgoing.incomingLufs ?? null,
        outgoingGainDb: outgoing.gainDb,
        incomingGainDb: incoming.gainDb,
        camelotDistance:
          evidence != null
            ? joinCamelotDistance(evidence.outgoingCamelotKey, evidence.incomingCamelotKey)
            : (outgoing.camelotDistance ?? null),
        residualMs: storedGrid.residualMs,
        storedGridResidualMs: storedGrid.residualMs,
        residualKind: storedGrid.kind,
        evidenceSource: storedGrid.source,
        audioStatus: "unmeasured",
        levelStepLu,
        lowOverlapSec,
        outgoingRate: outgoing.playbackRate,
        incomingRate: incoming.playbackRate,
        downbeatOffsetMs: incoming.downbeatOffsetMs,
        alignmentPeriodMs: incoming.alignmentPeriodMs ?? null,
        alignmentMode,
        windowInSilence,
        overlapAtMs,
      });
    }
    const residualFail = joins.some(
      (join) =>
        (join.template === "phrase_mix" || join.template === "bass_swap") &&
        join.evidenceSource === "frozen-manifest" &&
        join.storedGridResidualMs != null &&
        Math.abs(join.storedGridResidualMs) > RENDER_CHECK_RESIDUAL_FAIL_MS,
    );
    const levelFail = joins.some((join) => {
      const matched = plannedLevelStepLu(
        join.outgoingLufs,
        join.incomingLufs,
        join.outgoingGainDb,
        join.incomingGainDb,
      );
      if (matched != null) {
        return Math.abs(matched) > RENDER_CHECK_LEVEL_STEP_FAIL_LU;
      }
      return false;
    });
    const failures = [
      ...interiorSilence.map((span) => `interior silence ${span.startMs}-${span.endMs}`),
      ...joins.filter((join) => join.windowInSilence).map((join) => `join ${join.order} window in silence`),
      ...(residualFail ? ["stored-grid residual above 40 ms"] : []),
      ...(levelFail ? ["planned LUFS step above 3 LU"] : []),
      ...(duration.status === "fail"
        ? [`output/plan duration error ${duration.errorMs} ms`]
        : []),
    ];
    const warningList = [
      ...(duration.status === "warning"
        ? [`output/plan duration error ${duration.errorMs} ms (preview)`]
        : []),
      ...joins
        .filter((join) => join.evidenceSource === "missing")
        .map((join) => `join ${join.order} stored-grid unmeasured (no frozen evidence)`),
      ...joins
        .filter((join) => join.audioStatus === "unmeasured")
        .map((join) => `join ${join.order} independent audio unmeasured`),
    ];
    return {
      renderJobId,
      outputPath,
      durationMs,
      plannedDurationMs,
      durationErrorMs: duration.errorMs,
      durationStatus: duration.status,
      interiorSilence,
      joins,
      failures,
      warnings: warningList,
      ok:
        interiorSilence.length === 0 &&
        joins.every((join) => !join.windowInSilence) &&
        !residualFail &&
        !levelFail &&
        duration.status !== "fail",
    };
  }

  list(limit?: number, cursor?: string, setPlanId?: string) {
    const page = this.jobs.list({ limit, cursor, setPlanId });
    return { jobs: page.jobs.map(toPublicJob), nextCursor: page.nextCursor };
  }

  cancel(
    renderJobId: string,
    confirm: true,
  ): { cancelled: boolean; renderJobId: string; status: RenderJob["status"] } {
    if (confirm !== true) {
      throw new DomainError("RENDER_FAILED", "cancel_render_job requires confirm=true");
    }
    const job = this.jobs.require(renderJobId);
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      return { cancelled: false, renderJobId: job.id, status: job.status };
    }
    this.aborts.get(job.id)?.abort();
    const updated = this.jobs.markCancelled(job.id);
    return { cancelled: true, renderJobId: updated.id, status: updated.status };
  }

  async waitForJob(renderJobId: string, timeoutMs = 120_000): Promise<RenderJob> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const job = this.getStatus(renderJobId);
      if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new DomainError("RENDER_FAILED", "Timed out waiting for render job", { retryable: true });
  }

  private pump(): void {
    if (this.stopped) {
      return;
    }
    while (this.running < this.settings.workerLimit && !this.stopped) {
      const claimed = this.jobs.claimNextQueued();
      if (!claimed) {
        return;
      }
      this.running += 1;
      void this.execute(claimed)
        .catch((error: unknown) => {
          this.logger.error({ err: error, jobId: claimed.id }, "Render job crashed");
        })
        .finally(() => {
          this.running -= 1;
          this.aborts.delete(claimed.id);
          this.pump();
        });
    }
  }

  private async execute(job: StoredRenderJob): Promise<void> {
    const controller = new AbortController();
    this.aborts.set(job.id, controller);
    try {
      const current = this.jobs.findById(job.id);
      if (!current || current.status === "cancelled") {
        return;
      }
      const binaries = requireFfmpeg(await this.detect());
      const stored = this.requirePlan(job.setPlanId);
      if (job.kind === "full") {
        this.validateFullPlan?.(job.setPlanId, {
          allowOverlongDuration: job.params.allowOverlongDuration,
        });
      }
      const tracksById = new Map(this.tracks.listAll().map((track) => [track.id, track]));
      const warnings: string[] = [...job.warnings];
      let segments: PreparedSegment[];
      let overlaps: number[];
      let relPath: string;
      let edgeFadeMs = job.params.edgeFadeMs ?? this.settings.edgeFadeMs;

      if (job.kind === "preview") {
        if (!job.transitionId) {
          throw new DomainError("INVALID_SET_PLAN", "Preview job is missing transitionId");
        }
        const pair = findTransitionPair(stored.plan, job.transitionId);
        if (!pair) {
          throw new DomainError("INVALID_SET_PLAN", "Preview transition is no longer on the plan");
        }
        const windowMs = job.params.windowMs ?? this.settings.previewWindowMs;
        const sliced = slicePreview(pair, windowMs, resolvePlanRateRegionsVersion(stored.plan).version);
        const outgoingTrack = this.requireTrack(pair.outgoing.trackId, tracksById);
        const incomingTrack = this.requireTrack(pair.incoming.trackId, tracksById);
        const outgoingSeg = await this.hydrateSegment(
          pair.outgoing,
          outgoingTrack,
          sliced.outgoing,
          0,
        );
        const incomingSeg = await this.hydrateSegment(
          pair.incoming,
          incomingTrack,
          sliced.incoming,
          (sliced.outgoing.sourceEndMs - sliced.outgoing.sourceStartMs) / pair.outgoing.playbackRate - sliced.overlapMs,
        );
        outgoingSeg.overlapToNextMs = sliced.overlapMs;
        incomingSeg.overlapToNextMs = null;
        incomingSeg.transitionId = null;
        incomingSeg.requestedTransitionType = null;
        segments = [outgoingSeg, incomingSeg];
        overlaps = [sliced.overlapMs];
        relPath = path.join(
          "cache",
          "previews",
          `${job.cacheKey ?? job.id}${DEFAULT_RENDER_OUTPUT_EXTENSION}`,
        );
        edgeFadeMs = 0;
      } else {
        const prepared: PreparedSegment[] = [];
        for (const entry of stored.plan.entries) {
          const track = this.requireTrack(entry.trackId, tracksById);
          prepared.push(
            await this.hydrateSegment(
              entry,
              track,
              {
                sourceStartMs: entry.sourceStartMs,
                sourceEndMs: entry.sourceEndMs,
                gainDb: entry.gainDb,
              },
              entry.timelineStartMs,
            ),
          );
        }
        segments = prepared;
        overlaps = stored.plan.entries
          .slice(0, -1)
          .map((entry) => entry.transitionToNext?.durationMs ?? 0);
        relPath = path.join("renders", `${job.id}${DEFAULT_RENDER_OUTPUT_EXTENSION}`);
      }

      for (const segment of segments) {
        try {
          assertPlaybackRate(segment.playbackRate, {
            allowExcessive: job.params.allowExcessiveTempo === true,
          });
        } catch (error) {
          throw isDomainError(error)
            ? error
            : new DomainError("PLAYBACK_RATE_OUT_OF_RANGE", String(error));
        }
        if (segment.requestedTransitionType === "double_drop") {
          warnings.push(
            `double_drop on ${segment.title} is rendered as a bass_swap.`,
          );
        }
      }

      const mixTypes: MixTransitionSpec[] = overlaps.map((_, index) => {
        const outgoing = segments[index];
        const incoming = segments[index + 1];
        const overlap = overlaps[index] ?? 0;
        const type =
          job.kind === "preview"
            ? (job.params.template ?? outgoing?.requestedTransitionType)
            : outgoing?.requestedTransitionType;
        let params = outgoing?.mixParams;
        if (type === "phrase_mix" && outgoing && incoming && overlap > 0) {
          const outAnalysis = this.analyses.findByTrackId(outgoing.trackId);
          const inAnalysis = this.analyses.findByTrackId(incoming.trackId);
          const outMs =
            outgoing.sourceEndMs - outputToSourceMs(overlap, outgoing.playbackRate);
          const shape = resolveRenderPhraseShape(
            params?.phraseShape,
            outgoing.exitKind,
            sectionAtMs(outAnalysis?.sections ?? [], outMs),
            sectionAtMs(inAnalysis?.sections ?? [], incoming.sourceStartMs),
          );
          params = { ...params, phraseShape: shape };
          if (shape === "sequential") {
            warnings.push(
              `Sequential drum hand-over on ${outgoing.title} → ${incoming.title} (${sequentialHandoffLabel(params.sequentialHandoff)}).`,
            );
          }
        }
        return toMixSpec(type, job.params.barCount, params);
      });
      if (mixTypes.some((item) => item.type !== "crossfade")) {
        requireAlignedFfmpeg(binaries);
      }

      for (let i = 0; i < overlaps.length; i += 1) {
        const outgoing = segments[i];
        const incoming = segments[i + 1];
        const overlap = overlaps[i] ?? 0;
        if (!outgoing || !incoming || overlap <= 0) {
          continue;
        }
        if (mixTypes[i]?.type === "crossfade") {
          continue;
        }
        // Resolved plans own source windows. Re-analysis at render time must not move their events.
        const recipe = stored.plan.entries.find((entry) => entry.id === outgoing.entryId)?.transitionToNext;
        const outOverlapStart =
          outgoing.sourceEndMs - outputToSourceMs(overlap, outgoing.playbackRate);
        const outAnalysis = this.analyses.findByTrackId(outgoing.trackId);
        const inAnalysis = this.analyses.findByTrackId(incoming.trackId);
        const outDrop = outAnalysis?.sections.find((section) => section.type === "drop");
        const inDrop = inAnalysis?.sections.find((section) => section.type === "drop");
        const phraseReady =
          outDrop?.startBar != null &&
          inDrop?.startBar != null &&
          outDrop.startBar % 8 === 0 &&
          inDrop.startBar % 8 === 0;
        const aligned = planAlignmentOffsetMs({
          outgoingDownbeatsMs: outgoing.downbeatTimesMs,
          incomingDownbeatsMs: incoming.downbeatTimesMs,
          outgoingOverlapStartMs: outOverlapStart,
          incomingOverlapStartMs: incoming.sourceStartMs,
          bpm: outgoing.analysisBpm ?? incoming.analysisBpm,
          outgoingRate: outgoing.playbackRate,
          incomingRate: incoming.playbackRate,
          targetBpm:
            typeof outgoing.targetBpm === "number"
              ? outgoing.targetBpm
              : (outgoing.analysisBpm ?? incoming.analysisBpm),
          outgoingDownbeatConfidence: outgoing.downbeatConfidence,
          incomingDownbeatConfidence: incoming.downbeatConfidence,
          outgoingPhraseOriginMs: phraseReady ? outDrop.startMs : null,
          incomingPhraseOriginMs: phraseReady ? inDrop.startMs : null,
        });
        incoming.downbeatOffsetMs =
          paramNumber(recipe?.parameters, "downbeatOffsetMs") ?? aligned.offsetMs;
        incoming.alignmentPeriodMs =
          paramNumber(recipe?.parameters, "alignmentPeriodMs") ?? aligned.periodMs;
        incoming.alignmentMode =
          recipe?.parameters.alignmentMode === "bar" ||
          recipe?.parameters.alignmentMode === "beat" ||
          recipe?.parameters.alignmentMode === "phrase"
            ? recipe.parameters.alignmentMode
            : aligned.mode;
        if (recipe?.parameters.recipeVersion === 1) {
          continue;
        }
        const applied = applyAlignmentOffset({
          incomingStartMs: incoming.sourceStartMs,
          incomingEndMs: incoming.sourceEndMs,
          outgoingEndMs: outgoing.sourceEndMs,
          offsetMs: aligned.offsetMs,
          periodMs: aligned.periodMs,
          incomingRate: incoming.playbackRate,
          outgoingRate: outgoing.playbackRate,
          overlapMs: overlap,
        });
        incoming.downbeatOffsetMs = applied.appliedOffsetMs;
        incoming.sourceStartMs = applied.incomingStartMs;
        outgoing.sourceEndMs = applied.outgoingEndMs;
        if (applied.movedOutgoingEnd && applied.overlapMs != null) {
          overlaps[i] = Math.round(applied.overlapMs);
          outgoing.overlapToNextMs = overlaps[i]!;
        }
      }

      await mkdir(this.config.outputRoot, { recursive: true });
      const absOut = path.resolve(this.config.outputRoot, relPath);
      if (!isPathInsideRoot(absOut, path.resolve(this.config.outputRoot))) {
        throw new DomainError("PATH_OUTSIDE_LIBRARY_ROOT", "Refusing to write outside outputRoot");
      }
      this.jobs.updateProgress(job.id, 0.02, "mixing");
      const timing = resolvePlanRateRegionsVersion(stored.plan);
      if (timing.unknownVersions.length > 0) {
        warnings.push(`Unknown rateRegionsVersion ${timing.unknownVersions.join(", ")} on plan ${stored.plan.id}`);
      }
      let rateRegionsVersion = timing.version === 2 ? 2 as const : undefined;
      if (rateRegionsVersion === 2 && !this.settings.rubberbandCliPath) {
        warnings.push("Join-only timing v2 needs Rubber Band R3; using overlap-only stretch.");
        rateRegionsVersion = undefined;
      }
      const mixTitle =
        job.kind === "preview" && segments.length >= 2
          ? `${trackCredit(segments[0]!.artist, segments[0]!.title)} → ${trackCredit(segments[1]!.artist, segments[1]!.title)}`
          : stored.plan.name;
      const mix = await renderMix(this.runner, binaries, {
        segments,
        overlapMs: overlaps,
        transitions: mixTypes,
        outputPath: absOut,
        sampleRateHz: this.settings.sampleRateHz,
        truePeakCeilingDb: this.settings.truePeakCeilingDb,
        loudnessTargetLufs: this.settings.loudnessTargetLufs,
        edgeFadeMs,
        isolatePrefix: job.kind !== "preview",
        rubberbandCliPath: this.settings.rubberbandCliPath,
        rateRegionsVersion,
        abortSignal: controller.signal,
        onProgress: (fraction) => {
          this.jobs.updateProgress(job.id, Math.min(0.95, 0.05 + fraction * 0.9), "mixing");
        },
        outputMetadata: mixTagsFromTracklist({
          title: mixTitle,
          album: stored.plan.name,
          date: stored.plan.createdAt.slice(0, 4),
          encodedBy: `dnb-crate ${RENDERER_VERSION}`,
          tracks: segments.map((segment) => ({
            artist: segment.artist,
            title: segment.title,
            startMs: segment.timelineStartMs,
          })),
        }),
      });
      warnings.push(...mix.warnings);
      const checksum = mix.checksumSha256 || (await sha256File(absOut));
      const posixRel = relPath.split(path.sep).join("/");
      const automation = collectAutomation(segments, mixTypes, rateRegionsVersion);
      const manifest: RenderManifestV1 = {
        rateRegionsVersion,
        schemaVersion: 1,
        rendererVersion: RENDERER_VERSION,
        applicationVersion: APP_VERSION,
        renderJobId: job.id,
        setPlanId: job.setPlanId,
        setPlanContentHash: sha256Json(stored.plan),
        kind: job.kind,
        outputFormat: DEFAULT_RENDER_OUTPUT_FORMAT,
        outputSampleRateHz: mix.sampleRateHz || this.settings.sampleRateHz,
        outputChannels: mix.channels || DEFAULT_RENDER_CHANNELS,
        outputDurationMs: mix.durationMs,
        outputChecksumSha256: checksum,
        integratedLufs: mix.integratedLufs,
        truePeakDb: mix.truePeakDb,
        loudnessTargetLufs: this.settings.loudnessTargetLufs,
        truePeakCeilingDb: this.settings.truePeakCeilingDb,
        ffmpegVersion: binaries.ffmpegVersion,
        ffprobeVersion: binaries.ffprobeVersion,
        invocation: mix.invocation,
        tracks: segments.map((segment, index) => {
          const params = job.kind === "preview" && (job.params.template != null || job.params.barCount != null) ? undefined : stored.plan.entries.find(entry => entry.id === segment.entryId)?.transitionToNext?.parameters;
          return {...toManifestTrack(
            segment,
            mixTypes[index],
            segments[index + 1],
            this.tracks.findById(segment.trackId),
            this.tracks.findById(segments[index + 1]?.trackId ?? ""),
            this.analyses.findByTrackId(segment.trackId),
            this.analyses.findByTrackId(segments[index + 1]?.trackId ?? ""),
          ),
          ...(typeof params?.appliedRecipeId === "string" ? {appliedRecipeId: params.appliedRecipeId} : {}),
          ...(typeof params?.appliedRecipeFingerprint === "string" ? {appliedRecipeFingerprint: params.appliedRecipeFingerprint} : {}),
          ...(typeof params?.recipeReuseMode === "string" ? {recipeReuseMode: params.recipeReuseMode} : {}),
          };
        }),
        joinEvidence: segments.slice(0, -1).map((outgoing, index) => {
          const incoming = segments[index + 1]!;
          return freezeJoinEvidence({
            outgoingTrackId: outgoing.trackId,
            incomingTrackId: incoming.trackId,
            outgoingAnalysisVersion: outgoing.analysisVersion,
            incomingAnalysisVersion: incoming.analysisVersion,
            outgoingBeatsMs: outgoing.beatTimesMs,
            incomingBeatsMs: incoming.beatTimesMs,
            outgoingSourceStartMs: outgoing.sourceStartMs,
            outgoingSourceEndMs: outgoing.sourceEndMs,
            incomingSourceStartMs: incoming.sourceStartMs,
            incomingSourceEndMs: incoming.sourceEndMs,
            outgoingCamelotKey: outgoing.camelotKey,
            incomingCamelotKey: incoming.camelotKey,
            outgoingAudioEndMs: outgoing.audioEndMs,
            outgoingTailEnergy: outgoing.tailEnergy,
            incomingHeadEnergy: incoming.headEnergy,
            incomingDropMs: incoming.incomingDropMs,
            recipeVersion: outgoing.recipeVersion,
            intent: outgoing.mixParams?.intent ?? null,
          });
        }),
        automation,
        warnings,
        createdAt: new Date().toISOString(),
      };
      if (job.kind === "full") {
        const planned = planDurationMs(stored.plan.entries);
        const delta = Math.abs(mix.durationMs - planned);
        if (delta > 1000) {
          warnings.push(
            `Output duration ${mix.durationMs}ms differs from plan ${planned}ms by ${delta}ms (tolerance 1000ms).`,
          );
          manifest.warnings = warnings;
        }
        if (this.jobs.findById(job.id)?.status !== "cancelled") {
          this.jobs.updateProgress(job.id, 0.96, "listen-encode");
          const listenRel = listenRenderRelPath(stored.plan.name, job.id);
          const listenAbs = path.resolve(this.config.outputRoot, listenRel);
          if (!isPathInsideRoot(listenAbs, path.resolve(this.config.outputRoot))) {
            warnings.push("Listen path escaped outputRoot; skipped the 16-bit copy.");
            manifest.warnings = warnings;
          } else {
            try {
              await encodeListenFlac(
                this.runner,
                binaries,
                absOut,
                listenAbs,
                controller.signal,
              );
              manifest.listenRootRelativePath = listenRel.split(path.sep).join("/");
              manifest.listenBitDepth = LISTEN_RENDER_BIT_DEPTH;
            } catch (error) {
              if (isAbortError(error) || this.jobs.findById(job.id)?.status === "cancelled") {
                throw error;
              }
              const message = error instanceof Error ? error.message : String(error);
              warnings.push(`Listen encode failed; 24-bit master is intact. ${message}`);
              manifest.warnings = warnings;
            }
          }
        }
      }
      const still = this.jobs.findById(job.id);
      if (still?.status === "cancelled") {
        return;
      }
      this.jobs.markSucceeded(job.id, {
        outputRelpath: posixRel,
        checksum,
        manifest,
        warnings,
      });
    } catch (error) {
      if (this.jobs.findById(job.id)?.status === "cancelled" || isAbortError(error)) {
        if (this.jobs.findById(job.id)?.status !== "cancelled") {
          this.jobs.markCancelled(job.id);
        }
        return;
      }
      const mapped = isDomainError(error)
        ? error
        : new DomainError(
            "RENDER_FAILED",
            error instanceof Error ? error.message : "Render failed",
            {
              retryable: false,
              cause: error,
            },
          );
      this.jobs.markFailed(job.id, {
        code: mapped.code,
        message: mapped.message,
        retryable: mapped.retryable,
      });
    }
  }

  private audioEndMsByTrackId(): Map<string, number> {
    const map = new Map<string, number>();
    for (const track of this.tracks.listAll()) {
      const end = this.analyses.findByTrackId(track.id)?.descriptors?.audioEndMs;
      if (typeof end === "number") {
        map.set(track.id, end);
      }
    }
    return map;
  }

  private firstDropStartMsByTrackId(): Map<string, number> {
    const map = new Map<string, number>();
    for (const track of this.tracks.listAll()) {
      const drop = this.analyses.findByTrackId(track.id)?.sections?.find((section) => section.type === "drop");
      if (drop && Number.isFinite(drop.startMs)) {
        map.set(track.id, drop.startMs);
      }
    }
    return map;
  }

  private async assessReadiness(
    plan: SetPlanV1,
    tracksById: Map<string, Track>,
    options: { allowLowConfidence?: boolean; allowExcessiveTempo?: boolean } = {},
  ): Promise<RenderReadiness> {
    const issues: ValidationIssue[] = [];
    const binaries = await this.detect();
    const ffmpegAvailable = binaries !== null;
    const ffprobeAvailable = binaries !== null;
    if (!binaries) {
      issues.push({
        code: "FFMPEG_UNAVAILABLE",
        message: "FFmpeg/ffprobe are not available; rendering cannot start.",
      });
    } else if (!ffmpegMixReady(binaries)) {
      issues.push({
        code: "FFMPEG_UNAVAILABLE",
        message: "FFmpeg is missing acrossfade, ebur128, or alimiter.",
      });
    }
    if (planHasAlignedTransition(plan) && !ffmpegAlignedReady(binaries)) {
      issues.push({
        code: "FFMPEG_UNAVAILABLE",
        message:
          "FFmpeg is missing atempo/lowpass/highpass/asplit/amix/afade needed for aligned mixes. Rubber Band is used for stretch when present.",
      });
    }
    const resolvedRoots = this.config.libraryRoots.map((root) => path.resolve(root));
    for (const entry of plan.entries) {
      const track = tracksById.get(entry.trackId);
      if (!track) {
        issues.push({
          code: "TRACK_NOT_FOUND",
          message: `Unknown track ${entry.trackId}`,
          entryId: entry.id,
          trackId: entry.trackId,
        });
        continue;
      }
      if (track.fileMissing) {
        issues.push({
          code: "AUDIO_FILE_UNAVAILABLE",
          message: `${track.title} is marked missing from disk`,
          entryId: entry.id,
          trackId: track.id,
        });
        continue;
      }
      try {
        const resolved = path.resolve(track.filePath);
        if (!isPathInsideAnyRoot(resolved, resolvedRoots)) {
          issues.push({
            code: "PATH_OUTSIDE_LIBRARY_ROOT",
            message: `${track.title} is outside the configured library roots`,
            entryId: entry.id,
            trackId: track.id,
          });
          continue;
        }
        const info = await stat(resolved);
        const fingerprint = await fingerprintFile(resolved, {
          size: info.size,
          mtimeMs: info.mtimeMs,
        });
        if (fingerprint !== track.fileFingerprint) {
          issues.push({
            code: "FINGERPRINT_MISMATCH",
            message: `${track.title} changed on disk since the last scan. Re-run scan_library before rendering.`,
            entryId: entry.id,
            trackId: track.id,
          });
        }
        if (entry.sourceEndMs > track.durationMs) {
          issues.push({
            code: "INVALID_TRIM",
            message: `Trim end exceeds catalog duration for ${track.title}`,
            entryId: entry.id,
            trackId: track.id,
          });
        }
        const overlap = entry.transitionToNext?.durationMs ?? 0;
        const entryIndex = plan.entries.indexOf(entry);
        const fromPrev =
          entryIndex > 0 ? (plan.entries[entryIndex - 1]!.transitionToNext?.durationMs ?? 0) : 0;
        const playable = playableOutputMs(entry, fromPrev, resolvePlanRateRegionsVersion(plan).version);
        const audioEnd = this.analyses.findByTrackId(track.id)?.descriptors?.audioEndMs;
        if (typeof audioEnd === "number" && overlap > 0) {
          const overlapSource = outputToSourceMs(overlap, entry.playbackRate);
          const overlapStart = entry.sourceEndMs - overlapSource;
          if (overlapStart > audioEnd) {
            issues.push({
              code: "WINDOW_IN_SILENCE",
              message: `${track.title} overlap sits entirely past audio end ${audioEnd}ms`,
              entryId: entry.id,
              trackId: track.id,
            });
          }
        }
        if (overlap > 0 && playable <= overlap) {
          issues.push({
            code: "INVALID_TRIM",
            message: `${track.title} is shorter than its planned overlap after tempo matching`,
            entryId: entry.id,
            trackId: track.id,
          });
        }
        try {
          assertPlaybackRate(entry.playbackRate, {
            allowExcessive: options.allowExcessiveTempo === true,
          });
        } catch (error) {
          issues.push({
            code: "PLAYBACK_RATE_OUT_OF_RANGE",
            message: error instanceof Error ? error.message : "Playback rate out of range",
            entryId: entry.id,
            trackId: track.id,
          });
        }
        const aligned = isAlignedType(entry.transitionToNext?.type);
        if (aligned && !options.allowLowConfidence) {
          this.pushAlignedIssues(issues, track, entry);
          const next = plan.entries[plan.entries.indexOf(entry) + 1];
          if (next) {
            const incoming = tracksById.get(next.trackId);
            if (incoming) {
              this.pushAlignedIssues(issues, incoming, next);
            }
          }
        }
      } catch {
        issues.push({
          code: "AUDIO_FILE_UNAVAILABLE",
          message: `Cannot read ${track.title} from disk`,
          entryId: entry.id,
          trackId: track.id,
        });
      }
    }
    const blocking = issues.filter((issue) => issue.code !== "FFMPEG_UNAVAILABLE");
    const ffmpegOk =
      ffmpegMixReady(binaries) && (!planHasAlignedTransition(plan) || ffmpegAlignedReady(binaries));
    return {
      ready: ffmpegOk && blocking.length === 0,
      ffmpegAvailable,
      ffprobeAvailable,
      ffmpegVersion: binaries?.ffmpegVersion ?? null,
      ffprobeVersion: binaries?.ffprobeVersion ?? null,
      issues,
    };
  }

  private async hydrateSegment(
    entry: SetPlanEntry,
    track: Track,
    window: { sourceStartMs: number; sourceEndMs: number; gainDb: number },
    timelineStartMs: number,
  ): Promise<PreparedSegment> {
    const resolved = path.resolve(track.filePath);
    const info = await stat(resolved);
    const fingerprint = await fingerprintFile(resolved, { size: info.size, mtimeMs: info.mtimeMs });
    if (fingerprint !== track.fileFingerprint) {
      throw new DomainError(
        "AUDIO_FILE_UNAVAILABLE",
        `${track.title} changed on disk since the last scan`,
        { details: { trackId: track.id } },
      );
    }
    const analysis = this.analyses.findByTrackId(track.id);
    return {
      filePath: resolved,
      sourceStartMs: window.sourceStartMs,
      sourceEndMs: window.sourceEndMs,
      gainDb: window.gainDb,
      playbackRate: entry.playbackRate,
      trackId: track.id,
      entryId: entry.id,
      fingerprint,
      artist: track.artist,
      title: track.title,
      timelineStartMs,
      overlapToNextMs: entry.transitionToNext?.durationMs ?? null,
      transitionId: entry.transitionToNext?.id ?? null,
      requestedTransitionType: entry.transitionToNext?.type ?? null,
      analysisVersion: analysis?.analyzerVersion ?? null,
      bpmConfidence: analysis?.bpmConfidence ?? null,
      downbeatTimesMs: analysis?.downbeatTimesMs ?? [],
      analysisBpm: analysis?.bpm ?? null,
      targetBpm:
        typeof entry.transitionToNext?.parameters.targetBpm === "number"
          ? entry.transitionToNext.parameters.targetBpm
          : null,
      downbeatOffsetMs: 0,
      alignmentPeriodMs: null,
      alignmentMode: null,
      downbeatConfidence: analysis?.downbeatConfidence ?? null,
      mixParams: mixParamsFromEntry(entry),
      mixOutMs: paramNumber(entry.transitionToNext?.parameters, "mixOutMs"),
      mixInMs: paramNumber(entry.transitionToNext?.parameters, "mixInMs"),
      exitKind: paramString(entry.transitionToNext?.parameters, "exitKind"),
      incomingDropMs: firstDropMs(analysis?.sections),
      beatTimesMs: analysis?.beatTimesMs ?? [],
      camelotKey: track.camelotKey,
      audioEndMs:
        typeof analysis?.descriptors?.audioEndMs === "number" ? analysis.descriptors.audioEndMs : null,
      tailEnergy: sectionEnergyAt(analysis?.sections, window.sourceEndMs),
      headEnergy: sectionEnergyAt(analysis?.sections, window.sourceStartMs),
      recipeVersion:
        typeof entry.transitionToNext?.parameters.recipeVersion === "number"
          ? entry.transitionToNext.parameters.recipeVersion
          : null,
    };
  }

  private assertPairAligned(outgoingId: string, incomingId: string, allowLow: boolean): void {
    if (allowLow) {
      return;
    }
    for (const trackId of [outgoingId, incomingId]) {
      const analysis = this.analyses.findByTrackId(trackId);
      if (
        !analysis ||
        analysis.gridRejected ||
        (analysis.bpmConfidence ?? 0) < MIN_ANALYSIS_CONFIDENCE
      ) {
        throw new DomainError(
          "LOW_CONFIDENCE_ANALYSIS",
          "Aligned preview needs a validated beat grid. Pass allowLowConfidence to override.",
          { details: { trackId } },
        );
      }
    }
  }

  private pushAlignedIssues(issues: ValidationIssue[], track: Track, entry: SetPlanEntry): void {
    const analysis = this.analyses.findByTrackId(track.id);
    if (
      !analysis ||
      analysis.gridRejected ||
      (analysis.bpmConfidence ?? 0) < MIN_ANALYSIS_CONFIDENCE
    ) {
      issues.push({
        code: "LOW_CONFIDENCE_ANALYSIS",
        message: `${track.title} has no validated beat grid for an aligned mix`,
        entryId: entry.id,
        trackId: track.id,
      });
    }
    const types = new Set(this.tracks.listCuePoints(track.id).map((cue) => cue.type));
    if (!types.has("intro_start") && !types.has("drop") && !types.has("outro_start")) {
      issues.push({
        code: "MISSING_CUE_POINTS",
        message: `${track.title} is missing intro/drop/outro cues required for aligned mixes`,
        entryId: entry.id,
        trackId: track.id,
      });
    }
  }

  private requirePlan(setPlanId: string) {
    const stored = this.plans.findById(setPlanId);
    if (!stored) {
      throw new DomainError("SET_PLAN_NOT_FOUND", `No set plan with id ${setPlanId}`);
    }
    return stored;
  }

  private requireTrack(trackId: string, tracksById: Map<string, Track>): Track {
    const track = tracksById.get(trackId);
    if (!track) {
      throw new DomainError("TRACK_NOT_FOUND", `No track with id ${trackId}`);
    }
    return track;
  }
}

function findTransitionPair(
  plan: SetPlanV1,
  transitionId: string,
): { outgoing: SetPlanEntry; incoming: SetPlanEntry } | null {
  for (let i = 0; i < plan.entries.length - 1; i += 1) {
    const outgoing = plan.entries[i]!;
    if (outgoing.transitionToNext?.id === transitionId) {
      return { outgoing, incoming: plan.entries[i + 1]! };
    }
  }
  return null;
}

export function slicePreview(
  pair: { outgoing: SetPlanEntry; incoming: SetPlanEntry },
  windowMs: number,
  rateRegionsVersion: 1 | 2 = 1,
): {
  outgoing: { sourceStartMs: number; sourceEndMs: number; gainDb: number };
  incoming: { sourceStartMs: number; sourceEndMs: number; gainDb: number };
  overlapMs: number;
} {
  const overlap = Math.max(1, pair.outgoing.transitionToNext?.durationMs ?? 0);
  const target = pair.outgoing.transitionToNext?.parameters.targetBpm;
  const bpm = typeof target === "number" && target > 0 ? target : 174;
  const each = Math.max((windowMs + overlap) / 2, overlap + 32 * 60_000 / bpm);
  const outRate = pair.outgoing.playbackRate > 0 ? pair.outgoing.playbackRate : 1;
  const inRate = pair.incoming.playbackRate > 0 ? pair.incoming.playbackRate : 1;
  const overlapMs = overlap;
  if (rateRegionsVersion === 2) {
    const outRegions = resolveRateRegions(
      pair.outgoing.sourceEndMs - pair.outgoing.sourceStartMs,
      outRate,
      0,
      overlap,
    );
    const inRegions = resolveRateRegions(
      pair.incoming.sourceEndMs - pair.incoming.sourceStartMs,
      inRate,
      overlap,
      0,
    );
    const outPlayable = outRegions.at(-1)!.outputEndMs;
    const inPlayable = inRegions.at(-1)!.outputEndMs;
    const outLen = Math.min(each, outPlayable);
    const inLen = Math.min(each, inPlayable);
    if (outLen < overlap || inLen < overlap) {
      throw new Error("Preview source windows cannot contain the complete transition");
    }
    return {
      outgoing: {
        sourceStartMs: pair.outgoing.sourceStartMs + outputPositionToSourceMs(outRegions, outPlayable - outLen),
        sourceEndMs: pair.outgoing.sourceEndMs,
        gainDb: pair.outgoing.gainDb,
      },
      incoming: {
        sourceStartMs: pair.incoming.sourceStartMs,
        sourceEndMs: pair.incoming.sourceStartMs + outputPositionToSourceMs(inRegions, inLen),
        gainDb: pair.incoming.gainDb,
      },
      overlapMs,
    };
  }
  const outPlayable = (pair.outgoing.sourceEndMs - pair.outgoing.sourceStartMs) / outRate;
  const inPlayable = (pair.incoming.sourceEndMs - pair.incoming.sourceStartMs) / inRate;
  const outLen = Math.min(each, outPlayable);
  const inLen = Math.min(each, inPlayable);
  if (outLen < overlap || inLen < overlap) {
    throw new Error("Preview source windows cannot contain the complete transition");
  }
  return {
    outgoing: {
      sourceStartMs: pair.outgoing.sourceEndMs - outLen * outRate,
      sourceEndMs: pair.outgoing.sourceEndMs,
      gainDb: pair.outgoing.gainDb,
    },
    incoming: {
      sourceStartMs: pair.incoming.sourceStartMs,
      sourceEndMs: pair.incoming.sourceStartMs + inLen * inRate,
      gainDb: pair.incoming.gainDb,
    },
    overlapMs,
  };
}

function toManifestTrack(
  segment: PreparedSegment,
  mix?: MixTransitionSpec,
  incoming?: PreparedSegment,
  outgoingTrack?: Track | null,
  incomingTrack?: Track | null,
  outgoingAnalysis?: { integratedLufs: number | null } | null,
  incomingAnalysis?: { integratedLufs: number | null } | null,
): RenderManifestTrack {
  const template = mix
    ? mix.type === "phrase_mix"
      ? "phrase_mix"
      : mix.type === "bass_swap"
        ? "bass_swap"
        : "equal_power_crossfade"
    : segment.overlapToNextMs && segment.overlapToNextMs > 0
      ? "equal_power_crossfade"
      : "none";
  return {
    trackId: segment.trackId,
    sourceFingerprint: segment.fingerprint,
    entryId: segment.entryId,
    sourceStartMs: segment.sourceStartMs,
    sourceEndMs: segment.sourceEndMs,
    timelineStartMs: segment.timelineStartMs,
    playbackRate: segment.playbackRate,
    gainDb: segment.gainDb,
    overlapToNextMs: segment.overlapToNextMs,
    transitionId: segment.transitionId,
    transitionTemplate: segment.overlapToNextMs && segment.overlapToNextMs > 0 ? template : "none",
    requestedTransitionType: segment.requestedTransitionType,
    analysisVersion: segment.analysisVersion,
    bpmConfidence: segment.bpmConfidence,
    downbeatOffsetMs: incoming?.downbeatOffsetMs ?? segment.downbeatOffsetMs,
    alignmentPeriodMs: incoming?.alignmentPeriodMs ?? segment.alignmentPeriodMs,
    alignmentMode: incoming?.alignmentMode ?? segment.alignmentMode,
    barCount: segment.mixParams?.barCount ?? mix?.barCount ?? null,
    phraseShape: segment.mixParams?.phraseShape ?? null,
    sequentialHandoff: segment.mixParams?.sequentialHandoff ?? "legacy",
    landingFadeBars: segment.mixParams?.landingFadeBars ?? null,
    landingCarryBars: segment.mixParams?.landingCarryBars ?? null,
    landingIncomingFadeBars: segment.mixParams?.landingIncomingFadeBars ?? null,
    exitKind: segment.exitKind,
    mixOutMs: segment.mixOutMs,
    mixInMs: segment.mixInMs,
    incomingDropMs: incoming?.incomingDropMs ?? segment.incomingDropMs,
    outgoingLufs: outgoingAnalysis?.integratedLufs ?? null,
    incomingLufs: incomingAnalysis?.integratedLufs ?? null,
    camelotDistance: joinCamelotDistance(outgoingTrack?.camelotKey ?? null, incomingTrack?.camelotKey ?? null),
  };
}

function isAlignedType(type: TransitionType | null | undefined): boolean {
  return type === "phrase_mix" || type === "bass_swap" || type === "double_drop";
}

function planHasAlignedTransition(plan: SetPlanV1): boolean {
  return plan.entries.some((entry) => isAlignedType(entry.transitionToNext?.type));
}

function mixParamsFromEntry(entry: SetPlanEntry): Partial<MixPresetParams> | null {
  const raw = entry.transitionToNext?.parameters;
  if (!raw) {
    return null;
  }
  const num = (key: string): number | undefined =>
    typeof raw[key] === "number" ? raw[key] : undefined;
  return {
    barCount:
      raw.barCount === 32 ? 32 : raw.barCount === 16 ? 16 : raw.barCount === 8 ? 8 : undefined,
    targetBpm: num("targetBpm") ?? null,
    crossoverHz: num("crossoverHz"),
    swapAtBar: num("swapAtBar"),
    lowHandoverBar: num("lowHandoverBar"),
    rampMs: num("rampMs"),
    lowAttenuationDb: num("lowAttenuationDb"),
    midDipDb: num("midDipDb"),
    mixInMs: num("mixInMs"),
    incomingDropMs: num("incomingDropMs"),
    sequentialHandoff: raw.sequentialHandoff === "early" || raw.sequentialHandoff === "supported" ? raw.sequentialHandoff : "legacy",
    ...(raw.landingFadeBars === 2 || raw.landingFadeBars === 4 || raw.landingFadeBars === 8
      ? { landingFadeBars: raw.landingFadeBars } : {}),
    ...(raw.landingCarryBars === 2 || raw.landingCarryBars === 3.5 || raw.landingCarryBars === 4 || raw.landingCarryBars === 4.5
      ? { landingCarryBars: raw.landingCarryBars } : {}),
    ...(raw.landingIncomingFadeBars === 8 || raw.landingIncomingFadeBars === 16 || raw.landingIncomingFadeBars === 32
      ? { landingIncomingFadeBars: raw.landingIncomingFadeBars } : {}),
    phraseShape:
      raw.phraseShape === "sequential" ||
      raw.phraseShape === "complementary" ||
      raw.phraseShape === "landing"
        ? raw.phraseShape
        : undefined,
    intent:
      raw.intent === "sustain" || raw.intent === "lift" || raw.intent === "breather"
        ? raw.intent
        : undefined,
  };
}

function toMixSpec(
  type: TransitionType | "crossfade" | "phrase_mix" | "bass_swap" | null | undefined,
  barCount?: 8 | 16 | 32,
  params?: Partial<MixPresetParams> | null,
): MixTransitionSpec {
  const bars = normalizePhraseBars(barCount ?? params?.barCount);
  if (type === "phrase_mix") {
    const clamped = clampMixPresetParams({ ...params, barCount: bars }, bars);
    return { type: "phrase_mix", barCount: bars, params: clamped };
  }
  if (type === "bass_swap" || type === "double_drop") {
    const clamped = clampMixPresetParams({ ...params, barCount: bars }, bars);
    return { type: "bass_swap", barCount: bars, bassSwap: clamped, params: clamped };
  }
  return { type: "crossfade" };
}

function collectAutomation(
  segments: PreparedSegment[],
  mixTypes: MixTransitionSpec[],
  rateRegionsVersion?: 2,
): AutomationEvent[] {
  const events: AutomationEvent[] = [];
  for (let i = 0; i < mixTypes.length; i += 1) {
    const outgoing = segments[i]!;
    const overlap = outgoing.overlapToNextMs ?? 0;
    if (overlap <= 0) {
      continue;
    }
    const fromPrev = i > 0 ? (segments[i - 1]!.overlapToNextMs ?? 0) : 0;
    const start = outgoing.timelineStartMs + playableOutputMs(outgoing, fromPrev, rateRegionsVersion) - overlap;
    const spec = mixTypes[i]!;
    const bars = normalizePhraseBars(spec.barCount);
    const barMs = overlap / bars;
    const expanded = expandPreset(spec.type, spec.params ?? spec.bassSwap, bars, barMs);
    for (const ev of expanded) {
      events.push({
        ...ev,
        atMs: start + (ev.atMs ?? 0),
        durationMs: ev.durationMs ?? 0,
      });
    }
  }
  return events;
}
