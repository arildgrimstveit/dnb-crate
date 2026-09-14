import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { appConfigSchema, type AppConfig } from "./config.ts";
import { DomainError } from "./errors.ts";

export type ConfigLoadOptions = {
  env?: NodeJS.Dict<string>;
  cwd?: string;
  defaultConfigFileName?: string;
};

function parseLibraryRoots(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new DomainError(
        "CONFIG_INVALID",
        "DNB_CRATE_LIBRARY_ROOTS must be a JSON array of strings",
      );
    }
    const roots: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") {
        throw new DomainError(
          "CONFIG_INVALID",
          "DNB_CRATE_LIBRARY_ROOTS must be a JSON array of strings",
        );
      }
      roots.push(item);
    }
    return roots;
  }
  return trimmed
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readConfigFile(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DomainError("CONFIG_INVALID", `Config file must be a JSON object: ${filePath}`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError(
      "CONFIG_INVALID",
      `Failed to read config file ${filePath}: ${String(error)}`,
      {
        cause: error,
      },
    );
  }
}

function resolvePathValue(value: string, cwd: string): string {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

/**
 * Load configuration from an optional JSON file plus environment overlays.
 * Relative paths resolve against `cwd` (default process.cwd()).
 */
export function loadConfig(options: ConfigLoadOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const defaultName = options.defaultConfigFileName ?? "dnb-crate.config.json";

  let fromFile: Record<string, unknown> = {};
  const explicitConfigPath = env.DNB_CRATE_CONFIG;
  if (explicitConfigPath && explicitConfigPath.trim().length > 0) {
    const resolved = resolvePathValue(explicitConfigPath, cwd);
    if (!existsSync(resolved)) {
      throw new DomainError(
        "CONFIG_INVALID",
        `DNB_CRATE_CONFIG points to a missing file: ${explicitConfigPath}`,
      );
    }
    fromFile = readConfigFile(resolved);
  } else {
    const fallback = path.resolve(cwd, defaultName);
    if (existsSync(fallback)) {
      fromFile = readConfigFile(fallback);
    }
  }

  const merged: Record<string, unknown> = { ...fromFile };

  if (env.DNB_CRATE_DATABASE_PATH) {
    merged.databasePath = env.DNB_CRATE_DATABASE_PATH;
  }
  if (env.DNB_CRATE_OUTPUT_ROOT) {
    merged.outputRoot = env.DNB_CRATE_OUTPUT_ROOT;
  }
  if (env.DNB_CRATE_LOG_LEVEL) {
    merged.logLevel = env.DNB_CRATE_LOG_LEVEL;
  }
  if (env.DNB_CRATE_LIBRARY_ROOTS) {
    try {
      merged.libraryRoots = parseLibraryRoots(env.DNB_CRATE_LIBRARY_ROOTS);
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError(
        "CONFIG_INVALID",
        `DNB_CRATE_LIBRARY_ROOTS is not valid JSON or a path list: ${String(error)}`,
        { cause: error },
      );
    }
  }
  if (env.DNB_CRATE_LOUDNESS_TARGET_LUFS) {
    merged.loudnessTargetLufs = Number(env.DNB_CRATE_LOUDNESS_TARGET_LUFS);
  }
  if (env.DNB_CRATE_TRUE_PEAK_CEILING_DB) {
    merged.truePeakCeilingDb = Number(env.DNB_CRATE_TRUE_PEAK_CEILING_DB);
  }
  if (env.DNB_CRATE_RENDER_WORKER_LIMIT) {
    merged.renderWorkerLimit = Number(env.DNB_CRATE_RENDER_WORKER_LIMIT);
  }
  if (env.DNB_CRATE_FFMPEG_PATH) {
    merged.ffmpegPath = env.DNB_CRATE_FFMPEG_PATH;
  }
  if (env.DNB_CRATE_FFPROBE_PATH) {
    merged.ffprobePath = env.DNB_CRATE_FFPROBE_PATH;
  }
  if (env.DNB_CRATE_KEYFINDER_PATH) {
    merged.keyfinderPath = env.DNB_CRATE_KEYFINDER_PATH;
  }
  if (env.DNB_CRATE_RUBBERBAND_PATH) {
    merged.rubberbandPath = env.DNB_CRATE_RUBBERBAND_PATH;
  }
  if (env.DNB_CRATE_SUPPORTED_EXTENSIONS) {
    try {
      const parsed: unknown = JSON.parse(env.DNB_CRATE_SUPPORTED_EXTENSIONS);
      merged.supportedExtensions = parsed;
    } catch (error) {
      throw new DomainError(
        "CONFIG_INVALID",
        'DNB_CRATE_SUPPORTED_EXTENSIONS must be a JSON array such as [".wav",".mp3"]',
        { cause: error },
      );
    }
  }

  if (env.DNB_CRATE_ACOUSTID_API_KEY || env.DNB_CRATE_ENRICHMENT_CONTACT) {
    const existing =
      merged.enrichment &&
      typeof merged.enrichment === "object" &&
      !Array.isArray(merged.enrichment)
        ? { ...(merged.enrichment as Record<string, unknown>) }
        : {};
    if (env.DNB_CRATE_ENRICHMENT_CONTACT) {
      existing.contact = env.DNB_CRATE_ENRICHMENT_CONTACT;
    }
    if (env.DNB_CRATE_ACOUSTID_API_KEY) {
      const acoustid =
        existing.acoustid &&
        typeof existing.acoustid === "object" &&
        !Array.isArray(existing.acoustid)
          ? { ...(existing.acoustid as Record<string, unknown>) }
          : {};
      acoustid.apiKey = env.DNB_CRATE_ACOUSTID_API_KEY;
      existing.acoustid = acoustid;
    }
    merged.enrichment = existing;
  }

  const parsed = appConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new DomainError(
      "CONFIG_INVALID",
      parsed.error.issues.map((issue) => issue.message).join("; "),
      {
        details: { issues: parsed.error.issues },
      },
    );
  }

  return {
    ...parsed.data,
    databasePath: resolvePathValue(parsed.data.databasePath, cwd),
    outputRoot: resolvePathValue(parsed.data.outputRoot, cwd),
    libraryRoots: parsed.data.libraryRoots.map((root) => resolvePathValue(root, cwd)),
    supportedExtensions: parsed.data.supportedExtensions.map((ext) => ext.toLowerCase()),
    keyfinderPath: parsed.data.keyfinderPath
      ? resolvePathValue(parsed.data.keyfinderPath, cwd)
      : undefined,
    rubberbandPath: parsed.data.rubberbandPath
      ? resolvePathValue(parsed.data.rubberbandPath, cwd)
      : undefined,
  };
}
