/** How a CLI command uses the catalog worker. */
export type CliWorkerNeed = "none" | "enqueue" | "process";

const JOB_COMMANDS = new Set([
  "analysis:start",
  "analysis:run",
  "enrich:run",
  "render:start",
  "render:preview",
]);

/** Commands that enqueue work. Without --wait they must not claim it. */
export function cliWorkerNeed(command: string, args: string[]): CliWorkerNeed {
  if (command === "analysis:gate") {
    return "process";
  }
  if (!JOB_COMMANDS.has(command)) {
    return "none";
  }
  return args.includes("--wait") ? "process" : "enqueue";
}

export const NO_WORKER_MESSAGE =
  "No active catalog worker. Pass --wait to process this job here, or keep the MCP server running.";
