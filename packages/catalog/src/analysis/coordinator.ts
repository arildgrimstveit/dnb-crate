import {
  attachBarIndices,
  dspAnalyzer,
  type AnalyzerResult,
  type PcmAudio,
} from "@dnb-crate/audio-analysis";
import {
  DEFAULT_ANALYSIS_ENGINE,
  DomainError,
  isDomainError,
  MIN_ANALYSIS_CONFIDENCE,
  reconstructGrid,
  resolveCanonicalBpm,
  type AnalysisJob,
  type AppConfig,
  type Logger,
  type SuggestedCue,
} from "@dnb-crate/domain";
import {
  detectFfmpeg,
  parseEbur128,
  type FfmpegBinaries,
  type ProcessRunner,
} from "@dnb-crate/audio-renderer";

import type { AnalysisJobRepository } from "../analysis-job-repository.ts";
import type { AnalysisRepository, StoredTrackAnalysis } from "../analysis-repository.ts";
import { dspFreshness, dspInputIdentity } from "./dsp-identity.ts";
import { loadPcmForAnalysis } from "./load-pcm.ts";
import type { TrackRepository } from "../repository.ts";

import { probeKeyEngine, type KeyEngineProbe } from "./key-engine.ts";
import { KeyAnalysisService } from "./key-service.ts";

/**
 * Drop every grid-indexed feature from a stored analysis row after the grid
 * origin moved (F9, repository review 2026-10-08): per-bar series, per-beat
 * drum profiles, bar-numbered sections, beat-snapped cues, and the
 * grid-relative groove/phase descriptors all describe the PREVIOUS grid and
 * must never be interpreted against the new origin. Time-based
 * measurements (loudness, bands, chroma, energy/danceability descriptors,
 * waveform summary, audio bounds, key candidates) are grid-independent and
 * survive until the next full analysis recomputes the rest.
 */
export function stripGridIndexedFeatures(row: StoredTrackAnalysis): StoredTrackAnalysis {
  const descriptors = row.descriptors;
  return {
    ...row,
    sections: [],
    suggestedCues: [],
    descriptors: descriptors
      ? {
          ...descriptors,
          bars: null,
          tempoEvidence: null,
          grooveSyncopation: null,
          backbeatConcentration: null,
          gridPhaseMaxErrorMs: null,
          gridPhaseSuspect: null,
          beatPhaseHistogram: null,
        }
      : descriptors,
  };
}

