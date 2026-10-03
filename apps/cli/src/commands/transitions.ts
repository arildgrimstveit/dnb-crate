import { readFileSync } from "node:fs";

import type { CatalogRuntime } from "@dnb-crate/catalog";
import { listTransitionFeedbackInputSchema, rateTransitionInputSchema } from "@dnb-crate/domain";

import { option, printJson } from "../args.ts";

/** Synchronous command group (no waits); kept dispatch-compatible with the
 * async groups. */
export function run(command: string, args: string[], runtime: CatalogRuntime): boolean {
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
    default:
      return false;
  }
}
