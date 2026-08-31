import { APP_NAME, type Logger } from "@dnb-crate/domain";
import pino from "pino";

/** MCP stdio reserves stdout for protocol messages. Logs must go to stderr. */
export function createStderrLogger(level: string): Logger {
  const dest = pino.destination({ dest: 2, sync: true });
  const logger = pino({ level, base: { app: APP_NAME } }, dest);
  return {
    debug: (obj, msg) => (typeof obj === "string" ? logger.debug(obj) : logger.debug(obj, msg)),
    info: (obj, msg) => (typeof obj === "string" ? logger.info(obj) : logger.info(obj, msg)),
    warn: (obj, msg) => (typeof obj === "string" ? logger.warn(obj) : logger.warn(obj, msg)),
    error: (obj, msg) => (typeof obj === "string" ? logger.error(obj) : logger.error(obj, msg)),
  };
}
