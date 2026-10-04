import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** Platform-aware candidate names for a bare command (PATHEXT on Windows). */
function candidateNames(command: string): string[] {
  const extList =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  return process.platform === "win32"
    ? [
        command,
        ...extList.map((ext) => `${command}${ext.toLowerCase()}`),
        ...extList.map((ext) => `${command}${ext}`),
      ]
    : [command];
}

/** Every PATH directory that holds the command, in PATH order. */
export async function findCommands(command: string): Promise<string[]> {
  const matches: string[] = [];
  const pathEnv = process.env.PATH ?? "";
  for (const rawDir of pathEnv.split(path.delimiter)) {
    const dir = rawDir.replace(/^"|"$/g, "");
    if (dir.length === 0) continue;
    for (const name of candidateNames(command)) {
      const full = path.join(dir, name);
      try {
        await access(full, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        matches.push(full);
      } catch {
        continue;
      }
    }
  }
  return matches;
}

export async function commandExists(command: string): Promise<boolean> {
  return (await findCommands(command)).length > 0;
}
