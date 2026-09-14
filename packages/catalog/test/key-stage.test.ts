import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeFfmpegRunner,
  type ProcessRunner,
  type RunRequest,
} from "@dnb-crate/audio-renderer";
import { loadConfig, type AppConfig } from "@dnb-crate/domain";
import { createCatalogRuntime, writeSineWav } from "../src/index.ts";
import { probeKeyEngine, runKeyEngine } from "../src/analysis/key-engine.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dnb-key-stage-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const library = path.join(root, "library");
  await mkdir(library);
  const command = path.join(root, "key finder.exe");
  await writeFile(command, "test executable identity");
  const config: AppConfig = {
    databasePath: path.join(root, "catalog.sqlite"),
    libraryRoots: [library],
    outputRoot: path.join(root, "output"),
    logLevel: "error",
    supportedExtensions: [".wav"],
    keyfinderPath: command,
  };
  const calls: RunRequest[] = [];
  let key = "Am";
  const fake = createFakeFfmpegRunner();
  const runner: ProcessRunner = {
    async run(request) {
      calls.push(request);
      if (request.executable === command)
        return {
          exitCode: request.args.length ? 0 : 2,
          signal: null,
          stdout: request.args.length ? key : "",
          stderr: request.args.length ? "" : "usage: keyfinder-cli <file.wav>",
        };
      return fake.run(request);
    },
  };
  const runtime = createCatalogRuntime(config, undefined, { processRunner: runner });
  cleanup.push(() => runtime.close());
  await writeSineWav(path.join(library, "source.wav"), { durationMs: 1000 });
  await runtime.service.scanLibrary();
  const track = runtime.repository.listAll()[0]!;
  const analyze = async () =>
    runtime.service.waitForAnalysisJob(
      runtime.service.startTrackAnalysis({ trackIds: [track.id] }).job.id,
    );
  return {
    root,
    config,
    runner,
    runtime,
    calls,
    track,
    analyze,
    setKey(value: string) {
      key = value;
    },
  };
}

