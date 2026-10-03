import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

/** Render working files that a hard-killed process (SIGKILL, power loss) can
 * leave behind next to its outputs. Each renderer call cleans up in `finally`,
 * but nothing sweeps the leftovers of a process that never ran its handlers.
 */
const TEMP_PATTERNS: RegExp[] = [
  /\.partial\.wav$/i,
  /\.partial\.flac$/i,
  /\.gained\.wav$/i,
  /\.peak-limited\.wav$/i,
  /\.join-\d+\.wav$/i,
  /\.stitch-\d+\.wav$/i,
  /\.rb\d+\.slice\.wav$/i,
  /\.rb\d+\.wav$/i,
];

/** Only files untouched for this long are swept, so a still-running or very
 * recently killed render's working files are never deleted from under it. */
export const TEMP_SWEEP_MIN_AGE_MS = 60 * 60 * 1000;

function isTempFileName(name: string): boolean {
  return TEMP_PATTERNS.some((pattern) => pattern.test(name));
}

export async function sweepStaleRenderTemps(
  outputRoot: string,
  options: {
    now?: () => number;
    logger?: { warn: (obj: Record<string, unknown> | string, msg?: string) => void };
  } = {},
): Promise<string[]> {
  const now = options.now ?? Date.now;
  const removed: string[] = [];
  const directories: string[] = [outputRoot];
  while (directories.length > 0) {
    const dir = directories.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // Missing or unreadable directory: nothing to sweep.
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        directories.push(full);
        continue;
      }
      if (!entry.isFile() || !isTempFileName(entry.name)) continue;
      try {
        const info = await stat(full);
        if (now() - info.mtimeMs < TEMP_SWEEP_MIN_AGE_MS) continue;
        await unlink(full);
        removed.push(full);
      } catch (error) {
        options.logger?.warn(
          { err: error, file: path.basename(full) },
          "Temp sweep skipped a file",
        );
      }
    }
  }
  return removed;
}
