import path from "node:path";

import {
  DomainError,
  hasDrumAndBassGenre,
  isDomainError,
  normalizeDnbBpm,
  normalizePersonName,
  remixTokens,
  type AppConfig,
  type EnrichmentJob,
  type EnrichmentReport,
  type EnrichmentScope,
  type Logger,
} from "@dnb-crate/domain";
import type { FfmpegBinaries, ProcessRunner } from "@dnb-crate/audio-renderer";
import { detectFfmpeg } from "@dnb-crate/audio-renderer";

import type { AnalysisRepository } from "../analysis-repository.ts";
import type { EnrichmentJobRepository } from "../enrichment-job-repository.ts";
import type { EnrichmentRepository } from "../enrichment-repository.ts";
import type { TrackRepository } from "../repository.ts";
import { AcoustidClient, fingerprintFile } from "./acoustid.ts";
import { DeezerClient } from "./deezer.ts";
import { createFetchHttpClient, type HttpClient } from "./http-client.ts";
import { pickBestMatch } from "./matcher.ts";
import { MusicBrainzClient, type MbRecording } from "./musicbrainz.ts";
import { RateLimiter } from "./rate-limiter.ts";
import { ResponseCache } from "./response-cache.ts";

export type EnrichmentCoordinatorOptions = {
  http?: HttpClient;
  intervals?: {
    musicbrainz?: number;
    deezer?: number;
    acoustid?: number;
  };
};

function foldDeezerBpm(bpm: number, isDnb: boolean): number {
  let value = bpm;
  if (isDnb) {
    const folded = normalizeDnbBpm(value);
    if (folded) {
      value = folded.bpm;
    }
  }
  if (Math.abs(value - Math.round(value)) <= 0.3 + 1e-9) {
    return Math.round(value);
  }
  return value;
}

export class EnrichmentCoordinator {
  canRun: () => boolean = () => true;
  private readonly active = new Set<Promise<void>>();
  private running = 0;
  private stopped = false;
  private binaries: FfmpegBinaries | null | undefined;
  private readonly http: HttpClient;
  private readonly intervals: NonNullable<EnrichmentCoordinatorOptions["intervals"]>;

  constructor(
    private readonly config: AppConfig,
    private readonly tracks: TrackRepository,
    private readonly enrichments: EnrichmentRepository,
    private readonly jobs: EnrichmentJobRepository,
    private readonly analyses: AnalysisRepository,
    private readonly runner: ProcessRunner,
    private readonly logger: Logger,
    options: EnrichmentCoordinatorOptions = {},
  ) {
    this.http = options.http ?? createFetchHttpClient();
    this.intervals = options.intervals ?? {};
  }

