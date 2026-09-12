import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProcessRunner, RunRequest, RunResult } from "./runner.ts";

function buildSineWav(durationMs: number, sampleRate = 48_000): Buffer {
  const frameCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const data = Buffer.alloc(frameCount * 4);
  for (let i = 0; i < frameCount; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000);
    data.writeInt16LE(sample, i * 4);
    data.writeInt16LE(sample, i * 4 + 2);
  }
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, 4, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(2, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 4, 16);
  fmt.writeUInt16LE(4, 20);
  fmt.writeUInt16LE(16, 22);
  const dataChunk = Buffer.alloc(8 + data.length);
  dataChunk.write("data", 0, 4, "ascii");
  dataChunk.writeUInt32LE(data.length, 4);
  data.copy(dataChunk, 8);
  const inner = Buffer.concat([Buffer.from("WAVE", "ascii"), fmt, dataChunk]);
  const riff = Buffer.alloc(8 + inner.length);
  riff.write("RIFF", 0, 4, "ascii");
  riff.writeUInt32LE(inner.length, 4);
  inner.copy(riff, 8);
  return riff;
}

function lastOutputPath(args: string[]): string | null {
  const last = args.at(-1);
  if (!last || last === "-" || last.startsWith("-")) {
    return null;
  }
  if (args.includes("pipe:1") && last === "pipe:1") {
    return null;
  }
  return last;
}

/**
 * In-process FFmpeg stand-in for unit tests. Writes a short WAV and English ebur128 text.
 */
export function createFakeFfmpegRunner(
  options: { delayMs?: number; failOn?: "mix" | "probe" | "never"; hangUntilAbort?: boolean } = {},
): ProcessRunner {
  const failOn = options.failOn ?? "never";
  return {
    async run(request: RunRequest): Promise<RunResult> {
      if (request.abortSignal?.aborted) {
        return { exitCode: 1, signal: "SIGTERM", stdout: "", stderr: "aborted" };
      }
      if (options.hangUntilAbort) {
        const isMeta =
          request.args.includes("-version") ||
          request.args.includes("-filters") ||
          request.args.includes("-h") ||
          request.args.includes("-print_format") ||
          (request.args.includes("-filter_complex_script") && !request.args.includes("-i")) ||
          request.args.some((arg) => arg.includes("ebur128")) ||
          request.args.some((arg) => arg.includes("silencedetect"));
        if (!isMeta) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => resolve(), 30_000);
            request.abortSignal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              },
              { once: true },
            );
          }).catch((error: unknown) => {
            if (error instanceof Error && error.name === "AbortError") {
              throw error;
            }
          });
          return { exitCode: 1, signal: "SIGTERM", stdout: "", stderr: "aborted" };
        }
      }
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }

      const joined = `${request.executable} ${request.args.join(" ")}`;
      const isProbe = /ffprobe/i.test(request.executable) || request.args.includes("-print_format");
      const isVersion = request.args.includes("-version");
      const isFilters = request.args.includes("-filters");
      const isAfadeHelp = request.args.includes("-h") && request.args.some((arg) => arg.includes("afade"));
      const isEbur = request.args.some((arg) => arg.includes("ebur128"));
      const isSilence = request.args.some((arg) => arg.includes("silencedetect"));

      if (isVersion) {
        const name = /ffprobe/i.test(request.executable) ? "ffprobe" : "ffmpeg";
        return {
          exitCode: 0,
          signal: null,
          stdout: `${name} version 7.0.2-test Copyright (c) fake\n`,
          stderr: "",
        };
      }
      if (isAfadeHelp) {
        return {
          exitCode: 0,
          signal: null,
          stdout: "Filter afade\n  silence, unity — start/end gain for partial fades\n",
          stderr: "",
        };
      }
      if (isFilters) {
        return {
          exitCode: 0,
          signal: null,
          stdout:
            " ... acrossfade\n ... ebur128\n ... alimiter\n ... aformat\n ... atrim\n ... atempo\n ... rubberband\n ... lowpass\n ... highpass\n ... asplit\n ... amix\n ... afade\n ... adelay\n",
          stderr: "",
        };
      }
      if (isProbe) {
        if (failOn === "probe") {
          return { exitCode: 1, signal: null, stdout: "", stderr: "Invalid data found" };
        }
        const probed = lastOutputPath(request.args);
        const codecName = probed?.toLowerCase().endsWith(".flac") ? "flac" : "pcm_s24le";
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            streams: [
              {
                codec_type: "audio",
                codec_name: codecName,
                sample_rate: "48000",
                channels: 2,
                duration: "1.000000",
              },
            ],
            format: { duration: "1.000000" },
          }),
          stderr: "",
        };
      }
      if (request.args.includes("chromaprint")) {
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({ duration: 180, fingerprint: "FAKECHROMAPRINT" }),
          stderr: "",
        };
      }
      if (isEbur) {
        const text = `Summary:\n  Integrated loudness:\n    I:         -14.2 LUFS\n  True peak:\n    Peak:       -1.20 dBFS\n`;
        request.onStderr?.(text);
        return { exitCode: 0, signal: null, stdout: "", stderr: text };
      }
      if (isSilence) {
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (failOn === "mix" && !isProbe) {
        return { exitCode: 1, signal: null, stdout: "", stderr: "Error opening input files" };
      }

      const output = lastOutputPath(request.args);
      if (output && output !== "-") {
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, buildSineWav(1000));
        const progress = "out_time_us=1000000\nprogress=end\n";
        request.onStdout?.(progress);
        return { exitCode: 0, signal: null, stdout: progress, stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: joined };
    },
  };
}
