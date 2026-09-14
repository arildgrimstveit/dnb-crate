import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildDnbFixtureWav, createCatalogRuntime } from "@dnb-crate/catalog";
import { mixWorkflowDataSchema } from "@dnb-crate/domain";
const repo = fileURLToPath(new URL("../../..", import.meta.url));
function run(
  executable: string,
  args: string[],
  env = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: repo, env, windowsHide: true });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
it("CLI creates a verified strict first mix from untagged DnB MP3 fixtures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dnb-cli-first-"));
  try {
    const library = path.join(root, "library");
    await mkdir(library);
    for (let i = 0; i < 3; i++) {
      const wav = path.join(root, `source-${i}.wav`);
      await writeFile(wav, buildDnbFixtureWav(i));
      const encoded = await run("ffmpeg", [
        "-nostdin",
        "-v",
        "error",
        "-i",
        wav,
        "-map_metadata",
        "-1",
        "-c:a",
        "libmp3lame",
        "-q:a",
        "2",
        path.join(library, `track-${i}.mp3`),
      ]);
      expect(encoded.code, encoded.stderr).toBe(0);
    }
    const config = {
      databasePath: path.join(root, "catalog.sqlite"),
      libraryRoots: [library],
      outputRoot: path.join(root, "output"),
      logLevel: "error" as const,
      supportedExtensions: [".mp3"],
      keyfinderPath: process.env.DNB_CRATE_KEYFINDER_PATH,
      rubberbandPath: process.env.DNB_CRATE_RUBBERBAND_PATH,
    };
    const configFile = path.join(root, "config.json");
    await writeFile(configFile, JSON.stringify(config));
    const result = await run(
      process.execPath,
      [
        path.join(repo, "node_modules/tsx/dist/cli.mjs"),
        path.join(repo, "apps/cli/src/main.ts"),
        "mix:create",
        "--name",
        "Fixture first mix",
        "--duration-min",
        "5",
        "--seed",
        "1",
        "--request-token",
        "native-cli",
        "--wait",
      ],
      { ...process.env, DNB_CRATE_CONFIG: configFile },
    );
    expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
    const envelope = JSON.parse(result.stdout) as { data: unknown };
    const row = mixWorkflowDataSchema.parse(envelope.data);
    expect(row.status).toBe("succeeded");
    expect(row.result?.verified).toBe(true);
    expect(row.result?.trackCount).toBeGreaterThanOrEqual(2);
    expect(row.completedStages).toEqual([
      "preflight",
      "scan",
      "analysis",
      "plan",
      "validate",
      "render",
      "check",
    ]);
    expect(row.analysisJobIds.length).toBeGreaterThan(0);
    expect(row.planId).toBeTruthy();
    expect(row.renderJobId).toBeTruthy();
    const runtime = createCatalogRuntime(config, undefined, { passive: true });
    try {
      expect(runtime.workflows.get(row.id)).toEqual(row);
      expect(runtime.service.reportSetPlanQuality(row.planId!).readyForAudition).toBe(true);
      for (const relative of [row.result!.master!, row.result!.listen!]) {
        const decoded = await run("ffmpeg", [
          "-nostdin",
          "-v",
          "error",
          "-xerror",
          "-i",
          path.join(config.outputRoot, relative),
          "-f",
          "null",
          "-",
        ]);
        expect(decoded.code, decoded.stderr).toBe(0);
      }
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 240000);
