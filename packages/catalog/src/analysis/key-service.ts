import type { AppConfig } from "@dnb-crate/domain";
import type { ProcessRunner } from "@dnb-crate/audio-renderer";
import type { AnalysisRepository } from "../analysis-repository.ts";
import type { TrackRepository } from "../repository.ts";
import { runKeyEngine, type KeyEngineProbe } from "./key-engine.ts";

/** Stores key-only evidence without changing explicit evidence choices or rhythm/cues. */
export class KeyAnalysisService {
  constructor(
    private config: AppConfig,
    private tracks: TrackRepository,
    private analyses: AnalysisRepository,
    private runner: ProcessRunner,
  ) {}

  async analyze(trackId: string, probe: KeyEngineProbe, abortSignal?: AbortSignal): Promise<void> {
    const track = this.tracks.findById(trackId)!;
    const identity = probe.identity ?? "unavailable";
    const fingerprint = track.fileFingerprint;
    const previous = this.analyses.getStage(trackId, "key");
    const write = (state: "running" | "succeeded" | "failed" | "skipped", reason: string | null) =>
      this.analyses.setStage(trackId, "key", { state, fingerprint, identity, reason });
    if (
      this.config.analysis?.keyAnalysis === "off" &&
      previous?.state === "succeeded" &&
      previous.fingerprint === fingerprint
    )
      return;
    if (
      this.config.analysis?.keyAnalysis === "off" ||
      (track.musicalKey && (track.keySource === "manual" || track.keySource === "published"))
    ) {
      write(
        "skipped",
        this.config.analysis?.keyAnalysis === "off"
          ? "Automatic key analysis disabled by analysis.keyAnalysis."
          : "Using manual or published canonical key.",
      );
      return;
    }
    if (!probe.available) {
      if (previous?.state === "succeeded" && previous.fingerprint === fingerprint) return;
      write(
        probe.reason?.startsWith("CONFIG_INVALID") ? "failed" : "skipped",
        probe.reason ??
          "KeyFinder CLI is not installed. Install keyfinder-cli or configure keyfinderPath.",
      );
      return;
    }
    if (
      previous?.state === "succeeded" &&
      previous.fingerprint === fingerprint &&
      previous.identity === identity
    )
      return;
    if (!previous || previous.fingerprint !== fingerprint || previous.identity !== identity) {
      // Retain the historical row, but withdraw stale automatic canonical metadata.
      if (
        track.keySource === "analyzed" &&
        this.analyses.getSelection(trackId)?.keyEngine === "keyfinder"
      ) {
        this.tracks.applyAnalyzedMetadata(trackId, { bpm: null, musicalKey: null });
      }
    }
    write("running", null);
    try {
      const result = await runKeyEngine(
        this.runner,
        this.config,
        track.filePath,
        probe,
        abortSignal,
      );
      this.analyses.upsert({
        ...result,
        suggestedCues: [],
        trackId,
        integratedLufs: null,
        truePeakDb: null,
        beatAnchorMs: null,
        analyzedAt: new Date().toISOString(),
      });
      const selection = this.analyses.getSelection(trackId);
      if (!selection?.keyEngine || selection.keyEngine === "keyfinder") {
        if (!selection?.keyEngine)
          this.analyses.setSelection(trackId, {
            keyEngine: "keyfinder",
            reason: "Automatic KeyFinder selection",
          });
        this.tracks.applyAnalyzedMetadata(trackId, {
          bpm: null,
          musicalKey: result.musicalKey,
          keyConfidence: result.keyConfidence,
          gridRejected: true,
        });
      }
      write("succeeded", null);
    } catch (error) {
      write(
        "failed",
        probe.reason ??
          (error instanceof Error &&
          /^(KeyFinder|Key analysis|Key decode|FFmpeg could not)/.test(error.message)
            ? error.message
            : "Key detection failed. Check native dependencies and source readability, then retry analysis."),
      );
    } finally {
      this.tracks.setAnalysisStatus(trackId, track.analysisStatus);
    }
  }
}
