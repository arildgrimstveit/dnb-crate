import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { writeSineWav } from "@dnb-crate/catalog";

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
});
