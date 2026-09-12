import { readFileSync } from "node:fs";

import { createCatalogRuntime, hasLiveWorker } from "@dnb-crate/catalog";
import { cliWorkerNeed, NO_WORKER_MESSAGE } from "./worker-policy.ts";
import {
  APP_NAME,
  APP_VERSION,
  createSetPlanInputSchema,
  listTransitionFeedbackInputSchema,
  loadConfig,
  rateTransitionInputSchema,
  selectTrackEvidenceInputSchema,
  type Logger,
} from "@dnb-crate/domain";
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
  analysis:start --track-id UUID [--wait]
  analysis:run --scope stale|unanalyzed|all|planningReady [--wait] [--timeout-min N]
  enrich:run --scope unmatched|all|ids [--dry-run] [--limit N] [--wait] [--timeout-min N]
  enrich:status [--id UUID]
  enrich:report
  analysis:status [--id UUID]
  analysis:get --track-id UUID
  analysis:compare --track-id UUID
  analysis:report
  analysis:gate [--previews]
  analysis:cue-preview --track-id UUID [--cue drop]
  transition:plan --from UUID --to UUID [--type phrase_mix|bass_swap|crossfade|any] [--bars 16|32]
  transition:validate --from UUID --to UUID --type phrase_mix|bass_swap|crossfade
  plan:create --name TEXT [--duration-min N | --duration-ms N] [--seed N] [--end-query TEXT]
  plan:create --brief-json FILE
  plan:clone --id UUID --name TEXT [--replan]
  plan:list
  plan:get --id UUID
  plan:quality --id UUID
  hour:feedback --id RENDER_UUID --checksum SHA256 --accepted true|false --quote TEXT
  hour:history [--id RENDER_UUID]
  plan:validate --id UUID
  render:start --plan-id UUID [--wait] [--edge-fade-ms N] [--allow-low-confidence] [--allow-excessive-tempo]
  render:preview --plan-id UUID --transition-id UUID [--wait] [--template crossfade|phrase_mix|bass_swap]
  render:status --id UUID
  render:list
  render:cancel --id UUID --confirm
  render:manifest --id UUID
  render:check --id UUID
  feedback:rate --json FILE
  feedback:list [--from UUID] [--to UUID] [--fingerprint TEXT]
  analysis:select-evidence --track-id UUID [--rhythm ENGINE] [--structure ENGINE] [--key ENGINE] [--reason TEXT]

