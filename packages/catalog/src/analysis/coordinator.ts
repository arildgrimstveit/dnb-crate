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
  reconstructGrid,
  resolveCanonicalBpm,
  type AnalysisEngineId,
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
import { loadPcmForAnalysis } from "./load-pcm.ts";
import { mergeAnalyzerResults } from "./merger.ts";
import { runPythonAnalyzer } from "./python-engine.ts";
import type { TrackRepository } from "../repository.ts";

export class AnalysisCoordinator {
  private running = 0;
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

  stop(): void {
    this.stopped = true;
  }

  kick(): void {
    this.pump();
  }

  start(
    trackIds: string[],
    engines: AnalysisEngineId[] = [DEFAULT_ANALYSIS_ENGINE],
  ): { job: AnalysisJob } {
    if (trackIds.length === 0) {
      throw new DomainError("ANALYSIS_FAILED", "No tracks to analyze");
    }
    for (const id of trackIds) {
      const track = this.tracks.findById(id);
      if (!track) {
        throw new DomainError("TRACK_NOT_FOUND", `No track with id ${id}`);
      }
      this.tracks.setAnalysisStatus(id, "pending");
    }
    const resolved = engines.length > 0 ? engines : [DEFAULT_ANALYSIS_ENGINE];
    const job = this.jobs.insertQueued(trackIds, resolved);
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
      return;
    }
    const grid = reconstructGrid(positionMs, canonical.bpm, track.durationMs);
    if (existing) {
      this.analyses.upsert({
        ...existing,
        beatTimesMs: grid.beatTimesMs,
        downbeatTimesMs: grid.downbeatTimesMs,
        beatAnchorMs: positionMs,
        gridRejected: false,
        gridRejectionReason: null,
        gridSource: "anchor",
      });
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
    if (this.stopped || this.running > 0) {
      return;
    }
    const claimed = this.jobs.claimNextQueued();
    if (!claimed) {
      return;
    }
    this.running += 1;
    void this.execute(claimed)
      .catch((error: unknown) => {
        this.logger.error({ err: error, jobId: claimed.id }, "Analysis job crashed");
      })
      .finally(() => {
        this.running -= 1;
        this.pump();
      });
  }

  private async execute(job: AnalysisJob): Promise<void> {
    const completed: string[] = [];
    const failed: string[] = [];
    try {
      const binaries = await this.detect();
      const prefetchN = this.config.analysis?.prefetch ?? 1;
      const pcmCache = new Map<string, Promise<PcmAudio>>();
      const queueDecode = (trackId: string): void => {
        if (pcmCache.has(trackId)) {
          return;
        }
        const track = this.tracks.findById(trackId);
        if (!track || track.fileMissing) {
          return;
        }
        pcmCache.set(trackId, loadPcmForAnalysis(track.filePath, this.runner, binaries));
      };
      for (let i = 0; i < job.trackIds.length; i += 1) {
        if (this.stopped) {
          this.jobs.markFailed(
            job.id,
            {
              code: "ANALYSIS_FAILED",
              message: "Analysis job stopped before completion",
              retryable: true,
            },
            completed,
            failed,
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
          const overlap = prefetchN > 0 && i + 1 < job.trackIds.length
            ? pcmCache.get(job.trackIds[i + 1]!)
            : undefined;
          await this.analyzeTrack(trackId, binaries, job.engines, pcmCache.get(trackId), overlap);
          completed.push(trackId);
        } catch (error) {
          failed.push(trackId);
          this.tracks.setAnalysisStatus(trackId, "failed");
          this.logger.warn({ err: error, trackId }, "Track analysis failed");
        }
        pcmCache.delete(trackId);
        this.jobs.updateProgress(job.id, (i + 1) / job.trackIds.length, completed, failed);
        if ((i + 1) % 25 === 0) {
          this.logger.info(
            { jobId: job.id, done: i + 1, total: job.trackIds.length },
            "Analysis progress",
          );
        }
      }
      this.jobs.markSucceeded(job.id, completed, failed);
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
      );
    }
  }

  private async analyzeTrack(
    trackId: string,
    binaries: FfmpegBinaries | null,
    engines: AnalysisEngineId[],
    preloaded?: Promise<PcmAudio>,
    overlap?: Promise<PcmAudio>,
  ): Promise<void> {
    const track = this.tracks.findById(trackId);
    if (!track) {
      throw new DomainError("TRACK_NOT_FOUND", `No track with id ${trackId}`);
    }
    if (track.fileMissing) {
      throw new DomainError("AUDIO_FILE_UNAVAILABLE", `${track.title} is marked missing`);
    }
    const pcm = await (preloaded ?? loadPcmForAnalysis(track.filePath, this.runner, binaries));
    const anchor = this.analyses.getBeatAnchorMs(trackId);
    const existing = this.analyses.findByTrackId(trackId);
    const canonical = resolveCanonicalBpm(track, existing);
    const referenceBpm =
      (track.bpmSource === "published" || track.bpmSource === "manual") && canonical.bpm != null
        ? canonical.bpm
        : undefined;
    const dsp = dspAnalyzer.analyze(pcm, {
      durationMs: track.durationMs,
      beatAnchorMs: anchor,
      referenceBpm,
    });
    const loudnessPromise = binaries
      ? this.runner.run({
          executable: binaries.ffmpegPath,
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
    const [loudness] = await Promise.all([loudnessPromise, overlap ?? Promise.resolve(null)]);
    let integratedLufs: number | null = null;
    let truePeakDb: number | null = null;
    if (loudness) {
      const parsed = parseEbur128(loudness.stderr);
      integratedLufs = parsed.integratedLufs;
      truePeakDb = parsed.truePeakDb;
    }
    const requested = engines.length > 0 ? engines : [DEFAULT_ANALYSIS_ENGINE];
    this.storeResult(trackId, dsp, anchor, integratedLufs, truePeakDb, referenceBpm ?? null);
    for (const engine of requested) {
      if (engine === "dnb-crate-dsp" || engine === "dnb-crate-envelope") {
        continue;
      }
      const python = await runPythonAnalyzer(
        this.runner,
        this.config,
        engine === "allin1" ? "allin1" : "beat-this",
        track.filePath,
      );
      this.storeResult(
        trackId,
        mergeAnalyzerResults(python, dsp),
        anchor,
        integratedLufs,
        truePeakDb,
        referenceBpm ?? null,
      );
    }
    const preferred = this.analyses.findByTrackId(trackId) ?? this.analyses.findByTrackId(trackId, dsp.analyzerName);
    if (preferred) {
      this.tracks.applyAnalyzedMetadata(trackId, {
        bpm: preferred.gridRejected ? null : preferred.bpm,
        musicalKey: preferred.musicalKey,
        keyConfidence: preferred.keyConfidence,
        gridRejected: preferred.gridRejected,
      });
    } else {
      this.tracks.setAnalysisStatus(trackId, "complete");
    }
    if (preferred) {
      this.tracks.insertAnalyzedCuesIfAbsent(trackId, preferred.suggestedCues);
    }
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
