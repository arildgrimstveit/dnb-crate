import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { buildDnbFixtureWav, createCatalogRuntime } from "@dnb-crate/catalog";
import { mixWorkflowDataSchema } from "@dnb-crate/domain";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createDnbCrateMcpServer } from "../src/create-server.ts";
const execute = promisify(execFile);
it("MCP completes scan through verified master/listen from untagged MP3s", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dnb-mcp-first-"));
  const library = path.join(root, "library");
  await mkdir(library);
  const config = {
    databasePath: path.join(root, "catalog.sqlite"),
    libraryRoots: [library],
    outputRoot: path.join(root, "output"),
    logLevel: "error" as const,
    supportedExtensions: [".mp3"],
    keyfinderPath: process.env.DNB_CRATE_KEYFINDER_PATH,
    rubberbandPath: process.env.DNB_CRATE_RUBBERBAND_PATH,
  };
  const runtime = createCatalogRuntime(config);
  const handler = createMcpHandler(() => createDnbCrateMcpServer({ service: runtime.service }));
  const client = new Client(
    { name: "first-mix-native", version: "1" },
    { versionNegotiation: { mode: "auto" } },
  );
  try {
    for (let i = 0; i < 3; i++) {
      const source = path.join(root, `source-${i}.wav`);
      await writeFile(source, buildDnbFixtureWav(i));
      await execute(
        "ffmpeg",
        [
          "-nostdin",
          "-v",
          "error",
          "-i",
          source,
          "-map_metadata",
          "-1",
          "-c:a",
          "libmp3lame",
          "-b:a",
          "192k",
          path.join(library, `track-${i}.mp3`),
        ],
        { windowsHide: true },
      );
    }
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
      }),
    );
    const preflight = await client.callTool({ name: "get_mix_preflight", arguments: {} });
    expect(preflight.structuredContent).toMatchObject({ ok: true, data: { ready: true } });
    expect(JSON.stringify(preflight.structuredContent)).not.toContain(root);
    const started = await client.callTool({
      name: "start_mix_workflow",
      arguments: {
        requestToken: "native-mcp",
        brief: { name: "MCP first mix", targetDurationMinutes: 5, seed: 1 },
      },
    });
    const startEnvelope = started.structuredContent as { ok: boolean; data: unknown };
    expect(startEnvelope.ok).toBe(true);
    let row = mixWorkflowDataSchema.parse(startEnvelope.data);
    const deadline = Date.now() + 180000;
    while ((row.status === "queued" || row.status === "running") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const response = await client.callTool({
        name: "get_mix_workflow",
        arguments: { id: row.id },
      });
      row = mixWorkflowDataSchema.parse((response.structuredContent as { data: unknown }).data);
    }
    expect(row.status, JSON.stringify(row.issues)).toBe("succeeded");
    expect(row.result?.verified).toBe(true);
    expect(row.result?.trackCount).toBeGreaterThanOrEqual(2);
    expect(row.completedStages).toHaveLength(7);
    expect(row.analysisJobIds.length).toBeGreaterThan(0);
    expect(row.planId).toBeTruthy();
    expect(row.renderJobId).toBeTruthy();
    expect(runtime.workflows.get(row.id)).toEqual(row);
    for (const relative of [row.result!.master!, row.result!.listen!])
      await execute(
        "ffmpeg",
        [
          "-nostdin",
          "-v",
          "error",
          "-xerror",
          "-i",
          path.join(config.outputRoot, relative),
          "-f",
          "null",
          "-",
        ],
        { windowsHide: true },
      );
  } finally {
    await client.close();
    await handler.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240000);
