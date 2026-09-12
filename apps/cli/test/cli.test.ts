import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createCatalogRuntime, writeSineWav } from "@dnb-crate/catalog";

import { cliWorkerNeed, NO_WORKER_MESSAGE } from "../src/worker-policy.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliMain = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const tsxCli = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, cliMain, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

describe("CLI", () => {
  it("reporting from a separate process does not recover running jobs or claim queued work", async () => {
    const root = path.join(os.tmpdir(), `dnb-cli-owner-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const config = {
      databasePath: path.join(root, "catalog.sqlite"),
      libraryRoots: [library],
      outputRoot: path.join(root, "output"),
      logLevel: "error" as const,
      supportedExtensions: [".wav"],
    };
    // A passive fixture isolates the CLI behavior: there is no worker to compete with it.
    const runtime = createCatalogRuntime(config, undefined, { passive: true });
    try {
      const running = runtime.analysisJobs.insertQueued([]);
      runtime.analysisJobs.claimNextQueued();
      const queued = runtime.analysisJobs.insertQueued([]);
      const result = await runCli(["library:stats"], {
        DNB_CRATE_DATABASE_PATH: config.databasePath,
        DNB_CRATE_LIBRARY_ROOTS: JSON.stringify(config.libraryRoots),
        DNB_CRATE_OUTPUT_ROOT: config.outputRoot,
        DNB_CRATE_LOG_LEVEL: "error",
      });
      expect(result.code).toBe(0);
      expect(runtime.analysisJobs.require(running.id).status).toBe("running");
      expect(runtime.analysisJobs.require(queued.id).status).toBe("queued");
    } finally {
      await runtime.close();
    }
  });

  it("migrates, scans, and searches a fixture library", async () => {
    const root = path.join(
      os.tmpdir(),
      `dnb-cli-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    await writeSineWav(path.join(library, "search-me.wav"), {
      title: "Search Me",
      artist: "CLI Artist",
      durationMs: 280,
    });
    const env = {
      DNB_CRATE_DATABASE_PATH: path.join(root, "catalog.sqlite"),
      DNB_CRATE_LIBRARY_ROOTS: JSON.stringify([library]),
      DNB_CRATE_OUTPUT_ROOT: path.join(root, "output"),
      DNB_CRATE_LOG_LEVEL: "error",
    };

    const migrated = await runCli(["db:migrate"], env);
    expect(migrated.code).toBe(0);

    const scanned = await runCli(["library:scan"], env);
    expect(scanned.code).toBe(0);
    expect(JSON.parse(scanned.stdout)).toMatchObject({ ok: true, data: { upserted: 1 } });

    const stats = await runCli(["library:stats"], env);
    expect(JSON.parse(stats.stdout)).toMatchObject({ ok: true, data: { trackCount: 1 } });

    const search = await runCli(["track:search", "--query", "Search"], env);
    expect(JSON.parse(search.stdout)).toMatchObject({
      ok: true,
      data: { tracks: [{ title: "Search Me" }] },
    });
  });

  it("declares worker needs beside each job-producing command", () => {
    expect(cliWorkerNeed("analysis:gate", [])).toBe("process");
    expect(cliWorkerNeed("enrich:run", ["--wait"])).toBe("process");
    expect(cliWorkerNeed("enrich:run", [])).toBe("enqueue");
    expect(cliWorkerNeed("analysis:run", ["--wait"])).toBe("process");
    expect(cliWorkerNeed("analysis:run", [])).toBe("enqueue");
    expect(cliWorkerNeed("analysis:start", [])).toBe("enqueue");
    expect(cliWorkerNeed("render:start", ["--wait"])).toBe("process");
    expect(cliWorkerNeed("render:preview", [])).toBe("enqueue");
    expect(cliWorkerNeed("library:stats", [])).toBe("none");
  });

  it("enrich:run --wait processes jobs without another worker", async () => {
    const root = path.join(os.tmpdir(), `dnb-cli-enrich-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    await writeSineWav(path.join(library, "a.wav"), { title: "A", durationMs: 400 });
    await writeSineWav(path.join(library, "b.wav"), { title: "B", durationMs: 400 });
    const configPath = path.join(root, "dnb-crate.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        databasePath: path.join(root, "catalog.sqlite"),
        libraryRoots: [library],
        outputRoot: path.join(root, "output"),
        logLevel: "error",
        supportedExtensions: [".wav"],
        enrichment: {
          enabled: true,
          musicbrainz: { enabled: false },
          deezer: { enabled: false },
        },
      }),
    );
    const env = {
      DNB_CRATE_CONFIG: configPath,
      DNB_CRATE_LOG_LEVEL: "error",
    };
    expect((await runCli(["db:migrate"], env)).code).toBe(0);
    expect((await runCli(["library:scan"], env)).code).toBe(0);
    const result = await runCli(
      ["enrich:run", "--scope", "all", "--wait", "--timeout-min", "0.25"],
      env,
    );
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as { ok: boolean; data: { job: { status: string } } };
    expect(body.ok).toBe(true);
    expect(body.data.job.status).toBe("succeeded");
  });

  it("analysis:run without --wait does not claim work when no worker is running", async () => {
    const root = path.join(os.tmpdir(), `dnb-cli-nowait-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    await writeSineWav(path.join(library, "solo.wav"), { title: "Solo", durationMs: 400 });
    const config = {
      databasePath: path.join(root, "catalog.sqlite"),
      libraryRoots: [library],
      outputRoot: path.join(root, "output"),
      logLevel: "error" as const,
      supportedExtensions: [".wav"],
    };
    const runtime = createCatalogRuntime(config, undefined, { passive: true });
    try {
      await runtime.service.scanLibrary();
      const result = await runCli(["analysis:run", "--scope", "all"], {
        DNB_CRATE_DATABASE_PATH: config.databasePath,
        DNB_CRATE_LIBRARY_ROOTS: JSON.stringify(config.libraryRoots),
        DNB_CRATE_OUTPUT_ROOT: config.outputRoot,
        DNB_CRATE_LOG_LEVEL: "error",
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(NO_WORKER_MESSAGE);
      expect(runtime.analysisJobs.list()).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it("analysis:run without --wait leaves queued work for a live worker", async () => {
    const root = path.join(os.tmpdir(), `dnb-cli-handoff-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    await writeSineWav(path.join(library, "owned.wav"), { title: "Owned", durationMs: 400 });
    const config = {
      databasePath: path.join(root, "catalog.sqlite"),
      libraryRoots: [library],
      outputRoot: path.join(root, "output"),
      logLevel: "error" as const,
      supportedExtensions: [".wav"],
    };
    const runtime = createCatalogRuntime(config, undefined, { useFakeFfmpeg: true });
    try {
      await runtime.service.scanLibrary();
      const result = await runCli(["analysis:run", "--scope", "all"], {
        DNB_CRATE_DATABASE_PATH: config.databasePath,
        DNB_CRATE_LIBRARY_ROOTS: JSON.stringify(config.libraryRoots),
        DNB_CRATE_OUTPUT_ROOT: config.outputRoot,
        DNB_CRATE_LOG_LEVEL: "error",
      });
      expect(result.code).toBe(0);
      const job = (JSON.parse(result.stdout) as { data: { id: string } }).data;
      const done = await runtime.service.waitForAnalysisJob(job.id, 8_000);
      expect(done.status).toBe("succeeded");
      expect(done.errorMessage).toBeNull();
    } finally {
      await runtime.close();
    }
  });
});
