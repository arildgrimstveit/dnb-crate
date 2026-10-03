import { createCatalogRuntime, hasLiveWorker, type CatalogRuntime } from "@dnb-crate/catalog";
import { APP_NAME, isDomainError, loadConfig, type Logger } from "@dnb-crate/domain";
import pino from "pino";

import { run as runAnalysisCommands } from "./commands/analysis.ts";
import { run as runCatalogCommands } from "./commands/catalog.ts";
import { run as runPlanCommands } from "./commands/plans.ts";
import { run as runRenderCommands } from "./commands/renders.ts";
import { run as runTransitionCommands } from "./commands/transitions.ts";
import { run as runWorkflowCommands } from "./commands/workflows.ts";
import { usage } from "./usage.ts";
import { cliWorkerNeed, NO_WORKER_MESSAGE } from "./worker-policy.ts";

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

const COMMAND_MODULES: Array<
  (command: string, args: string[], runtime: CatalogRuntime) => boolean | Promise<boolean>
> = [
  runWorkflowCommands,
  runCatalogCommands,
  runAnalysisCommands,
  runTransitionCommands,
  runPlanCommands,
  runRenderCommands,
];

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
    for (const run of COMMAND_MODULES) {
      if (await run(command, args, runtime)) {
        return;
      }
    }
    process.stderr.write(`Unknown command: ${command}\n\n${usage()}`);
    process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  // Keep stdout machine-readable even for unexpected failures: the envelope
  // carries the domain error code when there is one.
  const body = isDomainError(error)
    ? { code: error.code, message: error.message, retryable: error.retryable }
    : { code: "INTERNAL_ERROR", message: "CLI command failed; see stderr.", retryable: false };
  process.stdout.write(`${JSON.stringify({ ok: false, error: body })}\n`);
  process.exitCode = 1;
});
