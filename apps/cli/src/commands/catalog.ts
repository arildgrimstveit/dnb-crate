import type { CatalogRuntime } from "@dnb-crate/catalog";

import { flag, option, printJson } from "../args.ts";

export async function run(
  command: string,
  args: string[],
  runtime: CatalogRuntime,
): Promise<boolean> {
  switch (command) {
    case "db:migrate":
      printJson({ ok: true, databasePath: "[configured]" });
      return true;
    case "library:scan": {
      const scanned = await runtime.service.scanLibrary({ dryRun: flag(args, "--dry-run") });
      printJson({ ok: true, data: scanned.result, warnings: scanned.warnings });
      return true;
    }
    case "library:stats": {
      const stats = runtime.service.getLibraryStats();
      printJson({ ok: true, data: stats });
      process.stderr.write(
        `analyzed ${stats.analysisCoverage.analyzed} / ${stats.trackCount} energy ${stats.metadataCoverage.energy}\n`,
      );
      return true;
    }
    case "track:search": {
      const limitRaw = option(args, "--limit");
      const result = runtime.service.searchTracks({
        query: option(args, "--query"),
        artist: option(args, "--artist"),
        limit: limitRaw === undefined ? undefined : Number(limitRaw),
      });
      printJson({ ok: true, data: result });
      return true;
    }
    default:
      return false;
  }
}
