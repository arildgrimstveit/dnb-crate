import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { DomainError, type AppConfig, type Logger } from "@dnb-crate/domain";

import { isPathInsideAnyRoot, isPathInsideRoot, relativeToRoots } from "./paths.ts";

export type DiscoveredAudioFile = {
  realPath: string;
  relativeFromRoot: string;
  extension: string;
  size: number;
  mtimeMs: number;
};

export type WalkResult = {
  files: DiscoveredAudioFile[];
  skippedUnsupported: number;
  warnings: string[];
};

async function safeRealpath(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

export async function resolveLibraryRoots(
  roots: string[],
): Promise<{ resolved: string[]; warnings: string[] }> {
  const resolved: string[] = [];
  const warnings: string[] = [];
  for (const root of roots) {
    const real = await safeRealpath(root);
    if (real === null) {
      warnings.push(`Library root does not exist or is unreadable: ${root}`);
      continue;
    }
    resolved.push(real);
  }
  return { resolved, warnings };
}

export async function walkLibrary(config: AppConfig, logger: Logger): Promise<WalkResult> {
  const { resolved, warnings } = await resolveLibraryRoots(config.libraryRoots);
  const files: DiscoveredAudioFile[] = [];
  let skippedUnsupported = 0;
  const allowed = new Set(config.supportedExtensions.map((ext) => ext.toLowerCase()));

  async function visit(current: string): Promise<void> {
    const realDir = await safeRealpath(current);
    if (realDir === null) {
      warnings.push(`Unreadable directory: ${relativeToRoots(current, resolved)}`);
      return;
    }
    if (!isPathInsideAnyRoot(realDir, resolved)) {
      warnings.push(
        `Skipped directory outside library roots: ${relativeToRoots(current, resolved)}`,
      );
      return;
    }

    let entries;
    try {
      entries = await readdir(realDir, { withFileTypes: true });
    } catch (error) {
      warnings.push(`Failed to read directory: ${relativeToRoots(realDir, resolved)}`);
      logger.warn({ err: String(error) }, "readdir failed");
      return;
    }

    for (const entry of entries) {
      const full = path.join(realDir, entry.name);
      let info;
      try {
        info = await lstat(full);
      } catch {
        warnings.push(`Unreadable path: ${relativeToRoots(full, resolved)}`);
        continue;
      }

      if (info.isSymbolicLink()) {
        const linked = await safeRealpath(full);
        if (linked === null) {
          warnings.push(`Broken symlink: ${relativeToRoots(full, resolved)}`);
          continue;
        }
        if (!isPathInsideAnyRoot(linked, resolved)) {
          warnings.push(
            `Skipped symlink escaping library roots: ${relativeToRoots(full, resolved)}`,
          );
          continue;
        }
        const linkedStat = await stat(linked);
        if (linkedStat.isDirectory()) {
          await visit(linked);
          continue;
        }
        considerFile(linked, linkedStat.size, linkedStat.mtimeMs);
        continue;
      }

      if (info.isDirectory()) {
        await visit(full);
        continue;
      }

      if (info.isFile()) {
        considerFile(full, info.size, info.mtimeMs);
      }
    }
  }

  function considerFile(realPath: string, size: number, mtimeMs: number): void {
    if (!isPathInsideAnyRoot(realPath, resolved)) {
      throw new DomainError("PATH_OUTSIDE_LIBRARY_ROOT", "Resolved file is outside library roots", {
        details: { relative: relativeToRoots(realPath, resolved) },
      });
    }
    const extension = path.extname(realPath).toLowerCase();
    if (!allowed.has(extension)) {
      skippedUnsupported += 1;
      return;
    }
    files.push({
      realPath,
      relativeFromRoot: relativeToRoots(realPath, resolved),
      extension,
      size,
      mtimeMs,
    });
  }

  for (const root of resolved) {
    if (!isPathInsideRoot(root, root)) {
      continue;
    }
    await visit(root);
  }

  return { files, skippedUnsupported, warnings };
}
