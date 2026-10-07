import type { CatalogRuntime } from "@dnb-crate/catalog";

import { flag, option, printJson } from "../args.ts";

export async function run(
  command: string,
  args: string[],
  runtime: CatalogRuntime,
): Promise<boolean> {
  switch (command) {
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
        allowOverlongDuration: flag(args, "--allow-overlong-duration"),
      });
      if (flag(args, "--wait")) {
        const done = await runtime.service.waitForRenderJob(started.job.id, 45 * 60_000);
        printJson({ ok: true, data: done, warnings: started.warnings });
      } else {
        printJson({ ok: true, data: started.job, warnings: started.warnings });
      }
      return true;
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
          templateRaw === "crossfade" || templateRaw === "phrase_mix" || templateRaw === "bass_swap"
            ? templateRaw
            : undefined,
      });
      if (flag(args, "--wait")) {
        const done = await runtime.service.waitForRenderJob(started.job.id);
        printJson({ ok: true, data: done, warnings: started.warnings });
      } else {
        printJson({ ok: true, data: started.job, warnings: started.warnings });
      }
      return true;
    }
    case "render:status": {
      const id = option(args, "--id");
      if (!id) {
        throw new Error("render:status requires --id");
      }
      printJson({ ok: true, data: runtime.service.getRenderStatus(id) });
      return true;
    }
    case "render:list":
      printJson({ ok: true, data: runtime.service.listRenderJobs() });
      return true;
    case "render:cancel": {
      const id = option(args, "--id");
      if (!id) {
        throw new Error("render:cancel requires --id");
      }
      if (!flag(args, "--confirm")) {
        throw new Error("render:cancel requires --confirm");
      }
      printJson({ ok: true, data: runtime.service.cancelRenderJob(id, true) });
      return true;
    }
    case "render:manifest": {
      const id = option(args, "--id");
      if (!id) {
        throw new Error("render:manifest requires --id");
      }
      printJson({ ok: true, data: runtime.service.getRenderManifest(id) });
      return true;
    }
    case "render:check": {
      const id = option(args, "--id");
      if (!id) {
        throw new Error("render:check requires --id");
      }
      const checked = await runtime.service.checkRender(id);
      if (checked.ok) {
        printJson({ ok: true, data: checked });
      } else {
        printJson({
          ok: false,
          error: {
            code: "RENDER_CHECK_FAILED",
            message: "Render checks failed; inspect the joins and warnings in details.",
            retryable: false,
            details: { failures: checked.failures, warnings: checked.warnings },
          },
        });
        process.exitCode = 1;
      }
      return true;
    }
    default:
      return false;
  }
}
