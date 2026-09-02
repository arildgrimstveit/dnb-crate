import * as z from "zod/v4";

import {
  ANALYSIS_ENGINE_IDS,
  DEFAULT_ANALYSIS_ENGINE,
  DEFAULT_SUPPORTED_EXTENSIONS,
} from "./constants.ts";

export const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);

export const analysisEngineIdSchema = z.enum(ANALYSIS_ENGINE_IDS);

export const analysisConfigSchema = z
  .object({
    defaultEngine: analysisEngineIdSchema.default(DEFAULT_ANALYSIS_ENGINE),
    engines: z
      .object({
        python: z
          .object({
            enabled: z.boolean().default(false),
            pythonPath: z.string().min(1).optional(),
            scriptPath: z.string().min(1).optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .optional();

export const appConfigSchema = z.object({
  databasePath: z.string().min(1, "databasePath is required"),
  libraryRoots: z.array(z.string().min(1)).min(1, "At least one library root is required"),
  outputRoot: z.string().min(1, "outputRoot is required"),
  logLevel: logLevelSchema.default("info"),
  supportedExtensions: z
    .array(z.string().startsWith("."))
    .min(1)
    .default([...DEFAULT_SUPPORTED_EXTENSIONS]),
  loudnessTargetLufs: z.number().min(-70).max(0).optional(),
  truePeakCeilingDb: z.number().min(-9).max(0).optional(),
  renderSampleRateHz: z.number().int().min(44_100).max(48_000).optional(),
  renderWorkerLimit: z.number().int().min(1).max(4).optional(),
  previewWindowMs: z.number().int().min(30_000).max(60_000).optional(),
  renderEdgeFadeMs: z.number().int().min(0).max(5_000).optional(),
  ffmpegPath: z.string().min(1).optional(),
  ffprobePath: z.string().min(1).optional(),
  analysis: analysisConfigSchema,
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;
export type AnalysisConfig = NonNullable<AppConfig["analysis"]>;
