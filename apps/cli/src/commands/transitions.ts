import { readFileSync } from "node:fs";

import type { CatalogRuntime } from "@dnb-crate/catalog";
import { listTransitionFeedbackInputSchema, rateTransitionInputSchema } from "@dnb-crate/domain";

import { option, printJson } from "../args.ts";

/** Synchronous command group (no waits); kept dispatch-compatible with the
 * async groups. */
export async function run(
  command: string,
  args: string[],
  runtime: CatalogRuntime,
): Promise<boolean> {
  switch (command) {
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
      return true;
    }
    case "transition:inspect": {
      const planId = option(args, "--plan");
      const transitionId = option(args, "--transition");
      if (!planId || !transitionId) {
        throw new Error("transition:inspect requires --plan and --transition");
      }
      printJson({
        ok: true,
        data: runtime.service.inspectTransition({
          setPlanId: planId,
          transitionId,
        }),
      });
      return true;
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
      return true;
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
      return true;
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
      return true;
    }
    case "transition:compare": {
      const planId = option(args, "--plan");
      const transitionId = option(args, "--transition");
      if (!planId || !transitionId) {
        throw new Error("transition:compare requires --plan and --transition");
      }
      const result = await runtime.service.compareTransitionVariants({
        setPlanId: planId,
        transitionId,
      });
      if (args.includes("--wait")) {
        for (const variant of result.variants) {
          if (variant.jobId) {
            const done = await runtime.service.waitForRenderJob(variant.jobId, 600_000);
            variant.outputRootRelativePath = done.outputRootRelativePath;
          }
        }
      }
      printJson({ ok: true, data: result });
      return true;
    }
    case "plan:repair": {
      const planId = option(args, "--plan");
      const entryId = option(args, "--entry");
      const trackId = option(args, "--with");
      if (!planId || !entryId || !trackId) {
        throw new Error(
          "plan:repair requires --plan, --entry, and --with (the replacement track id)",
        );
      }
      const protectedRaw = option(args, "--protect");
      const protectedIds = protectedRaw
        ? protectedRaw.split(",").map((id) => id.trim())
        : undefined;
      const result = runtime.service.repairSetPlan({
        setPlanId: planId,
        entryId,
        newIncomingTrackId: trackId,
        protectedTransitionIds: protectedIds,
      });
      printJson({ ok: true, data: result });
      return true;
    }
    default:
      return false;
  }
}