describe("ordinary key stage", () => {
  it("uses configured paths including spaces and an environment overlay", async () => {
    const f = await fixture();
    const config = loadConfig({
      cwd: f.root,
      env: {
        DNB_CRATE_DATABASE_PATH: "db.sqlite",
        DNB_CRATE_LIBRARY_ROOTS: JSON.stringify([f.config.libraryRoots[0]]),
        DNB_CRATE_OUTPUT_ROOT: "output",
        DNB_CRATE_KEYFINDER_PATH: "key finder.exe",
      },
    });
    expect(config.keyfinderPath).toBe(f.config.keyfinderPath);
    expect((await probeKeyEngine(config, f.runner)).available).toBe(true);
    await expect(
      probeKeyEngine({ ...config, keyfinderPath: path.join(f.root, "missing.exe") }, f.runner),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
  it("backfills keys without redoing successful DSP and invalidates only keys for a new executable", async () => {
    const f = await fixture();
    await f.analyze();
    const dsp = f.runtime.analyses.findByTrackId(f.track.id, "dnb-crate-dsp")!;
    expect(f.runtime.repository.findById(f.track.id)?.musicalKey).toBe("Am");
    expect(f.runtime.analyses.getStage(f.track.id, "key")?.state).toBe("succeeded");
    const count = f.calls.filter((c) => c.args.includes("44100")).length;
    await f.analyze();
    expect(f.calls.filter((c) => c.args.includes("44100"))).toHaveLength(count);
    expect(f.runtime.analyses.findByTrackId(f.track.id, "dnb-crate-dsp")).toEqual(dsp);
    await writeFile(f.config.keyfinderPath!, "changed executable");
    await f.analyze();
    expect(f.calls.filter((c) => c.args.includes("44100"))).toHaveLength(count + 1);
    expect(f.runtime.analyses.findByTrackId(f.track.id, "dnb-crate-dsp")).toEqual(dsp);
    const decode = f.calls.find((c) => c.args.includes("44100"))!;
    expect(decode.args.slice(decode.args.indexOf("-ac"), decode.args.indexOf("-ac") + 4)).toEqual([
      "-ac",
      "2",
      "-ar",
      "44100",
    ]);
    await expect(readFile(decode.args.at(-1)!)).rejects.toThrow();
  });
  it("reports key failures and retries them without losing DSP or inventing a key", async () => {
    const f = await fixture();
    f.setKey("unknown");
    const failed = await f.analyze();
    expect(failed.status).toBe("succeeded");
    expect(failed.keyStages?.[0]?.state).toBe("failed");
    expect(f.runtime.repository.findById(f.track.id)?.musicalKey).toBeNull();
    const dsp = f.runtime.analyses.findByTrackId(f.track.id, "dnb-crate-dsp");
    f.setKey("Am");
    await f.analyze();
    expect(f.runtime.analyses.findByTrackId(f.track.id, "dnb-crate-dsp")).toEqual(dsp);
    expect(f.runtime.analyses.getStage(f.track.id, "key")?.state).toBe("succeeded");
  });
  it.each(["manual", "published"] as const)(
    "preserves %s keys, cues and anchors",
    async (source) => {
      const f = await fixture();
      f.runtime.service.updateTrackMetadata(f.track.id, { musicalKey: "Cm", keySource: source });
      f.runtime.analyses.upsertBeatAnchor(f.track.id, 100);
      const before = f.runtime.repository.listCuePoints(f.track.id);
      await f.analyze();
      expect(f.runtime.repository.findById(f.track.id)).toMatchObject({
        musicalKey: "Cm",
        keySource: source,
      });
      expect(f.runtime.analyses.getBeatAnchorMs(f.track.id)).toBe(100);
      expect(f.runtime.repository.listCuePoints(f.track.id)).toEqual(
        expect.arrayContaining(before),
      );
      expect(f.runtime.analyses.getStage(f.track.id, "key")?.state).toBe("skipped");
      expect(f.calls.some((c) => c.args.includes("44100"))).toBe(false);
    },
  );
  it("disabling automatic measurement preserves already current successful key evidence", async () => {
    const f = await fixture();
    await f.analyze();
    const stage = f.runtime.analyses.getStage(f.track.id, "key");
    const decodes = f.calls.filter((call) => call.args.includes("44100")).length;
    f.config.analysis = { defaultEngine: "dnb-crate-dsp", keyAnalysis: "off" };
    await f.analyze();
    expect(f.runtime.analyses.getStage(f.track.id, "key")).toEqual(stage);
    expect(f.runtime.analyses.findKeyAnalysis(f.track.id)?.musicalKey).toBe("Am");
    expect(f.calls.filter((call) => call.args.includes("44100"))).toHaveLength(decodes);
  });

  it("preserves analyzed keys when KeyFinder becomes unavailable", async () => {
    const f = await fixture();
    await f.analyze();
    const stage = f.runtime.analyses.getStage(f.track.id, "key");
    const decodes = f.calls.filter((call) => call.args.includes("44100")).length;
    f.config.keyfinderPath = path.join(f.root, "gone.exe");
    await f.analyze();
    expect(f.runtime.repository.findById(f.track.id)).toMatchObject({
      musicalKey: "Am",
      keySource: "analyzed",
    });
    expect(f.runtime.analyses.getStage(f.track.id, "key")).toEqual(stage);
    expect(f.calls.filter((call) => call.args.includes("44100"))).toHaveLength(decodes);
  });

  it("does not promote tag keys using invented confidence when key detection fails", async () => {
    const f = await fixture();
    f.runtime.repository.upsertFromScan({
      ...f.track,
      musicalKey: "Cm",
      keySource: "tag",
      camelotKey: "5A",
    });
    f.setKey("unknown");
    await f.analyze();
    expect(f.runtime.repository.findById(f.track.id)).toMatchObject({
      musicalKey: "Cm",
      keySource: "tag",
    });
  });

  it("preserves explicit key/rhythm/structure selection and withdraws stale automatic keys", async () => {
    const f = await fixture();
    await f.analyze();
    f.runtime.analyses.setSelection(f.track.id, {
      rhythmEngine: "dnb-crate-dsp",
      structureEngine: "dnb-crate-dsp",
      keyEngine: "dnb-crate-dsp",
      reason: "User choice",
    });
    const selection = f.runtime.analyses.getSelection(f.track.id);
    await writeFile(f.config.keyfinderPath!, "new version");
    await f.analyze();
    expect(f.runtime.analyses.getSelection(f.track.id)).toEqual(selection);
    f.runtime.analyses.setSelection(f.track.id, {
      keyEngine: "keyfinder",
      reason: "Automatic KeyFinder selection",
    });
    await writeSineWav(path.join(f.config.libraryRoots[0]!, "source.wav"), { durationMs: 1600 });
    await f.runtime.service.scanLibrary();
    expect(f.runtime.repository.findById(f.track.id)?.musicalKey).toBeNull();
    expect(f.runtime.analyses.findKeyAnalysis(f.track.id)?.musicalKey).toBeNull();
  });
  it.each(["timeout", "cancel", "decode"])("cleans temporary WAVs on %s", async (mode) => {
    const f = await fixture();
    const probe = await probeKeyEngine(f.config, f.runner);
    const abort = new AbortController();
    let temporary = "";
    const runner: ProcessRunner = {
      async run(request) {
        if (request.args.includes("44100")) {
          temporary = request.args.at(-1)!;
          await writeFile(temporary, "partial");
          if (mode === "decode")
            return { exitCode: 1, signal: null, stdout: "", stderr: "corrupt" };
          return { exitCode: 0, signal: null, stdout: "", stderr: "" };
        }
        if (mode === "cancel") abort.abort();
        return {
          exitCode: 0,
          signal: null,
          stdout: "Am",
          stderr: "",
          timedOut: mode === "timeout",
        };
      },
    };
    await expect(
      runKeyEngine(runner, f.config, f.track.filePath, probe, abort.signal),
    ).rejects.toThrow();
    await expect(readFile(temporary)).rejects.toThrow();
  });
});
