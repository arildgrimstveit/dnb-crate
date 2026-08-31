import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export async function commandExists(command: string): Promise<boolean> {
  const pathEnv = process.env.PATH ?? "";
  const extList =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const names =
    process.platform === "win32"
      ? [
          command,
          ...extList.map((ext) => `${command}${ext.toLowerCase()}`),
          ...extList.map((ext) => `${command}${ext}`),
        ]
      : [command];

  for (const dir of pathEnv.split(path.delimiter)) {
    for (const name of names) {
      try {
        await access(
          path.join(dir, name),
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}