  recoverInterrupted(): number {
    return this.jobs.failRunningAsInterrupted();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.active);
  }

  kick(): void {
    this.pump();
  }

  selectTrackIds(input: {
    scope?: EnrichmentScope;
    trackIds?: string[];
    limit?: number;
  }): string[] {
    const scope = input.scope ?? "unmatched";
    let ids: string[] = [];
    if (scope === "ids") {
      ids = [...(input.trackIds ?? [])];
    } else if (scope === "all") {
      ids = this.tracks
        .listAll()
        .filter((track) => !track.fileMissing)
        .map((track) => track.id);
    } else {
      ids = this.enrichments.listUnmatchedIds();
    }
    if (input.limit != null) {
      ids = ids.slice(0, input.limit);
    }
    return ids;
  }

  start(input: { trackIds: string[]; dryRun?: boolean }): { job: EnrichmentJob } {
    if (input.trackIds.length === 0) {
      throw new DomainError("ENRICHMENT_FAILED", "No tracks to enrich");
    }
    const job = this.jobs.insertQueued(input.trackIds, input.dryRun === true);
    this.kick();
    return { job };
  }

  getStatus(enrichmentJobId?: string): { jobs: EnrichmentJob[] } {
    if (enrichmentJobId) {
      return { jobs: [this.jobs.require(enrichmentJobId)] };
    }
    return { jobs: this.jobs.list() };
  }

  getReport(): EnrichmentReport {
    return this.enrichments.report();
  }

  async waitForJob(jobId: string, timeoutMs = 120_000): Promise<EnrichmentJob> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const job = this.jobs.require(jobId);
      if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new DomainError("ENRICHMENT_FAILED", "Timed out waiting for enrichment job", {
      retryable: true,
    });
  }

  private clients() {
    const cache = new ResponseCache(path.join(this.config.outputRoot, "cache", "enrichment"));
    const contact = this.config.enrichment?.contact;
    return {
      mb: new MusicBrainzClient(
        this.http,
        new RateLimiter(this.intervals.musicbrainz ?? 1000),
        cache,
        contact,
      ),
      deezer: new DeezerClient(this.http, new RateLimiter(this.intervals.deezer ?? 200), cache),
      acoustid: this.config.enrichment?.acoustid?.apiKey
        ? new AcoustidClient(
            this.http,
            new RateLimiter(this.intervals.acoustid ?? 340),
            cache,
            this.config.enrichment.acoustid.apiKey,
          )
        : null,
    };
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
    const claimed = this.jobs.claimNextQueued();
    if (!claimed) {
      return;
    }
    this.running += 1;
    const task = this.execute(claimed)
      .catch((error: unknown) => {
        this.logger.error({ err: error, jobId: claimed.id }, "Enrichment job crashed");
      })
      .finally(() => {
        this.active.delete(task);
        this.running -= 1;
        this.pump();
      });
    this.active.add(task);
  }

  private async execute(job: EnrichmentJob): Promise<void> {
    const completed: string[] = [];
    const failed: string[] = [];
    try {
      if (this.config.enrichment?.enabled !== true) {
        throw new DomainError("ENRICHMENT_FAILED", "Enrichment is disabled in config");
      }
      const clients = this.clients();
      const binaries = await this.detect();
      for (let i = 0; i < job.trackIds.length; i += 1) {
        if (this.stopped) {
          this.jobs.markFailed(
            job.id,
            { code: "ENRICHMENT_FAILED", message: "Enrichment job stopped", retryable: true },
            completed,
            failed,
          );
          return;
        }
        const trackId = job.trackIds[i]!;
        try {
          await this.enrichTrack(trackId, job.dryRun, clients, binaries);
          completed.push(trackId);
        } catch (error) {
          failed.push(trackId);
          this.logger.warn({ err: error, trackId }, "Track enrichment failed");
        }
        this.jobs.updateProgress(job.id, (i + 1) / job.trackIds.length, completed, failed, null);
      }
      this.jobs.markSucceeded(job.id, completed, failed);
    } catch (error) {
      const mapped = isDomainError(error)
        ? error
        : new DomainError(
            "ENRICHMENT_FAILED",
            error instanceof Error ? error.message : "Enrichment failed",
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

  private async enrichTrack(
    trackId: string,
    dryRun: boolean,
    clients: ReturnType<EnrichmentCoordinator["clients"]>,
    binaries: FfmpegBinaries | null,
  ): Promise<void> {
    const track = this.tracks.findById(trackId);
    if (!track) {
      throw new DomainError("TRACK_NOT_FOUND", `No track with id ${trackId}`);
    }
    const query = { title: track.title, artist: track.artist, durationMs: track.durationMs };
    let method: "file-tags" | "isrc" | "acoustid" | "search" | null = null;
    let recording: MbRecording | null = null;
    let score: number | null = null;
    let needsReview = false;
    let acoustidId: string | null = null;
    const raw: Record<string, unknown> = {};

    const mbOn = this.config.enrichment?.musicbrainz?.enabled !== false;
    const deezerOn = this.config.enrichment?.deezer?.enabled !== false;

    try {
      if (mbOn && track.recordingMbid) {
        recording = await clients.mb.lookupRecording(track.recordingMbid);
        method = "file-tags";
        score = 1;
      }
    } catch (error) {
      raw.mbLookupError = error instanceof Error ? error.message : "lookupRecording failed";
    }
    try {
      if (!recording && mbOn && track.isrc) {
        const hits = await clients.mb.lookupIsrc(track.isrc);
        const picked = pickBestMatch(
          query,
          hits.map((hit) => ({
            ...hit,
            artist: hit.artist,
            durationMs: hit.length,
          })),
        );
        if (picked?.match.accept) {
          recording = hits.find((hit) => hit.id === picked.candidate.id) ?? null;
          method = "isrc";
          score = picked.match.score;
          needsReview = false;
        } else if (picked?.match.needsReview) {
          needsReview = true;
          raw.needsReview = true;
          raw.reviewScore = picked.match.score;
        }
      }
    } catch (error) {
      raw.mbIsrcError = error instanceof Error ? error.message : "lookupIsrc failed";
    }
    try {
      if (!recording && clients.acoustid && binaries) {
        const fp = await fingerprintFile(this.runner, binaries.ffmpegPath, track.filePath);
        if (fp) {
          const durationSec = track.durationMs > 0 ? track.durationMs / 1000 : fp.durationSec;
          const hits = await clients.acoustid.lookup(durationSec, fp.fingerprint);
          const accepted = hits.find((hit) => hit.score >= 0.85 && hit.recordingMbids[0]);
          if (accepted && mbOn) {
            const looked = await clients.mb.lookupRecording(accepted.recordingMbids[0]!);
            if (looked) {
              const match = pickBestMatch(query, [
                { ...looked, durationMs: looked.length, artist: looked.artist },
              ]);
              const queryRemix = remixTokens(query.title);
              const candRemix = remixTokens(looked.title);
              const remixOk =
                queryRemix.size === candRemix.size &&
                [...queryRemix].every((token) => candRemix.has(token));
              const durationOk =
                looked.length == null || Math.abs(looked.length - query.durationMs) <= 6000;
              if (match?.match.accept || (accepted.score >= 0.85 && remixOk && durationOk)) {
                recording = looked;
                method = "acoustid";
                score = accepted.score;
                acoustidId = accepted.acoustidId;
                needsReview = false;
              } else if (match?.match.needsReview) {
                needsReview = true;
                raw.needsReview = true;
              }
            }
          }
        }
      }
    } catch (error) {
      raw.acoustidError = error instanceof Error ? error.message : "acoustid failed";
    }
    try {
      if (!recording && mbOn && track.artist) {
        const hits = await clients.mb.searchRecordings(track.title, track.artist, track.durationMs);
        const picked = pickBestMatch(
          query,
          hits.map((hit) => ({ ...hit, durationMs: hit.length, artist: hit.artist })),
        );
        if (picked?.match.accept) {
          recording = (await clients.mb.lookupRecording(picked.candidate.id)) ?? picked.candidate;
          method = "search";
          score = picked.match.score;
          needsReview = false;
        } else if (picked?.match.needsReview) {
          needsReview = true;
          raw.needsReview = true;
          raw.reviewScore = picked.match.score;
        }
      }
    } catch (error) {
      raw.mbSearchError = error instanceof Error ? error.message : "searchRecordings failed";
    }

    let release = null;
    try {
      release = recording?.releaseMbid
        ? await clients.mb.lookupRelease(recording.releaseMbid)
        : null;
    } catch {
      release = null;
    }
    const knownIsrc = track.isrc ?? recording?.isrcs[0] ?? null;
    let deezer = null;
    try {
      deezer = knownIsrc && deezerOn ? await clients.deezer.byIsrc(knownIsrc) : null;
      if (!deezer && deezerOn && track.artist) {
        const search = await clients.deezer.search(track.artist, track.title);
        const picked = pickBestMatch(
          query,
          search.map((hit) => ({ ...hit, durationMs: hit.durationMs })),
        );
        if (picked?.match.accept) {
          deezer = (await clients.deezer.byId(picked.candidate.id)) ?? picked.candidate;
        }
      }
    } catch (error) {
      raw.deezerError = error instanceof Error ? error.message : "deezer failed";
    }
    try {
      if (!recording && mbOn && deezer?.isrc) {
        const hits = await clients.mb.lookupIsrc(deezer.isrc);
        const picked = pickBestMatch(
          query,
          hits.map((hit) => ({ ...hit, durationMs: hit.length })),
        );
        if (picked?.match.accept) {
          recording = hits.find((hit) => hit.id === picked.candidate.id) ?? null;
          method = method ?? "isrc";
          score = picked.match.score;
          needsReview = false;
          if (recording?.releaseMbid) {
            release = await clients.mb.lookupRelease(recording.releaseMbid);
          }
        }
      }
    } catch (error) {
      raw.mbDeezerIsrcError = error instanceof Error ? error.message : "deezer-isrc lookup failed";
    }

    const dsp = this.analyses.findByTrackId(trackId);
    const acceptedGrid = dsp && !dsp.gridRejected && dsp.bpm != null ? dsp.bpm : null;
    let bpmWritten = false;
    let bpmDisagreement = false;
    const writeBpm = this.config.enrichment?.writePublishedBpm !== false;
    if (
      deezer?.bpm &&
      writeBpm &&
      track.bpmSource !== "manual" &&
      track.bpmSource !== "published"
    ) {
      const folded = foldDeezerBpm(
        deezer.bpm,
        hasDrumAndBassGenre(track.genres ?? recording?.genres ?? []),
      );
      if (acceptedGrid != null && Math.abs(folded - acceptedGrid) > 1) {
        bpmDisagreement = true;
      } else {
        bpmWritten = true;
      }
    }

    const accepted = recording != null && !needsReview;
    raw.needsReview = needsReview && !accepted;
    raw.bpmWritten = bpmWritten;
    raw.bpmDisagreement = bpmDisagreement;
    raw.method = accepted ? method : null;
    raw.score = accepted ? score : needsReview ? score : null;
    raw.dryRun = dryRun;
    const storedMethod = accepted ? method : null;
    const storedScore = accepted ? score : null;

    if (dryRun) {
      this.enrichments.upsert({
        trackId,
        releaseMbid: recording?.releaseMbid ?? null,
        releaseGroupMbid: recording?.releaseGroupMbid ?? null,
        artistMbidsJson: recording ? JSON.stringify(recording.artistMbids) : null,
        catalogNumber: release?.catalogNumber ?? null,
        originalDate: recording?.firstReleaseDate ?? release?.firstReleaseDate ?? null,
        deezerTrackId: deezer?.id ?? null,
        deezerBpm: deezer?.bpm ?? null,
        deezerGain: deezer?.gain ?? null,
        acoustidId,
        matchMethod: storedMethod,
        matchScore: storedScore,
        matchedAt: storedMethod ? new Date().toISOString() : null,
        rawJson: JSON.stringify(raw),
      });
      return;
    }

    if (accepted && recording) {
      this.tracks.applyPublishedEnrichment(trackId, {
        album: null,
        label: release?.label ?? null,
        releaseDate:
          recording.firstReleaseDate ?? release?.firstReleaseDate ?? release?.date ?? null,
        isrc: recording.isrcs[0] ?? deezer?.isrc ?? null,
        recordingMbid: recording.id,
        artistCanonical: recording.artist ? normalizePersonName(recording.artist) : null,
        genres: recording.genres,
        bpm:
          bpmWritten && deezer?.bpm
            ? foldDeezerBpm(deezer.bpm, hasDrumAndBassGenre(recording.genres))
            : null,
      });
    } else if (bpmWritten && deezer?.bpm) {
      this.tracks.applyPublishedEnrichment(trackId, {
        album: null,
        label: null,
        releaseDate: deezer.releaseDate,
        isrc: deezer.isrc,
        recordingMbid: null,
        artistCanonical: null,
        genres: [],
        bpm: foldDeezerBpm(deezer.bpm, hasDrumAndBassGenre(track.genres ?? [])),
      });
    } else {
      this.tracks.refreshRecordingIdentity(trackId);
    }

    this.enrichments.upsert({
      trackId,
      releaseMbid: recording?.releaseMbid ?? null,
      releaseGroupMbid: recording?.releaseGroupMbid ?? null,
      artistMbidsJson: recording ? JSON.stringify(recording.artistMbids) : null,
      catalogNumber: release?.catalogNumber ?? null,
      originalDate: recording?.firstReleaseDate ?? release?.firstReleaseDate ?? null,
      deezerTrackId: deezer?.id ?? null,
      deezerBpm: deezer?.bpm ?? null,
      deezerGain: deezer?.gain ?? null,
      acoustidId,
      matchMethod: storedMethod,
      matchScore: storedScore,
      matchedAt: storedMethod ? new Date().toISOString() : null,
      rawJson: JSON.stringify(raw),
    });
  }
}
