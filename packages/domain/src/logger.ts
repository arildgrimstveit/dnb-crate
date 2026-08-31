export type Logger = {
  debug: (obj: Record<string, unknown> | string, msg?: string) => void;
  info: (obj: Record<string, unknown> | string, msg?: string) => void;
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  error: (obj: Record<string, unknown> | string, msg?: string) => void;
};

function noop(_obj: Record<string, unknown> | string, _msg?: string): void {}

export const silentLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};
