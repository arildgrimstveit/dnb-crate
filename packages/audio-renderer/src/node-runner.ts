import { spawn } from "node:child_process";

import { FFMPEG_STDERR_LIMIT_BYTES } from "@dnb-crate/domain";

import { ProcessRunError, type ProcessRunner, type RunRequest, type RunResult } from "./runner.ts";

function bound(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  const buf = Buffer.from(text, "utf8");
  return buf.subarray(buf.length - maxBytes).toString("utf8");
}

/**
 * Spawn FFmpeg/ffprobe with an argument array. Never uses a shell.
 */
export function createNodeProcessRunner(
  options: { stderrLimitBytes?: number } = {},
): ProcessRunner {
  const stderrLimit = options.stderrLimitBytes ?? FFMPEG_STDERR_LIMIT_BYTES;
  return {
    run(request: RunRequest): Promise<RunResult> {
      return new Promise((resolve, reject) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(request.executable, request.args, {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            cwd: request.cwd,
          });
        } catch (error) {
          const code =
            error instanceof Error && "code" in error
              ? String((error as NodeJS.ErrnoException).code)
              : undefined;
          reject(
            new ProcessRunError(`Failed to spawn ${request.executable}`, { code, cause: error }),
          );
          return;
        }

        let stdout = "";
        let stderr = "";
        let settled = false;

        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (result: RunResult) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          request.abortSignal?.removeEventListener("abort", onAbort);
          resolve(result);
        };

        const onAbort = () => {
          child.kill();
          const killer = setTimeout(() => {
            child.kill("SIGKILL");
          }, 2000);
          killer.unref?.();
        };

        if (request.timeoutMs && request.timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            onAbort();
          }, request.timeoutMs);
          timer.unref?.();
        }

        if (request.abortSignal) {
          if (request.abortSignal.aborted) {
            onAbort();
          } else {
            request.abortSignal.addEventListener("abort", onAbort, { once: true });
          }
        }

        child.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stdout += text;
          request.onStdout?.(text);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stderr = bound(stderr + text, stderrLimit);
          request.onStderr?.(text);
        });
        child.on("error", (error: NodeJS.ErrnoException) => {
          request.abortSignal?.removeEventListener("abort", onAbort);
          reject(
            new ProcessRunError(`Failed to spawn ${request.executable}: ${error.message}`, {
              code: error.code,
              cause: error,
            }),
          );
        });
        child.on("close", (code, signal) => {
          finish({
            exitCode: code ?? 1,
            signal,
            stdout,
            stderr,
            timedOut,
          });
        });
      });
    },
  };
}
