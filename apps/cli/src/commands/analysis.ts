import type { CatalogRuntime } from "@dnb-crate/catalog";
import { selectTrackEvidenceInputSchema } from "@dnb-crate/domain";

import { flag, option, printJson } from "../args.ts";

export async function run(
  command: string,
  args: string[],
  runtime: CatalogRuntime,
): Promise<boolean> {
  switch (command) {
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
      return true;
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
        const done = await runtime.service.waitForAnalysisJob(started.job.id, timeoutMin * 60_000);
        printJson({ ok: true, data: done });
      } else {
        printJson({ ok: true, data: started.job });
      }
      return true;
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
      return true;
    }
    case "enrich:status": {
      const id = option(args, "--id");
      printJson({ ok: true, data: runtime.service.getEnrichmentStatus(id) });
      return true;
    }
    case "enrich:report":
      printJson({ ok: true, data: runtime.service.getEnrichmentReport() });
      return true;
    case "analysis:status": {
      const id = option(args, "--id");
      printJson({ ok: true, data: runtime.service.getAnalysisStatus(id) });
      return true;
    }
    case "analysis:get": {
      const trackId = option(args, "--track-id");
      if (!trackId) {
        throw new Error("analysis:get requires --track-id");
      }
      printJson({ ok: true, data: runtime.service.getTrackAnalysis(trackId) });
      return true;
    }
    case "analysis:compare": {
      const trackId = option(args, "--track-id");
      if (!trackId) {
        throw new Error("analysis:compare requires --track-id");
      }
      printJson({ ok: true, data: runtime.service.compareTrackAnalyses(trackId) });
      return true;
    }
    case "analysis:report":
      printJson({ ok: true, data: runtime.service.getAnalysisReport() });
      return true;
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
      return true;
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
      return true;
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
      return true;
    }
    default:
      return false;
  }
}
