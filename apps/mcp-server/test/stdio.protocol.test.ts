import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

import { writeSineWav } from "@dnb-crate/catalog";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const serverMain = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const tsxCli = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));

describe("stdio protocol", () => {
  it("initializes over stdio, lists tools, and completes a scan", async () => {
    const root = path.join(
      os.tmpdir(),
      `dnb-stdio-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    await mkdir(path.join(root, "output"), { recursive: true });
    await writeSineWav(path.join(library, "pulse.wav"), {
      title: "Pulse",
      artist: "Fixture",
      durationMs: 300,
    });

    const client = new Client({ name: "stdio-harness", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, serverMain],
      cwd: repoRoot,
      env: {
        ...process.env,
        DNB_CRATE_DATABASE_PATH: path.join(root, "catalog.sqlite"),
        DNB_CRATE_LIBRARY_ROOTS: JSON.stringify([library]),
        DNB_CRATE_OUTPUT_ROOT: path.join(root, "output"),
        DNB_CRATE_LOG_LEVEL: "error",
      },
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("scan_library");
      const result = await client.callTool({ name: "scan_library", arguments: { dryRun: false } });
      expect(result.structuredContent).toMatchObject({ ok: true, data: { upserted: 1 } });
    } finally {
      await client.close();
    }
  });
});
