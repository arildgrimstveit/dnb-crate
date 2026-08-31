export type RunRequest = {
  executable: string;
  args: string[];
  abortSignal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type RunResult = {
  exitCode: number;
  signal: string | null;
  stdout: string;
  stderr: string;
};

export type ProcessRunner = {
  run: (request: RunRequest) => Promise<RunResult>;
};

export class ProcessRunError extends Error {
  readonly code: string | undefined;
  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProcessRunError";
    this.code = options?.code;
  }
}
