import { readFileSync } from "node:fs";

import type { CatalogRuntime } from "@dnb-crate/catalog";
import { createSetPlanInputSchema } from "@dnb-crate/domain";

import { flag, option, printJson } from "../args.ts";

export async function run(
  command: string,
  args: string[],
  runtime: CatalogRuntime,
): Promise<boolean> {
  switch (command) {
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
        return true;
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
      return true;
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
      return true;
    }
    case "plan:list":
      printJson({ ok: true, data: runtime.service.listSetPlans() });
      return true;
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
      return true;
    }
    case "plan:quality": {
      const id = option(args, "--id");
      if (!id) {
        throw new Error("plan:quality requires --id");
      }
      printJson({ ok: true, data: runtime.service.reportSetPlanQuality(id) });
      return true;
    }
    case "plan:delete": {
      const id = option(args, "--id");
      if (!id) {
        throw new Error("plan:delete requires --id");
      }
      if (!flag(args, "--confirm")) {
        throw new Error("plan:delete requires --confirm");
      }
      printJson({ ok: true, data: runtime.service.deleteSetPlan(id, true) });
      return true;
    }
    case "hour:feedback": {
      const renderJobId = option(args, "--id");
      const outputChecksum = option(args, "--checksum");
      const quote = option(args, "--quote");
      const accepted = option(args, "--accepted");
      if (!renderJobId || !outputChecksum || !quote || !["true", "false"].includes(accepted ?? ""))
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
      return true;
    }
    case "hour:history": {
      printJson({ ok: true, data: runtime.service.listHourFeedback(option(args, "--id")) });
      return true;
    }
    case "plan:validate": {
      const id = option(args, "--id");
      if (!id) {
        throw new Error("plan:validate requires --id");
      }
      printJson({ ok: true, data: await runtime.service.validateSavedSetPlan(id) });
      return true;
    }
    default:
      return false;
  }
}
