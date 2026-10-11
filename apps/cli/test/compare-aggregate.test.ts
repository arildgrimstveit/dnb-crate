import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createCatalogRuntime, writeSineWav } from "@dnb-crate/catalog";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliMain = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const tsxCli = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
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

describe("transition:compare CLI aggregate success (S4)", () => {
  it("exit 1 with ok:false when every variant fails enqueue", async () => {
    const root = path.join(os.tmpdir(), `dnb-cli-compare-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    await writeSineWav(path.join(library, "a.wav"), { title: "Alpha", durationMs: 8000 });
    await writeSineWav(path.join(library, "b.wav"), { title: "Bravo", durationMs: 8000 });
    const config = {
      databasePath: path.join(root, "catalog.sqlite"),
      libraryRoots: [library],
      outputRoot: path.join(root, "output"),
      logLevel: "error" as const,
      supportedExtensions: [".wav"],
    };
    const configFile = path.join(root, "config.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(configFile, JSON.stringify(config));
    const env = { DNB_CRATE_CONFIG: configFile, DNB_CRATE_LOG_LEVEL: "error" };
    try {
      // Seed the catalog and a two-entry plan directly; the S4 aggregate is
      // about enqueue failures, so no render needs to succeed first.
      const seed = createCatalogRuntime(config, undefined, { useFakeFfmpeg: true });
      let planId = "";
      let transitionId = "";
      let sources: string[] = [];
      try {
        await seed.service.scanLibrary();
        const tracks = seed.service.searchTracks({ limit: 10 }).tracks;
        const alpha = seed.repository.findById(tracks.find((t) => t.title === "Alpha")!.id)!;
        const bravo = seed.repository.findById(tracks.find((t) => t.title === "Bravo")!.id)!;
        const transition = {
          id: crypto.randomUUID(),
          type: "crossfade" as const,
          durationMs: 1000,
          outgoingCuePointId: null,
          incomingCuePointId: null,
          parameters: { purpose: "fixture" },
        };
        const plan = {
          schemaVersion: 1 as const,
          id: crypto.randomUUID(),
          name: "S4 compare fixture",
          targetDurationMs: 15_000,
          targetBpm: 174,
          requestedArc: [
            { atFraction: 0, targetEnergy: 3 },
            { atFraction: 1, targetEnergy: 6 },
          ],
          entries: [
            {
              id: crypto.randomUUID(),
              trackId: alpha.id,
              order: 0,
              sourceStartMs: 0,
              sourceEndMs: alpha.durationMs,
              timelineStartMs: 0,
              playbackRate: 1,
              gainDb: 0,
              transitionToNext: transition,
            },
            {
              id: crypto.randomUUID(),
              trackId: bravo.id,
              order: 1,
              sourceStartMs: 0,
              sourceEndMs: bravo.durationMs,
              timelineStartMs: alpha.durationMs - 1000,
              playbackRate: 1,
              gainDb: 0,
              transitionToNext: null,
            },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        seed.setPlans.save(plan, 1, {
          seed: 1,
          selected: [],
          rejected: [],
          harmonicCoverage: { knownJoins: 0, totalJoins: 0 },
        });
        planId = plan.id;
        transitionId = transition.id;
        sources = [alpha.filePath, bravo.filePath];
      } finally {
        await seed.close();
      }

      // Delete the source files: the STRICT shared freeze (S8) rejects the
      // comparison with the domain error — no weakened request is enqueued —
      // and the aggregate run exits nonzero with ok:false (previously
      // ok:true exit 0 because enqueue failures vanished from the calc).
      for (const source of sources) {
        await rm(source, { force: true });
      }

      const compare = await runCli(
        ["transition:compare", "--plan", planId, "--transition", transitionId, "--wait"],
        env,
      );
      const body = JSON.parse(compare.stdout) as {
        ok: boolean;
        error?: { code?: string };
        data?: {
          variants?: Array<{ status: string; jobId: string | null; errorCode: string | null }>;
        };
      };
      expect(compare.code).toBe(1);
      expect(body.ok).toBe(false);
      if (body.error) {
        // Strict-freeze rejection (unreadable source): honest domain error.
        expect(body.error.code).toBe("AUDIO_FILE_UNAVAILABLE");
      } else {
        const attempted = (body.data?.variants ?? []).filter((v) => v.status === "failed");
        expect(attempted.length).toBeGreaterThan(0);
        expect(attempted.every((v) => v.errorCode !== null)).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
