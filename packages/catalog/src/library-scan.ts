import {
  SCAN_WARNING_LIMIT,
  type AppConfig,
  type Logger,
  type ScanLibraryResult,
} from "@dnb-crate/domain";

import { fingerprintFile } from "./fingerprint.ts";
import { extractAudioMetadata } from "./metadata.ts";
import { isPathInsideAnyRoot, normalizedPath } from "./paths.ts";
import type { TrackRepository } from "./repository.ts";
import { walkLibrary } from "./scanner.ts";

function capWarnings(warnings: string[]): string[] {
  if (warnings.length <= SCAN_WARNING_LIMIT) {
    return warnings;
  }
  const extra = warnings.length - SCAN_WARNING_LIMIT;
  return [...warnings.slice(0, SCAN_WARNING_LIMIT), `…and ${extra} more warning(s)`];
}

/** Discover, import, and reconcile files; filesystem traversal stays in scanner.ts. */
export async function scanLibrary(
  config: AppConfig,
  repository: TrackRepository,
  logger: Logger,
  options: { dryRun?: boolean } = {},
): Promise<{ result: ScanLibraryResult; warnings: string[] }> {
  const dryRun = options.dryRun ?? false;
  const walk = await walkLibrary(config, logger);
  const warnings = [...walk.warnings];
  const seenPaths = new Set<string>();
  let upserted = 0;
  let moved = 0;
  let skippedMalformed = 0;

  const resolved = walk.resolvedRoots;

  for (const file of walk.files) {
    seenPaths.add(normalizedPath(file.realPath));
    try {
      const metadata = await extractAudioMetadata(file.realPath);
      const fileFingerprint = await fingerprintFile(file.realPath, {
        size: file.size,
        mtimeMs: file.mtimeMs,
      });
      if (dryRun) {
        upserted += 1;
        continue;
      }
      const written = repository.upsertFromScan({
        filePath: file.realPath,
        fileFingerprint,
        artist: metadata.artist,
        title: metadata.title,
        album: metadata.album,
        durationMs: metadata.durationMs,
        sampleRateHz: metadata.sampleRateHz,
        channels: metadata.channels,
        bpm: metadata.bpm,
        bpmSource: metadata.bpmSource,
        musicalKey: metadata.musicalKey,
        camelotKey: metadata.camelotKey,
        keySource: metadata.keySource,
        label: metadata.label,
        releaseDate: metadata.releaseDate,
        isrc: metadata.isrc,
        recordingMbid: metadata.recordingMbid,
        genres: metadata.genres,
      });
      upserted += 1;
      if (written.moved) {
        moved += 1;
      }
    } catch (error) {
      skippedMalformed += 1;
      warnings.push(
        `Malformed or unreadable audio: ${file.relativeFromRoot}. ` +
          `Check that the file is readable and plays locally; replace or re-export it if damaged. ` +
          `Renaming a file extension does not convert audio. (${String(error)})`,
      );
      logger.warn({ file: file.relativeFromRoot, err: String(error) }, "skipped malformed audio");
    }
  }

  let markedMissing = 0;
  if (!dryRun && walk.complete) {
    const missingIds: string[] = [];
    for (const entry of repository.listPathIndex()) {
      if (!isPathInsideAnyRoot(entry.filePath, resolved)) {
        continue;
      }
      if (!seenPaths.has(normalizedPath(entry.filePath))) {
        missingIds.push(entry.id);
      }
    }
    repository.markMissing(missingIds);
    markedMissing = missingIds.length;
  }
  if (!dryRun && !walk.complete) {
    warnings.push(
      "Scan incomplete; existing file availability was preserved. Retry the scan after resolving unreadable paths.",
    );
  }

  return {
    result: {
      dryRun,
      rootsScanned: resolved.length,
      filesSeen: walk.files.length,
      upserted,
      moved,
      skippedUnsupported: walk.skippedUnsupported,
      skippedMalformed,
      markedMissing,
    },
    warnings: capWarnings(warnings),
  };
}
