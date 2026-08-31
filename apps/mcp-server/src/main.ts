import { createCatalogRuntime } from "@dnb-crate/catalog";
import { loadConfig } from "@dnb-crate/domain";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createDnbCrateMcpServer } from "./create-server.ts";
import { createStderrLogger } from "./logger.ts";

const config = loadConfig();
const logger = createStderrLogger(config.logLevel);
const runtime = createCatalogRuntime(config, logger);

await runtime.service.ensureOutputRoot();

const handle = serveStdio(() => createDnbCrateMcpServer({ service: runtime.service }));

const shutdown = async () => {
  await handle.close();
  runtime.close();
};

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
