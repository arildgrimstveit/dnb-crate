import { access, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import {
  probeAudioFile,
  resolveRubberbandCli,
  sha256File,
  detectFfmpeg,
  ffmpegAlignedReady,
  type ProcessRunner,
} from "@dnb-crate/audio-renderer";
import { resolvePlanRateRegionsVersion, type SetPlanV1, type AppConfig } from "@dnb-crate/domain";
import { probeKeyEngine } from "./analysis/key-engine.ts";
import { isPathInsideRoot } from "./paths.ts";

export type MixIssue = {
  code: string;
  severity: "error" | "warning";
  stage: string;
  trackIds?: string[];
  count?: number;
  retryable: boolean;
  message: string;
  nextAction: string;
};
export class PreflightService {
  constructor(
    private config: AppConfig,
    private runner: ProcessRunner,
  ) {}
  async keyIdentity(): Promise<string | null> {
    if (this.config.analysis?.keyAnalysis === "off") return null;
    try {
      return (await probeKeyEngine(this.config, this.runner)).identity ?? null;
    } catch {
      return null;
    }
  }

  async checkPlan(plan: SetPlanV1): Promise<MixIssue[]> {
    if (
      resolvePlanRateRegionsVersion(plan).version !== 2 &&
      !plan.entries.some((entry) => Math.abs(entry.playbackRate - 1) > 0.000001)
    )
      return [];
    const executable = resolveRubberbandCli(this.config.rubberbandPath);
    if (executable) {
      try {
        const result = await this.runner.run({ executable, args: ["--help"], timeoutMs: 10_000 });
        if (
          !result.timedOut &&
          /rubber.?band/i.test(result.stdout + result.stderr) &&
          /fine|finer|R3|--centre-focus/i.test(result.stdout + result.stderr)
        )
          return [];
      } catch {
        /* report actionable prerequisite */
      }
    }
    return [
      {
        code: "RUBBERBAND_REQUIRED",
        severity: "error",
        stage: "validate",
        retryable: true,
        message:
          "The actual plan requires standalone Rubber Band R3 for its timing/stretch policy.",
        nextAction: "Install Rubber Band 3 or later and configure rubberbandPath, then resume.",
      },
    ];
  }

  async verifyOutput(
    relative: string,
    durationMs: number,
    checksum?: string | null,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const root = await realpath(this.config.outputRoot);
      const file = await realpath(path.resolve(root, relative));
      if (!isPathInsideRoot(file, root)) return false;
      if (checksum && (await sha256File(file)) !== checksum) return false;
      const runner: ProcessRunner = {
        run: (request) => this.runner.run({ ...request, timeoutMs: 180_000, abortSignal }),
      };
      const binaries = await detectFfmpeg(runner, {
        ffmpegPath: this.config.ffmpegPath ?? "ffmpeg",
        ffprobePath: this.config.ffprobePath ?? "ffprobe",
      });
      if (!binaries) return false;
      const probe = await probeAudioFile(runner, binaries, file);
      if (Math.abs(probe.durationMs - durationMs) > 1000) return false;
      const decode = await runner.run({
        executable: binaries.ffmpegPath,
        args: ["-nostdin", "-v", "error", "-xerror", "-i", file, "-f", "null", "-"],
      });
      return decode.exitCode === 0 && !decode.timedOut;
    } catch {
      return false;
    }
  }

  async check(): Promise<{
    ready: boolean;
    issues: MixIssue[];
    dependencies: Record<string, string | null>;
  }> {
    const issues: MixIssue[] = [];
    const dependencies: Record<string, string | null> = {
      keyfinder: null,
      ffmpeg: null,
      ffprobe: null,
    };
    const issue = (
      code: string,
      message: string,
      nextAction: string,
      severity: "error" | "warning" = "error",
    ) => issues.push({ code, severity, stage: "preflight", retryable: true, message, nextAction });
    const roots: string[] = [];
    for (const [index, root] of this.config.libraryRoots.entries()) {
      try {
        if (!(await stat(root)).isDirectory()) throw new Error();
        await access(root, constants.R_OK);
        roots.push(await realpath(root));
      } catch {
        issue(
          "LIBRARY_ROOT_UNREADABLE",
          `Configured library root ${index + 1} is unreadable.`,
          "Correct libraryRoots and directory permissions.",
          "warning",
        );
      }
    }
    if (!roots.length)
      issue(
        "NO_READABLE_ROOT",
        "No configured library root is readable.",
        "Configure libraryRoots to contain a readable music folder.",
      );
    try {
      await mkdir(this.config.outputRoot, { recursive: true });
      const output = await realpath(this.config.outputRoot);
      if (roots.some((root) => isPathInsideRoot(output, root) || isPathInsideRoot(root, output))) {
        issue(
          "OUTPUT_CONTAINMENT",
          "outputRoot overlaps a library root.",
          "Configure a separate outputRoot outside libraryRoots.",
        );
      } else {
        const probe = await mkdtemp(path.join(output, ".dnb-write-"));
        await rm(probe, { recursive: true });
      }
    } catch {
      issue(
        "OUTPUT_UNWRITABLE",
        "outputRoot is not writable.",
        "Correct outputRoot and directory permissions.",
      );
    }
    try {
      const binaries = await detectFfmpeg(
        { run: (request) => this.runner.run({ ...request, timeoutMs: 10_000 }) },
        {
          ffmpegPath: this.config.ffmpegPath ?? "ffmpeg",
          ffprobePath: this.config.ffprobePath ?? "ffprobe",
        },
      );
      if (binaries) {
        const encoders = await this.runner.run({
          executable: binaries.ffmpegPath,
          args: ["-hide_banner", "-encoders"],
          timeoutMs: 10_000,
        });
        const names = encoders.stdout + encoders.stderr;
        if (
          encoders.exitCode !== 0 ||
          encoders.timedOut ||
          !/\bflac\b/.test(names) ||
          !/\bpcm_s16le\b/.test(names)
        )
          issue(
            "FFMPEG_ENCODER_UNAVAILABLE",
            "FFmpeg lacks FLAC or PCM output encoding.",
            "Install an FFmpeg build with flac and pcm_s16le encoders.",
          );
      }
      dependencies.ffmpeg = binaries?.ffmpegVersion ?? null;
      dependencies.ffprobe = binaries?.ffprobeVersion ?? null;
      if (!binaries || !ffmpegAlignedReady(binaries))
        issue(
          "FFMPEG_UNAVAILABLE",
          "FFmpeg/ffprobe or required audio filters are unavailable.",
          "Install supported FFmpeg and ffprobe; configure ffmpegPath and ffprobePath.",
        );
    } catch {
      issue(
        "FFMPEG_UNAVAILABLE",
        "FFmpeg/ffprobe could not be executed.",
        "Install supported FFmpeg and ffprobe; configure ffmpegPath and ffprobePath.",
      );
    }
    if (this.config.analysis?.keyAnalysis !== "off") {
      try {
        const keyfinder = await probeKeyEngine(this.config, this.runner);
        dependencies.keyfinder = keyfinder.identity ?? null;
        if (!keyfinder.available)
          issue(
            "KEYFINDER_UNAVAILABLE",
            "Automatic key detection is unavailable; existing valid keys may still satisfy the brief.",
            "Install keyfinder-cli or configure keyfinderPath.",
            "warning",
          );
      } catch {
        issue(
          "KEYFINDER_CONFIG_INVALID",
          "keyfinderPath is not a usable executable.",
          "Correct keyfinderPath or DNB_CRATE_KEYFINDER_PATH.",
        );
      }
    }
    return { ready: !issues.some((item) => item.severity === "error"), issues, dependencies };
  }
}
