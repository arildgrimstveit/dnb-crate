import { createCatalogRuntime } from "@dnb-crate/catalog";
import { APP_NAME, APP_VERSION, loadConfig, type AnalysisEngineId, type Logger } from "@dnb-crate/domain";
import pino from "pino";

function createLogger(level: string): Logger {
  const dest = pino.destination({ dest: 2, sync: true });
  const logger = pino({ level, base: { app: APP_NAME } }, dest);
  return {
    debug: (obj, msg) => (typeof obj === "string" ? logger.debug(obj) : logger.debug(obj, msg)),
    info: (obj, msg) => (typeof obj === "string" ? logger.info(obj) : logger.info(obj, msg)),
    warn: (obj, msg) => (typeof obj === "string" ? logger.warn(obj) : logger.warn(obj, msg)),
    error: (obj, msg) => (typeof obj === "string" ? logger.error(obj) : logger.error(obj, msg)),
  };
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return `Usage: ${APP_NAME} <command>

Commands:
  db:migrate              Apply catalog migrations
  library:scan [--dry-run]
  library:stats
  track:search [--query TEXT] [--artist TEXT] [--limit N]
  analysis:start --track-id UUID [--engine dsp|beat-this|allin1] [--wait]
  analysis:run --scope stale|unanalyzed|all|planningReady [--wait] [--timeout-min N]
  enrich:run --scope unmatched|all|ids [--dry-run] [--limit N] [--wait] [--timeout-min N]
  enrich:status [--id UUID]
  enrich:report
  analysis:status [--id UUID]
  analysis:get --track-id UUID
  analysis:compare --track-id UUID
  analysis:report
  analysis:gate [--engine dsp|beat-this] [--previews]
  analysis:cue-preview --track-id UUID [--cue drop]
  transition:plan --from UUID --to UUID [--type phrase_mix|bass_swap|crossfade|any] [--bars 16|32]
  transition:validate --from UUID --to UUID --type phrase_mix|bass_swap|crossfade
  plan:create --name TEXT [--duration-ms N] [--seed N] [--end-query TEXT]
  plan:clone --id UUID --name TEXT [--replan]
  plan:list
  plan:get --id UUID
  plan:validate --id UUID
  render:start --plan-id UUID [--wait] [--edge-fade-ms N] [--allow-low-confidence] [--allow-excessive-tempo]
  render:preview --plan-id UUID --transition-id UUID [--wait] [--template crossfade|phrase_mix|bass_swap]
  render:status --id UUID
  render:list
  render:cancel --id UUID --confirm
  render:manifest --id UUID
  render:check --id UUID

${APP_NAME} ${APP_VERSION}
`;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }

  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const runtime = createCatalogRuntime(config, logger);
  try {
    switch (command) {
      case "db:migrate":
        printJson({ ok: true, databasePath: "[configured]" });
        break;
      case "library:scan": {
        const scanned = await runtime.service.scanLibrary({ dryRun: flag(args, "--dry-run") });
        printJson({ ok: true, data: scanned.result, warnings: scanned.warnings });
        break;
      }
      case "library:stats": {
        const stats = runtime.service.getLibraryStats();
        printJson({ ok: true, data: stats });
        process.stderr.write(
          `analyzed ${stats.analysisCoverage.analyzed} / ${stats.trackCount} energy ${stats.metadataCoverage.energy}\n`,
        );
        break;
      }
      case "track:search": {
        const limitRaw = option(args, "--limit");
        const result = runtime.service.searchTracks({
          query: option(args, "--query"),
          artist: option(args, "--artist"),
          limit: limitRaw === undefined ? undefined : Number(limitRaw),
        });
        printJson({ ok: true, data: result });
        break;
      }
      case "analysis:start": {
        const trackId = option(args, "--track-id");
        const planningReady = flag(args, "--planning-ready");
        if (!trackId && !planningReady) {
          throw new Error("analysis:start requires --track-id or --planning-ready");
        }
        const enginesRaw = option(args, "--engine");
        let engines: AnalysisEngineId[] | undefined;
        if (enginesRaw === "beat-this" || enginesRaw === "allin1") {
          engines = [enginesRaw];
        } else if (enginesRaw === "dsp" || enginesRaw === "dnb-crate-dsp") {
          engines = ["dnb-crate-dsp"];
        }
        const started = runtime.service.startTrackAnalysis({
          trackIds: trackId ? [trackId] : undefined,
          planningReadyOnly: planningReady,
          engines,
        });
        if (flag(args, "--wait")) {
          const done = await runtime.service.waitForAnalysisJob(started.job.id);
          printJson({ ok: true, data: done });
        } else {
          printJson({ ok: true, data: started.job });
        }
        break;
      }
      case "analysis:run": {
        const scopeRaw = option(args, "--scope") ?? "stale";
        if (
          scopeRaw !== "stale" &&
          scopeRaw !== "unanalyzed" &&
          scopeRaw !== "all" &&
          scopeRaw !== "planningReady"
        ) {
          throw new Error("analysis:run requires --scope stale|unanalyzed|all|planningReady");
        }
        const timeoutMinRaw = option(args, "--timeout-min");
        const timeoutMin = timeoutMinRaw === undefined ? 90 : Number(timeoutMinRaw);
        if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) {
          throw new Error("analysis:run --timeout-min must be a positive number");
        }
        const started = runtime.service.startTrackAnalysis({ scope: scopeRaw });
        if (flag(args, "--wait")) {
          const done = await runtime.service.waitForAnalysisJob(
            started.job.id,
            timeoutMin * 60_000,
          );
          printJson({ ok: true, data: done });
        } else {
          printJson({ ok: true, data: started.job });
        }
        break;
      }
      case "enrich:run": {
        const scopeRaw = option(args, "--scope") ?? "unmatched";
        if (scopeRaw !== "unmatched" && scopeRaw !== "all" && scopeRaw !== "ids") {
          throw new Error("enrich:run requires --scope unmatched|all|ids");
        }
        const limitRaw = option(args, "--limit");
        const limit = limitRaw === undefined ? undefined : Number(limitRaw);
        if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
          throw new Error("enrich:run --limit must be a positive number");
        }
        const timeoutMinRaw = option(args, "--timeout-min");
        const timeoutMin = timeoutMinRaw === undefined ? 90 : Number(timeoutMinRaw);
        if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) {
          throw new Error("enrich:run --timeout-min must be a positive number");
        }
        const started = runtime.service.startMetadataEnrichment({
          scope: scopeRaw,
          dryRun: flag(args, "--dry-run"),
          limit,
        });
        if (flag(args, "--wait")) {
          const done = await runtime.service.waitForEnrichmentJob(
            started.job.id,
            timeoutMin * 60_000,
          );
          const report = runtime.service.getEnrichmentReport();
          for (const row of report.rows) {
            if (row.method || row.needsReview) {
              process.stderr.write(
                `${row.title} method=${row.method ?? "none"} score=${row.score ?? "n/a"}${row.needsReview ? " needsReview" : ""}\n`,
              );
            }
          }
          printJson({ ok: true, data: { job: done, report } });
        } else {
          printJson({ ok: true, data: started.job });
        }
        break;
      }
      case "enrich:status": {
        const id = option(args, "--id");
        printJson({ ok: true, data: runtime.service.getEnrichmentStatus(id) });
        break;
      }
      case "enrich:report":
        printJson({ ok: true, data: runtime.service.getEnrichmentReport() });
        break;
      case "analysis:status": {
        const id = option(args, "--id");
        printJson({ ok: true, data: runtime.service.getAnalysisStatus(id) });
        break;
      }
      case "analysis:get": {
        const trackId = option(args, "--track-id");
        if (!trackId) {
          throw new Error("analysis:get requires --track-id");
        }
        printJson({ ok: true, data: runtime.service.getTrackAnalysis(trackId) });
        break;
      }
      case "analysis:compare": {
        const trackId = option(args, "--track-id");
        if (!trackId) {
          throw new Error("analysis:compare requires --track-id");
        }
        printJson({ ok: true, data: runtime.service.compareTrackAnalyses(trackId) });
        break;
      }
      case "analysis:report":
        printJson({ ok: true, data: runtime.service.getAnalysisReport() });
        break;
      case "analysis:gate": {
        const enginesRaw = option(args, "--engine");
        let engines: AnalysisEngineId[] | undefined;
        if (enginesRaw === "beat-this" || enginesRaw === "allin1") {
          engines = [enginesRaw];
        } else if (enginesRaw === "dsp" || enginesRaw === "dnb-crate-dsp" || enginesRaw === undefined) {
          engines = ["dnb-crate-dsp"];
        }
        const ids = runtime.repository
          .listAll()
          .filter((track) => track.bpmSource === "published" || track.bpmSource === "manual")
          .map((track) => track.id);
        if (ids.length > 0) {
          const started = runtime.service.startTrackAnalysis({ trackIds: ids, engines });
          const done = await runtime.service.waitForAnalysisJob(started.job.id, 30 * 60_000);
          if (done.status !== "succeeded") {
            throw new Error(`analysis:gate job ${done.status}: ${done.errorMessage ?? done.id}`);
          }
        }
        if (flag(args, "--previews")) {
          for (const trackId of ids) {
            try {
              await runtime.service.createCuePreview({ trackId, cue: "drop" });
            } catch (error) {
              process.stderr.write(
                `cue preview failed for ${trackId}: ${error instanceof Error ? error.message : String(error)}\n`,
              );
            }
          }
        }
        const report = runtime.service.getAnalysisReport();
        process.stderr.write(
          `analysis:gate in-range accepted ${report.inRange.accepted}/${report.inRange.count} exact ${report.inRange.acceptedExact} gridSource ${JSON.stringify(report.gridSourceCounts)}\n`,
        );
        printJson({ ok: true, data: report });
        break;
      }
      case "analysis:cue-preview": {
        const trackId = option(args, "--track-id");
        if (!trackId) {
          throw new Error("analysis:cue-preview requires --track-id");
        }
        const cueRaw = option(args, "--cue") ?? "drop";
        const cue =
          cueRaw === "intro_start" ||
          cueRaw === "drop" ||
          cueRaw === "breakdown" ||
          cueRaw === "outro_start"
            ? cueRaw
            : "drop";
        printJson({
          ok: true,
          data: await runtime.service.createCuePreview({ trackId, cue }),
        });
        break;
      }
      case "transition:plan": {
        const from = option(args, "--from");
        const to = option(args, "--to");
        if (!from || !to) {
          throw new Error("transition:plan requires --from and --to");
        }
        const typeRaw = option(args, "--type");
        const barsRaw = option(args, "--bars");
        printJson({
          ok: true,
          data: runtime.service.planTransition({
            outgoingTrackId: from,
            incomingTrackId: to,
            preferredType:
              typeRaw === "phrase_mix" ||
              typeRaw === "bass_swap" ||
              typeRaw === "crossfade" ||
              typeRaw === "any"
                ? typeRaw
                : undefined,
            barCount: barsRaw === "32" ? 32 : barsRaw === "16" ? 16 : undefined,
          }),
        });
        break;
      }
      case "transition:validate": {
        const from = option(args, "--from");
        const to = option(args, "--to");
        const typeRaw = option(args, "--type");
        if (!from || !to || !typeRaw) {
          throw new Error("transition:validate requires --from, --to, and --type");
        }
        if (typeRaw !== "crossfade" && typeRaw !== "phrase_mix" && typeRaw !== "bass_swap") {
          throw new Error("transition:validate --type must be crossfade, phrase_mix, or bass_swap");
        }
        printJson({
          ok: true,
          data: runtime.service.validateTransition({
            outgoingTrackId: from,
            incomingTrackId: to,
            type: typeRaw,
          }),
        });
        break;
      }
      case "plan:create": {
        const name = option(args, "--name");
        if (!name) {
          throw new Error("plan:create requires --name");
        }
        const durationRaw = option(args, "--duration-ms");
        const seedRaw = option(args, "--seed");
        const endQuery = option(args, "--end-query");
        let endTrackId: string | undefined;
        if (endQuery) {
          const hits = runtime.service.searchTracks({ query: endQuery, limit: 1 });
          endTrackId = hits.tracks[0]?.id;
        }
        const created = runtime.service.createSetPlan({
          name,
          targetDurationMs: durationRaw === undefined ? undefined : Number(durationRaw),
          seed: seedRaw === undefined ? undefined : Number(seedRaw),
          endTrackId,
        });
        printJson({ ok: true, data: created });
        break;
      }
      case "plan:clone": {
        const id = option(args, "--id");
        const name = option(args, "--name");
        if (!id || !name) {
          throw new Error("plan:clone requires --id and --name");
        }
        printJson({
          ok: true,
          data: runtime.service.cloneSetPlan({
            setPlanId: id,
            name,
            replan: flag(args, "--replan"),
          }),
        });
        break;
      }
      case "plan:list":
        printJson({ ok: true, data: runtime.service.listSetPlans() });
        break;
      case "plan:get": {
        const id = option(args, "--id");
        if (!id) {
          throw new Error("plan:get requires --id");
        }
        printJson({ ok: true, data: runtime.service.getSetPlan(id) });
        break;
      }
      case "plan:validate": {
        const id = option(args, "--id");
        if (!id) {
          throw new Error("plan:validate requires --id");
        }
        printJson({ ok: true, data: await runtime.service.validateSavedSetPlan(id) });
        break;
      }
      case "render:start": {
        const planId = option(args, "--plan-id");
        if (!planId) {
          throw new Error("render:start requires --plan-id");
        }
        const edgeRaw = option(args, "--edge-fade-ms");
        const started = await runtime.service.startSetRender({
          setPlanId: planId,
          edgeFadeMs: edgeRaw === undefined ? undefined : Number(edgeRaw),
          allowLowConfidence: flag(args, "--allow-low-confidence"),
          allowExcessiveTempo: flag(args, "--allow-excessive-tempo"),
        });
        if (flag(args, "--wait")) {
          const done = await runtime.service.waitForRenderJob(started.job.id, 10 * 60_000);
          printJson({ ok: true, data: done, warnings: started.warnings });
        } else {
          printJson({ ok: true, data: started.job, warnings: started.warnings });
        }
        break;
      }
      case "render:preview": {
        const planId = option(args, "--plan-id");
        const transitionId = option(args, "--transition-id");
        if (!planId || !transitionId) {
          throw new Error("render:preview requires --plan-id and --transition-id");
        }
        const templateRaw = option(args, "--template");
        const started = await runtime.service.createTransitionPreview({
          setPlanId: planId,
          transitionId,
          template:
            templateRaw === "crossfade" ||
            templateRaw === "phrase_mix" ||
            templateRaw === "bass_swap"
              ? templateRaw
              : undefined,
        });
        if (flag(args, "--wait")) {
          const done = await runtime.service.waitForRenderJob(started.job.id);
          printJson({ ok: true, data: done, warnings: started.warnings });
        } else {
          printJson({ ok: true, data: started.job, warnings: started.warnings });
        }
        break;
      }
      case "render:status": {
        const id = option(args, "--id");
        if (!id) {
          throw new Error("render:status requires --id");
        }
        printJson({ ok: true, data: runtime.service.getRenderStatus(id) });
        break;
      }
      case "render:list":
        printJson({ ok: true, data: runtime.service.listRenderJobs() });
        break;
      case "render:cancel": {
        const id = option(args, "--id");
        if (!id) {
          throw new Error("render:cancel requires --id");
        }
        if (!flag(args, "--confirm")) {
          throw new Error("render:cancel requires --confirm");
        }
        printJson({ ok: true, data: runtime.service.cancelRenderJob(id, true) });
        break;
      }
      case "render:manifest": {
        const id = option(args, "--id");
        if (!id) {
          throw new Error("render:manifest requires --id");
        }
        printJson({ ok: true, data: runtime.service.getRenderManifest(id) });
        break;
      }
      case "render:check": {
        const id = option(args, "--id");
        if (!id) {
          throw new Error("render:check requires --id");
        }
        const checked = await runtime.service.checkRender(id);
        printJson({ ok: checked.ok, data: checked });
        if (!checked.ok) {
          process.exitCode = 1;
        }
        break;
      }
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${usage()}`);
        process.exitCode = 1;
    }
  } finally {
    runtime.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
