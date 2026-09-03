import type { AppConfig, Logger } from "@dnb-crate/domain";
import { silentLogger } from "@dnb-crate/domain";
import {
  createFakeFfmpegRunner,
  createNodeProcessRunner,
  type ProcessRunner,
} from "@dnb-crate/audio-renderer";

import { AnalysisCoordinator } from "./analysis/coordinator.ts";
import { AnalysisJobRepository } from "./analysis-job-repository.ts";
import { AnalysisRepository } from "./analysis-repository.ts";
import { openDatabase, type SqliteDatabase } from "./db.ts";
import { EnrichmentCoordinator } from "./enrichment/coordinator.ts";
import type { HttpClient } from "./enrichment/http-client.ts";
import { EnrichmentJobRepository } from "./enrichment-job-repository.ts";
import { EnrichmentRepository } from "./enrichment-repository.ts";
import { TrackRepository } from "./repository.ts";
import { CatalogService } from "./service.ts";
import { RenderJobRepository } from "./render-job-repository.ts";
import { RenderCoordinator } from "./render/coordinator.ts";
import { SetPlanRepository } from "./set-plan-repository.ts";

export type CatalogRuntimeOptions = {
  processRunner?: ProcessRunner;
  /** When true, skip FFmpeg detection at startup by injecting the in-process fake. */
  useFakeFfmpeg?: boolean;
  http?: HttpClient;
  enrichmentIntervals?: {
    musicbrainz?: number;
    deezer?: number;
    acoustid?: number;
  };
};

export function createCatalogRuntime(
  config: AppConfig,
  logger: Logger = silentLogger,
  options: CatalogRuntimeOptions = {},
): {
  db: SqliteDatabase;
  repository: TrackRepository;
  service: CatalogService;
  renderJobs: RenderJobRepository;
  setPlans: SetPlanRepository;
  analyses: AnalysisRepository;
  analysisJobs: AnalysisJobRepository;
  close: () => void;
} {
  const db = openDatabase(config.databasePath);
  const repository = new TrackRepository(db);
  const setPlans = new SetPlanRepository(db);
  const renderJobs = new RenderJobRepository(db);
  const analyses = new AnalysisRepository(db);
  const analysisJobs = new AnalysisJobRepository(db);
  const runner =
    options.processRunner ??
    (options.useFakeFfmpeg ? createFakeFfmpegRunner() : createNodeProcessRunner());
  const renders = new RenderCoordinator(
    config,
    repository,
    setPlans,
    renderJobs,
    analyses,
    runner,
    logger,
  );
  const analysis = new AnalysisCoordinator(
    config,
    repository,
    analyses,
    analysisJobs,
    runner,
    logger,
  );
  const enrichments = new EnrichmentRepository(db);
  const enrichmentJobs = new EnrichmentJobRepository(db);
  const enrichment = new EnrichmentCoordinator(
    config,
    repository,
    enrichments,
    enrichmentJobs,
    analyses,
    runner,
    logger,
    {
      http: options.http,
      intervals: options.enrichmentIntervals,
    },
  );
  renders.recoverInterrupted();
  analysis.recoverInterrupted();
  enrichment.recoverInterrupted();
  renders.kick();
  analysis.kick();
  enrichment.kick();
  const service = new CatalogService(
    config,
    repository,
    setPlans,
    renders,
    analysis,
    analyses,
    enrichment,
    logger,
  );
  return {
    db,
    repository,
    service,
    renderJobs,
    setPlans,
    analyses,
    analysisJobs,
    close: () => {
      renders.stop();
      analysis.stop();
      enrichment.stop();
      db.close();
    },
  };
}

export { openDatabase } from "./db.ts";
export { runMigrations } from "./migrate.ts";
export { TrackRepository } from "./repository.ts";
export { CatalogService } from "./service.ts";
export type { RenderCheckResult, RenderCheckJoin } from "./render/coordinator.ts";
export { SetPlanRepository } from "./set-plan-repository.ts";
export { RenderJobRepository } from "./render-job-repository.ts";
export { AnalysisRepository } from "./analysis-repository.ts";
export { AnalysisJobRepository } from "./analysis-job-repository.ts";
export { draftSetPlan } from "./planning/planner.ts";
export { validateSetPlan } from "./planning/validate.ts";
export { planTransition, validateTransition } from "./planning/transition-planner.ts";
export { walkLibrary } from "./scanner.ts";
export { isPathInsideRoot, isPathInsideAnyRoot, relativeToRoots } from "./paths.ts";
export { fingerprintFile } from "./fingerprint.ts";
export { extractAudioMetadata } from "./metadata.ts";
export { EnrichmentCoordinator } from "./enrichment/coordinator.ts";
export { createFakeHttpClient, createFetchHttpClient, redactUrl } from "./enrichment/http-client.ts";
export { RateLimiter } from "./enrichment/rate-limiter.ts";
export { pickBestMatch, scoreMatch } from "./enrichment/matcher.ts";
export { buildSineWav, writeSineWav, type WavFixtureOptions } from "./wav-fixture.ts";
export { buildClickTrackPcm, encodeMonoWav } from "@dnb-crate/audio-analysis";
