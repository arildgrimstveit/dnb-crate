import { readdir, realpath, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readScratchOwner } from "../scratch.ts";

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
  // render:check deck-probe and phase-4 scratch (unique per invocation).
  /\.phase4-\d+-[0-9a-f]+\.pcm$/i,
  /\.deck-(out|in)-\d+-[0-9a-f]+\.pcm$/i,
];

/** Scratch directories this codebase creates in the OS temp dir (analysis
 * decode, render fixtures, engine probes). Anything with our prefix that has
 * been idle past the sweep age is fair game; foreign directories are never
 * touched. */
const TMP_DIR_PREFIXES: RegExp[] = [/^dnb-/];

/** Only files untouched for this long are swept, so a still-running or very
 * recently killed render's working files are never deleted from under it. */
export const TEMP_SWEEP_MIN_AGE_MS = 60 * 60 * 1000;

function isTempFileName(name: string): boolean {
  return TEMP_PATTERNS.some((pattern) => pattern.test(name));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission failures are not evidence that another worker is dead.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** True when the directory sits inside (not merely named like) the OS temp
 * dir after resolving symlinks — a symlinked dnb-* entry must never let the
 * sweep delete content outside the temp dir (F10 containment). */
async function insideTempDir(full: string, tmpRoot: string): Promise<boolean> {
  try {
    const resolved = await realpath(full);
    return resolved === tmpRoot || resolved.startsWith(tmpRoot + path.sep);
  } catch {
    return false;
  }
}

export async function sweepStaleRenderTemps(
  outputRoot: string,
  options: {
    now?: () => number;
    isAlive?: (pid: number) => boolean;
    logger?: { warn: (obj: Record<string, unknown> | string, msg?: string) => void };
  } = {},
): Promise<string[]> {
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? processIsAlive;
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
  // Safety net for scratch dirs leaked into the OS temp dir (analysis
  // decode folders, test fixtures, engine probes). Only our own prefixes,
  // only past the age threshold, and only when the directory's owner marker
  // is absent (legacy) or its process is dead: a long-running job in a live
  // process is never deleted from under it, however old its directory mtime
  // is (F10: directory mtime is not proof that children are inactive).
  try {
    const tmpRoot = await realpath(os.tmpdir());
    const tmpEntries = await readdir(os.tmpdir(), { withFileTypes: true });
    for (const entry of tmpEntries) {
      if (!entry.isDirectory() || !TMP_DIR_PREFIXES.some((p) => p.test(entry.name))) {
        continue;
      }
      const full = path.join(os.tmpdir(), entry.name);
      try {
        if (!(await insideTempDir(full, tmpRoot))) {
          options.logger?.warn(
            { dir: entry.name },
            "Temp sweep skipped a scratch directory outside the temp root (symlink?)",
          );
          continue;
        }
        const info = await stat(full);
        if (now() - info.mtimeMs < TEMP_SWEEP_MIN_AGE_MS) continue;
        const owner = await readScratchOwner(full);
        if (owner && isAlive(owner.pid)) {
          // Owned by a live process: recognized ACTIVE work, not abandoned.
          continue;
        }
        await rm(full, { recursive: true, force: true });
        removed.push(full);
      } catch (error) {
        options.logger?.warn({ err: error, dir: entry.name }, "Temp sweep skipped a directory");
      }
    }
  } catch {
    // Temp dir unreadable: nothing to sweep.
  }
  return removed;
}