Job commands without --wait enqueue only and require a live MCP (or other) worker.
Pass --wait, or run analysis:gate, to process jobs in this CLI process.

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
  const workerNeed = cliWorkerNeed(command, args);
  const runtime = createCatalogRuntime(config, logger, { passive: workerNeed !== "process" });
  try {
    if (workerNeed === "enqueue" && !hasLiveWorker(runtime.db)) {
      throw new Error(NO_WORKER_MESSAGE);
    }
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
        const started = runtime.service.startTrackAnalysis({
          trackIds: trackId ? [trackId] : undefined,
          planningReadyOnly: planningReady,
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
        const ids = runtime.repository
          .listAll()
          .filter((track) => track.bpmSource === "published" || track.bpmSource === "manual")
          .map((track) => track.id);
        if (ids.length > 0) {
          const started = runtime.service.startTrackAnalysis({ trackIds: ids });
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
          `analysis:gate in-range accepted ${report.inRange.accepted}/${report.inRange.count} exact ${report.inRange.acceptedExact} gridSource ${JSON.stringify(report.gridSourceCounts)} key ${JSON.stringify(report.keyAgreementCounts)}\n`,
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
        const briefPath = option(args, "--brief-json");
        if (briefPath) {
          const parsed = createSetPlanInputSchema.safeParse(
            JSON.parse(readFileSync(briefPath, "utf8")),
          );
          if (!parsed.success) {
            throw new Error(
              `plan:create --brief-json is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
            );
          }
          printJson({ ok: true, data: runtime.service.createSetPlan(parsed.data) });
          break;
        }
        const name = option(args, "--name");
        if (!name) {
          throw new Error("plan:create requires --name or --brief-json");
        }
        const durationMsRaw = option(args, "--duration-ms");
        const durationMinRaw = option(args, "--duration-min");
        const seedRaw = option(args, "--seed");
        const endQuery = option(args, "--end-query");
        let endTrackId: string | undefined;
        if (endQuery) {
          const hits = runtime.service.searchTracks({ query: endQuery, limit: 1 });
          endTrackId = hits.tracks[0]?.id;
        }
        if (durationMsRaw !== undefined && durationMinRaw !== undefined) {
          throw new Error("plan:create accepts --duration-min or --duration-ms, not both");
        }
        const created = runtime.service.createSetPlan({
          name,
          targetDurationMs: durationMsRaw === undefined ? undefined : Number(durationMsRaw),
          targetDurationMinutes: durationMinRaw === undefined ? undefined : Number(durationMinRaw),
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
        printJson({
          ok: true,
          data: {
            plan: runtime.service.getSetPlan(id),
            quality: runtime.service.reportSetPlanQuality(id),
          },
        });
        break;
      }
      case "plan:quality": {
        const id = option(args, "--id");
        if (!id) {
          throw new Error("plan:quality requires --id");
        }
        printJson({ ok: true, data: runtime.service.reportSetPlanQuality(id) });
        break;
      }
      case "hour:feedback": {
        const renderJobId = option(args, "--id");
        const outputChecksum = option(args, "--checksum");
        const quote = option(args, "--quote");
        const accepted = option(args, "--accepted");
        if (
          !renderJobId ||
          !outputChecksum ||
          !quote ||
          !["true", "false"].includes(accepted ?? "")
        )
          throw new Error("hour:feedback requires --id --checksum --quote --accepted true|false");
        printJson({
          ok: true,
          data: runtime.service.recordHourFeedback({
            renderJobId,
            outputChecksum,
            quote,
            accepted: accepted === "true",
          }),
        });
        break;
      }
      case "hour:history": {
        printJson({ ok: true, data: runtime.service.listHourFeedback(option(args, "--id")) });
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
          const done = await runtime.service.waitForRenderJob(started.job.id, 45 * 60_000);
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
      case "feedback:rate": {
        const jsonPath = option(args, "--json");
        if (!jsonPath) {
          throw new Error("feedback:rate requires --json");
        }
        const parsed = rateTransitionInputSchema.safeParse(
          JSON.parse(readFileSync(jsonPath, "utf8")),
        );
        if (!parsed.success) {
          throw new Error(
            `feedback:rate --json is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
          );
        }
        printJson({ ok: true, data: runtime.service.rateTransition(parsed.data) });
        break;
      }
      case "feedback:list": {
        const parsed = listTransitionFeedbackInputSchema.safeParse({
          outgoingTrackId: option(args, "--from"),
          incomingTrackId: option(args, "--to"),
          recipeFingerprint: option(args, "--fingerprint"),
        });
        if (!parsed.success) {
          throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
        }
        printJson({ ok: true, data: runtime.service.listTransitionFeedback(parsed.data) });
        break;
      }
      case "analysis:select-evidence": {
        const trackId = option(args, "--track-id");
        if (!trackId) {
          throw new Error("analysis:select-evidence requires --track-id");
        }
        const parsed = selectTrackEvidenceInputSchema.safeParse({
          trackId,
          rhythmEngine: option(args, "--rhythm") ?? null,
          structureEngine: option(args, "--structure") ?? null,
          keyEngine: option(args, "--key") ?? null,
          reason: option(args, "--reason"),
        });
        if (!parsed.success) {
          throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
        }
        printJson({ ok: true, data: runtime.service.selectTrackEvidence(parsed.data) });
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
    await runtime.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
