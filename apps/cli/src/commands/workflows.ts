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
    case "mix:preflight": {
      printJson({ ok: true, data: await runtime.workflows.preflight.check() });
      return true;
    }
    case "mix:create":
    case "mix:resume":
    case "mix:status":
    case "mix:cancel": {
      const id = option(args, "--id");
      if (command !== "mix:create" && !id) throw new Error(`${command} requires --id`);
      let workflow: ReturnType<typeof runtime.workflows.get>;
      if (command === "mix:create") {
        const briefPath = option(args, "--brief-json");
        const numberOption = (name: string) =>
          option(args, name) === undefined ? undefined : Number(option(args, name));
        const brief = createSetPlanInputSchema.parse(
          briefPath
            ? JSON.parse(readFileSync(briefPath, "utf8"))
            : {
                name: option(args, "--name"),
                targetDurationMinutes: numberOption("--duration-min"),
                targetDurationMs: numberOption("--duration-ms"),
                seed: numberOption("--seed"),
              },
        );
        workflow = runtime.workflows.start({
          brief,
          requestToken: option(args, "--request-token") ?? crypto.randomUUID(),
        });
      } else if (command === "mix:resume") workflow = await runtime.workflows.resume(id!);
      else if (command === "mix:cancel") workflow = runtime.workflows.cancel(id!);
      else workflow = runtime.workflows.get(id!);
      if (flag(args, "--wait") && (command === "mix:create" || command === "mix:resume")) {
        process.stderr.write(`Mix workflow ${workflow.id} started.\n`);
        let last = "";
        const progress = setInterval(() => {
          const current = runtime.workflows.get(workflow.id);
          const message = `${current.stage}${current.progress ? ` ${current.progress.completed}/${current.progress.total}` : ""}`;
          if (message !== last) {
            process.stderr.write(`${message}\n`);
            last = message;
          }
        }, 1000);
        try {
          workflow = await runtime.workflows.wait(workflow.id);
        } finally {
          clearInterval(progress);
        }
      }
      const unsuccessful = workflow.status === "failed" || workflow.status === "blocked";
      printJson(
        unsuccessful
          ? {
              ok: false,
              error: {
                code: `MIX_WORKFLOW_${workflow.status.toUpperCase()}`,
                message: `${workflow.issues[0]?.message ?? `Mix workflow ended ${workflow.status}.`} (stage ${workflow.stage}; run mix:status --id ${workflow.id} for the full report)`,
                retryable: workflow.status === "blocked",
                details: { stage: workflow.stage, issues: workflow.issues },
              },
            }
          : { ok: true, data: workflow },
      );
      if (unsuccessful) process.exitCode = 1;
      return true;
    }
    default:
      return false;
  }
}