export class AnalysisCoordinator {
  canRun: () => boolean = () => true;
  /** R12: current worker-owner claim token (null when deposed); claims and
   * completion writes are fenced against it. */
  ownerToken: () => string | null = () => null;
  private readonly active = new Set<Promise<void>>();
  private running = 0;
  private abort = new AbortController();
  private activeJobId: string | null = null;
  private stopped = false;
  private binaries: FfmpegBinaries | null | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly tracks: TrackRepository,
    private readonly analyses: AnalysisRepository,
    private readonly jobs: AnalysisJobRepository,
    private readonly runner: ProcessRunner,
    private readonly logger: Logger,
  ) {}

  recoverInterrupted(): number {
    return this.jobs.failRunningAsInterrupted();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await Promise.all(this.active);
  }

  kick(): void {
    if (this.activeJobId && this.jobs.require(this.activeJobId).status === "cancelled")
      this.abort.abort();
    this.pump();
  }

  cancel(id: string): void {
    this.jobs.cancel(id);
    if (this.activeJobId === id) this.abort.abort();
  }

  start(trackIds: string[], options: { forceDsp?: boolean } = {}): { job: AnalysisJob } {
    if (trackIds.length === 0) {
      throw new DomainError("ANALYSIS_FAILED", "No tracks to analyze");
    }
    for (const id of trackIds) {
      const track = this.tracks.findById(id);
      if (!track) {
        throw new DomainError("TRACK_NOT_FOUND", `No track with id ${id}`);
      }
    }
    const resolved = [DEFAULT_ANALYSIS_ENGINE];
    const job = this.jobs.insertQueued(trackIds, resolved, { forceDsp: options.forceDsp === true });
    this.kick();
    return { job };
  }

  getStatus(analysisJobId?: string): { jobs: AnalysisJob[] } {
    if (analysisJobId) {
      return { jobs: [this.jobs.require(analysisJobId)] };
    }
    return { jobs: this.jobs.list() };
  }

  async waitForJob(analysisJobId: string, timeoutMs = 120_000): Promise<AnalysisJob> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const job = this.jobs.require(analysisJobId);
      if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new DomainError("ANALYSIS_FAILED", "Timed out waiting for analysis job", {
      retryable: true,
    });
  }

  setBeatAnchor(trackId: string, positionMs: number): void {
    const track = this.tracks.findById(trackId);
    if (!track) {
      throw new DomainError("TRACK_NOT_FOUND", `No track with id ${trackId}`);
    }
    if (positionMs > track.durationMs) {
      throw new DomainError("INVALID_BEAT_GRID", "Beat anchor is past the track duration");
    }
    this.analyses.upsertBeatAnchor(trackId, positionMs);
    const existing = this.analyses.findByTrackId(trackId);
    const canonical = resolveCanonicalBpm(track, existing);
    if (!canonical.bpm) {
      // No tempo to reconstruct a grid from: the stored grid-indexed features
      // now describe the previous grid, so drop them rather than leave them
      // to be interpreted against a new origin. The next analysis pass
      // recomputes them (the anchor is part of the input identity).
      if (existing) {
        this.analyses.upsert(stripGridIndexedFeatures(existing));
      }
      return;
    }
    const grid = reconstructGrid(positionMs, canonical.bpm, track.durationMs);
    if (existing) {
      this.analyses.upsert(
        stripGridIndexedFeatures({
          ...existing,
          bpm: canonical.bpm,
          bpmConfidence: Math.max(existing.bpmConfidence ?? 0, MIN_ANALYSIS_CONFIDENCE),
          beatTimesMs: grid.beatTimesMs,
          downbeatTimesMs: grid.downbeatTimesMs,
          beatAnchorMs: positionMs,
          gridRejected: false,
          gridRejectionReason: null,
          gridSource: "anchor",
        }),
      );
    }
  }

  private async detect(): Promise<FfmpegBinaries | null> {
    if (this.binaries !== undefined) {
      return this.binaries;
    }
    this.binaries = await detectFfmpeg(this.runner, {
      ffmpegPath: this.config.ffmpegPath ?? "ffmpeg",
      ffprobePath: this.config.ffprobePath ?? "ffprobe",
    });
    return this.binaries;
  }

  private pump(): void {
    if (this.stopped || !this.canRun() || this.running > 0) {
      return;
    }
    const claimed = this.jobs.claimNextQueued(this.ownerToken());
    if (!claimed) {
      return;
    }
    this.running += 1;
    this.activeJobId = claimed.id;
    this.abort = new AbortController();
    const task = this.execute(claimed)
      .catch((error: unknown) => {
        this.logger.error({ err: error, jobId: claimed.id }, "Analysis job crashed");
      })
      .finally(() => {
        this.active.delete(task);
        this.running -= 1;
        this.activeJobId = null;
        this.pump();
      });
    this.active.add(task);
  }

  private async execute(job: AnalysisJob): Promise<void> {
    const completed: string[] = [];
    const failed: string[] = [];
    // Q02: prefetched PCM carries the fingerprint observed when its decode
    // was QUEUED, so a file change between decode and analysis is detected
    // even when the prefetch window is long.
    const pcmCache = new Map<string, { pcm: Promise<PcmAudio>; fingerprint: string }>();
    // S5: the claim context captured at claim time. The job ROW is the
    // authority: after a takeover, recovery marks this job interrupted (or
    // the new owner re-claims it under a different token), so
    // isClaimCurrent goes false and this owner stops WRITING catalog
    // evidence — analysis rows, analyzed metadata, stages — for work
    // nobody owns anymore. Local `stopped` (graceful close) is NOT claim
    // loss: in-flight jobs deliberately finish during close under the
    // still-held claim. The terminal-row fence (R12) remains the second
    // defense.
    const claimToken = this.ownerToken();
    const claimCurrent = () =>
      this.jobs.require(job.id).status !== "cancelled" &&
      this.jobs.isClaimCurrent(job.id, claimToken);
    try {
      this.binaries = undefined;
      const binaries = await this.detect();
      let keyProbe: KeyEngineProbe = { engine: null, command: null, available: false };
      if (this.config.analysis?.keyAnalysis !== "off") {
        try {
          keyProbe = await probeKeyEngine(this.config, this.runner);
        } catch (error) {
          keyProbe.reason =
            "CONFIG_INVALID: keyfinderPath is not a usable KeyFinder executable. Correct keyfinderPath and retry analysis.";
          this.logger.warn({ err: error }, "KeyFinder configuration invalid");
        }
      }
      const keys = new KeyAnalysisService(this.config, this.tracks, this.analyses, this.runner);
      const prefetchN = this.config.analysis?.prefetch ?? 1;
      const queueDecode = (trackId: string): void => {
        if (pcmCache.has(trackId)) {
          return;
        }
        const track = this.tracks.findById(trackId);
        if (!track || track.fileMissing || this.dspCurrent(trackId)) {
          return;
        }
        const decoded = loadPcmForAnalysis(
          track.filePath,
          this.runner,
          binaries,
          this.abort.signal,
        );
        // Observe failures immediately, but preserve the rejection for this track's turn.
        void decoded.catch(() => undefined);
        pcmCache.set(trackId, { pcm: decoded, fingerprint: track.fileFingerprint });
      };
      for (let i = 0; i < job.trackIds.length; i += 1) {
        if (this.stopped || this.jobs.require(job.id).status === "cancelled") {
          this.jobs.markFailed(
            job.id,
            {
              code: "ANALYSIS_FAILED",
              message: "Analysis job stopped before completion",
              retryable: true,
            },
            completed,
            failed,
            this.ownerToken(),
          );
          return;
        }
        // S5: a deposed owner aborts BEFORE writing any catalog evidence
        // for this track. The recovery owner owns the job now.
        if (!claimCurrent()) {
          this.logger.warn(
            { jobId: job.id },
            "Analysis claim lost to a takeover; stopping without writing evidence",
          );
          return;
        }
        const trackId = job.trackIds[i]!;
        if (prefetchN > 0) {
          for (let k = 1; k <= prefetchN && i + k < job.trackIds.length; k += 1) {
            queueDecode(job.trackIds[i + k]!);
          }
        }
        try {
          if (job.forceDsp || !this.dspCurrent(trackId)) {
            // T2: the claim predicate travels INTO analyzeTrack - every
            // evidence write (analysis row, metadata, cues) is gated after
            // the expensive work, inside the method that performs it.
            // Q02: the stage is stamped with the inputs the evidence was
            // ACTUALLY computed under (captured before the expensive work,
            // never reread after it), and superseded results are discarded
            // and retried once under the current inputs.
            const prefetched = pcmCache.get(trackId);
            const revision = await this.analyzeTrack(trackId, binaries, prefetched, claimCurrent);
            if (!claimCurrent()) {
              pcmCache.delete(trackId);
              return;
            }
            if (revision.superseded) {
              this.logger.warn(
                { trackId },
                "Analysis inputs changed during computation; discarding result and retrying under current inputs",
              );
              // A file change also invalidates the prefetched PCM: decode fresh.
              pcmCache.delete(trackId);
              const retry = await this.analyzeTrack(trackId, binaries, undefined, claimCurrent);
              if (!claimCurrent()) {
                return;
              }
              if (retry.superseded) {
                // Inputs moved again (continuous editing): leave the
                // evidence unpublished. The scope machinery rediscovers the
                // track on the next run; nothing stale is stamped current.
                this.logger.warn(
                  { trackId },
                  "Analysis inputs changed again; leaving evidence unpublished for the next run",
                );
              } else {
                this.stampDspStage(trackId, retry);
              }
            } else {
              this.stampDspStage(trackId, revision);
            }
          }
          completed.push(trackId);
        } catch (error) {
          failed.push(trackId);
          if (claimCurrent()) {
            this.tracks.setAnalysisStatus(trackId, "failed");
          }
          this.logger.warn({ err: error, trackId }, "Track analysis failed");
        }
        if (this.tracks.findById(trackId) && !this.abort.signal.aborted && claimCurrent())
          await keys.analyze(trackId, keyProbe, this.abort.signal, claimCurrent);
        pcmCache.delete(trackId);
        this.jobs.updateProgress(job.id, (i + 1) / job.trackIds.length, completed, failed);
        if ((i + 1) % 25 === 0) {
          this.logger.info(
            { jobId: job.id, done: i + 1, total: job.trackIds.length },
            "Analysis progress",
          );
        }
      }
      // R12: a deposed owner discards its result instead of writing over
      // takeover recovery; the repository fence covers the write race.
      if (this.ownerToken() == null) {
        this.logger.warn(
          { jobId: job.id },
          "Analysis finished after worker ownership was lost; discarding result",
        );
        return;
      }
      this.jobs.markSucceeded(job.id, completed, failed, this.ownerToken());
    } catch (error) {
      const mapped = isDomainError(error)
        ? error
        : new DomainError(
            "ANALYSIS_FAILED",
            error instanceof Error ? error.message : "Analysis failed",
            { retryable: true, cause: error },
          );
      this.jobs.markFailed(
        job.id,
        { code: mapped.code, message: mapped.message, retryable: mapped.retryable },
        completed,
        failed,
        this.ownerToken(),
      );
    } finally {
      // Pending decodes own temporary files and must settle before shutdown completes.
      await Promise.allSettled([...pcmCache.values()].map((entry) => entry.pcm));
    }
  }

  private dspCurrent(trackId: string): boolean {
    const track = this.tracks.findById(trackId);
    const stage = this.analyses.getStage(trackId, "dsp");
    const row = this.analyses.findByTrackId(trackId, "dnb-crate-dsp");
    // R10: one shared freshness decision (dspFreshness) — the workflow's
    // scheduling and the repository's stale-scope selection evaluate the
    // same contract so tempo-bound, anchor, reference-lock, and pending
    // changes cannot look current to one caller and stale to another.
    return dspFreshness({
      hasAnalysisRow: Boolean(track && row),
      analyzerVersion: row?.analyzerVersion ?? null,
      analysisStatus: track?.analysisStatus ?? null,
      fileFingerprint: track?.fileFingerprint ?? null,
      stageState: stage?.state ?? null,
      stageFingerprint: stage?.fingerprint ?? null,
      stageIdentity: stage?.identity ?? null,
      referenceBpm: row?.referenceBpm ?? null,
      trackBpm: track?.bpm ?? null,
      trackBpmSource: track?.bpmSource ?? null,
      beatAnchorMs: this.analyses.getBeatAnchorMs(trackId),
      bpmMin: this.config.analysis?.bpmMin,
      bpmMax: this.config.analysis?.bpmMax,
    }).current;
  }

  /** Q02: stamp the DSP stage with the inputs the evidence was actually
   * computed under - captured values, never reread post-computation. */
  private stampDspStage(
    trackId: string,
    revision: { beatAnchorMs: number | null; fileFingerprint: string },
  ): void {
    this.analyses.setStage(trackId, "dsp", {
      state: "succeeded",
      fingerprint: revision.fileFingerprint,
      identity: dspInputIdentity({
        beatAnchorMs: revision.beatAnchorMs,
        bpmMin: this.config.analysis?.bpmMin,
        bpmMax: this.config.analysis?.bpmMax,
      }),
      reason: null,
    });
  }

  private async analyzeTrack(
    trackId: string,
    binaries: FfmpegBinaries | null,
    preloaded?: { pcm: Promise<PcmAudio>; fingerprint: string },
    claimCurrent?: () => boolean,
  ): Promise<{ beatAnchorMs: number | null; fileFingerprint: string; superseded: boolean }> {
    const track = this.tracks.findById(trackId);
    if (!track) {
      throw new DomainError("TRACK_NOT_FOUND", `No track with id ${trackId}`);
    }
    if (track.fileMissing) {
      throw new DomainError("AUDIO_FILE_UNAVAILABLE", `${track.title} is marked missing`);
    }
    // Q02: capture the input revision BEFORE any expensive work. The
    // prefetched fingerprint (observed when its decode was queued) is
    // authoritative when present - the PCM belongs to those bytes.
    const inputRevision = {
      beatAnchorMs: this.analyses.getBeatAnchorMs(trackId),
      fileFingerprint: preloaded?.fingerprint ?? track.fileFingerprint,
    };
    const pcm = await (preloaded?.pcm ??
      loadPcmForAnalysis(track.filePath, this.runner, binaries, this.abort.signal));
    const anchor = inputRevision.beatAnchorMs;
    // Reference locks are manual/published assertions only. The analyzed
    // writeback echo is the analyzer's own result — passing it back as a
    // reference would store an input the freshness contract (correctly)
    // ignores, marking the row stale forever (F9).
    const referenceBpm =
      track.bpm != null && (track.bpmSource === "published" || track.bpmSource === "manual")
        ? track.bpm
        : undefined;
    const dsp = dspAnalyzer.analyze(pcm, {
      durationMs: track.durationMs,
      beatAnchorMs: anchor,
      referenceBpm,
      dnbBpmMin: this.config.analysis?.bpmMin,
      dnbBpmMax: this.config.analysis?.bpmMax,
    });
    const loudnessPromise = binaries
      ? this.runner.run({
          executable: binaries.ffmpegPath,
          timeoutMs: 180_000,
          abortSignal: this.abort.signal,
          args: [
            "-nostdin",
            "-hide_banner",
            "-i",
            track.filePath,
            "-filter_complex",
            "ebur128=peak=true",
            "-f",
            "null",
            "-",
          ],
        })
      : Promise.resolve(null);
    const loudness = await loudnessPromise;
    let integratedLufs: number | null = null;
    let truePeakDb: number | null = null;
    if (loudness) {
      const parsed = parseEbur128(loudness.stderr);
      integratedLufs = parsed.integratedLufs;
      truePeakDb = parsed.truePeakDb;
    }
    // T2 (12 October review): ALL catalog evidence writes for this track
    // happen after the expensive decode/DSP/loudness work, gated on the
    // claim. A takeover during the subprocess window leaves no analysis
    // row, no analyzed metadata, no cues - the recovery owner's job is the
    // only writer.
    if (claimCurrent && !claimCurrent()) {
      this.logger.warn(
        { trackId },
        "Analysis claim lost during DSP/loudness; discarding result without writing evidence",
      );
      return { ...inputRevision, superseded: false };
    }
    // Q02 (12 October roadmap): if any input the evidence was computed
    // under changed during the subprocess window, DISCARD the result
    // instead of publishing it under a post-hoc identity. The caller
    // retries under the current inputs.
    const currentTrack = this.tracks.findById(trackId);
    const currentReferenceBpm =
      currentTrack?.bpm != null &&
      (currentTrack.bpmSource === "published" || currentTrack.bpmSource === "manual")
        ? currentTrack.bpm
        : undefined;
    const superseded =
      this.analyses.getBeatAnchorMs(trackId) !== inputRevision.beatAnchorMs ||
      currentTrack?.fileFingerprint !== inputRevision.fileFingerprint ||
      currentReferenceBpm !== referenceBpm;
    if (superseded) {
      return { ...inputRevision, superseded: true };
    }
    this.storeResult(trackId, dsp, anchor, integratedLufs, truePeakDb, referenceBpm ?? null);
    const preferred =
      this.analyses.findByTrackId(trackId) ??
      this.analyses.findByTrackId(trackId, dsp.analyzerName);
    if (preferred) {
      this.tracks.applyAnalyzedMetadata(trackId, {
        bpm: preferred.gridRejected ? null : preferred.bpm,
        musicalKey: null,
        preserveKey: true,
        gridRejected: preferred.gridRejected,
      });
    } else {
      this.tracks.setAnalysisStatus(trackId, "complete");
    }
    if (preferred) {
      this.tracks.insertAnalyzedCuesIfAbsent(trackId, preferred.suggestedCues);
    }
    return { ...inputRevision, superseded: false };
  }

  private storeResult(
    trackId: string,
    result: AnalyzerResult,
    anchor: number | null,
    integratedLufs: number | null,
    truePeakDb: number | null,
    referenceBpm: number | null = null,
  ): StoredTrackAnalysis {
    const cues = attachBarIndices(result.suggestedCues, result.beatTimesMs);
    const suggestedCues: SuggestedCue[] = cues.map((cue) => ({
      type: cue.type,
      positionMs: cue.positionMs,
      beatIndex: cue.beatIndex,
      barIndex: cue.barIndex,
      confidence: cue.confidence,
    }));
    const descriptors = result.descriptors
      ? {
          ...result.descriptors,
          integratedLufs: integratedLufs ?? result.descriptors.integratedLufs,
          truePeakDb: truePeakDb ?? result.descriptors.truePeakDb,
        }
      : null;
    return this.analyses.upsert({
      trackId,
      analyzerName: result.analyzerName,
      analyzerVersion: result.analyzerVersion,
      bpm: result.bpm,
      bpmConfidence: result.bpmConfidence,
      bpmRaw: result.bpmRaw,
      beatTimesMs: result.beatTimesMs,
      downbeatTimesMs: result.downbeatTimesMs,
      gridRejected: result.gridRejected,
      gridRejectionReason: result.gridRejectionReason,
      gridSource: result.gridSource,
      musicalKey: result.musicalKey,
      keyConfidence: result.keyConfidence,
      keyMode: result.keyMode,
      camelotKey: result.camelotKey,
      keyCandidates: result.keyCandidates ?? result.descriptors?.keyCandidates ?? null,
      tempoStability: result.tempoStability,
      downbeatConfidence: result.downbeatConfidence,
      integratedLufs,
      truePeakDb,
      lowBandEnergy: result.lowBandEnergy,
      midBandEnergy: result.midBandEnergy,
      highBandEnergy: result.highBandEnergy,
      waveformSummary: result.waveformSummary,
      beatAnchorMs: anchor,
      descriptors,
      engineRuntimeMs: result.engineRuntimeMs,
      analyzedAt: new Date().toISOString(),
      suggestedCues,
      sections: result.sections,
      referenceBpm,
    });
  }
}
