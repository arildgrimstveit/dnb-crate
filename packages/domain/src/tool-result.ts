export type ToolErrorBody = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type ToolResult<T> =
  | {
      ok: true;
      data: T;
      warnings: string[];
    }
  | {
      ok: false;
      error: ToolErrorBody;
    };

export function ok<T>(data: T, warnings: string[] = []): ToolResult<T> {
  return { ok: true, data, warnings };
}

export function fail(error: ToolErrorBody): ToolResult<never> {
  return { ok: false, error };
}
