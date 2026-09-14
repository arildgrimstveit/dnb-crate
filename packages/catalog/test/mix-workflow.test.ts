import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@dnb-crate/domain";
import { createCatalogRuntime, writeSineWav } from "../src/index.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(passive = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dnb-workflow-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const library = path.join(root, "library");
  await mkdir(library);
  const config: AppConfig = {
    databasePath: path.join(root, "catalog.sqlite"),
    libraryRoots: [library],
    outputRoot: path.join(root, "output"),
    logLevel: "error",
    supportedExtensions: [".wav"],
    analysis: { defaultEngine: "dnb-crate-dsp", keyAnalysis: "off" },
  };
  const runtime = createCatalogRuntime(config, undefined, { useFakeFfmpeg: true, passive });
  cleanup.push(() => runtime.close());
  return { root, library, config, runtime };
}
const brief = { name: "First mix", targetDurationMinutes: 3, seed: 9 };
describe("durable mix workflows", () => {
  it("starts idempotently, rejects token conflicts and leaves passive readers passive", async () => {
    const { runtime } = await fixture();
    const first = runtime.workflows.start({ brief, requestToken: "request-1" });
    expect(runtime.workflows.start({ brief, requestToken: "request-1" })).toEqual(first);
    expect(() =>
      runtime.workflows.start({
        brief: { ...brief, name: "Different" },
        requestToken: "request-1",
      }),
    ).toThrow(/different brief/);
    runtime.workflows.kick();
    expect(runtime.workflows.get(first.id).status).toBe("queued");
    expect(() =>
      runtime.workflows.start({ brief: { ...brief, qualityPolicy: "off" }, requestToken: "off" }),
    ).toThrow(/strict/);
  });
  it("blocks unreadable roots with a private actionable report and resumes after repair", async () => {
    const { runtime, library } = await fixture(false);
    await rm(library, { recursive: true });
    const first = runtime.workflows.start({ brief, requestToken: "root" });
    await expect.poll(() => runtime.workflows.get(first.id).status).toBe("blocked");
    const blocked = runtime.workflows.get(first.id);
    expect(blocked.issues.some((i) => i.code === "NO_READABLE_ROOT" && i.nextAction)).toBe(true);
    expect(JSON.stringify(blocked)).not.toContain(library);
    await mkdir(library);
    await runtime.workflows.resume(first.id);
    await expect.poll(() => runtime.workflows.get(first.id).stage).not.toBe("preflight");
  });
  it("does not enqueue analysis when current DSP results already cover the candidates", async () => {
    const { runtime, library } = await fixture(false);
    await writeSineWav(path.join(library, "source.wav"), { durationMs: 1000 });
    await runtime.service.scanLibrary();
    const track = runtime.repository.listAll()[0]!;
    await runtime.service.waitForAnalysisJob(
      runtime.service.startTrackAnalysis({ trackIds: [track.id] }).job.id,
    );
    const first = runtime.workflows.start({ brief, requestToken: "reuse-analysis" });
    const result = await runtime.workflows.wait(first.id);
    expect(result.analysisJobIds).toEqual([]);
    expect(result.completedStages).toContain("analysis");
  });
  it("an unsuitable empty library retains a partial plan and never schedules render", async () => {
    const { runtime } = await fixture(false);
    const first = runtime.workflows.start({ brief, requestToken: "empty" });
    const result = await runtime.workflows.wait(first.id);
    expect(result.status).toBe("blocked");
    expect(result.renderJobId).toBeNull();
    expect(result.completedStages).toContain("analysis");
    expect(result.planId).not.toBeNull();
    expect(runtime.service.getSetPlan(result.planId!).qualityPolicy).toBe("strict");
  });
  it("atomically associates bounded analysis children and reuses the child after reopen", async () => {
    const { runtime, library, config } = await fixture();
    for (let i = 0; i < 2005; i++) {
      runtime.repository.upsertFromScan({
        filePath: path.join(library, `${i}.wav`),
        fileFingerprint: `fingerprint-${i}`,
        title: `Track ${i}`,
        artist: null,
        album: null,
        durationMs: 1000,
        sampleRateHz: 44100,
        channels: 1,
        bpm: null,
        bpmSource: null,
        musicalKey: null,
        camelotKey: null,
        keySource: null,
      });
    }
    const row = runtime.workflows.start({ brief, requestToken: "chunk" });
    row.stage = "analysis";
    row.candidates = Object.fromEntries(
      runtime.repository.listAll().map((t) => [t.id, t.fileFingerprint]),
    );
    runtime.workflows.repository.save(row);
    runtime.workflows.canRun = () => true;
    runtime.workflows.kick();
    await expect.poll(() => runtime.workflows.get(row.id).analysisJobIds.length).toBe(1);
    const child = runtime.workflows.get(row.id).analysisJobIds[0]!;
    expect(runtime.analysisJobs.require(child).trackIds).toHaveLength(100);
    await runtime.close();
    const reopened = createCatalogRuntime(config, undefined, {
      passive: true,
      useFakeFfmpeg: true,
    });
    cleanup.push(() => reopened.close());
    reopened.workflows.canRun = () => true;
    reopened.workflows.kick();
    expect(reopened.workflows.get(row.id).analysisJobIds).toEqual([child]);
    reopened.analysisJobs.claimNextQueued();
    reopened.analysisJobs.markSucceeded(child, reopened.analysisJobs.require(child).trackIds, []);
    await expect
      .poll(() => {
        reopened.workflows.kick();
        return reopened.workflows.get(row.id).analysisJobIds.length;
      })
      .toBe(2);
    expect(
      reopened.analysisJobs.require(reopened.workflows.get(row.id).analysisJobIds[1]!).trackIds,
    ).toHaveLength(100);
  });
  it("cancel affects exclusively owned jobs and survives reopening", async () => {
    const { runtime, config } = await fixture();
    const row = runtime.workflows.start({ brief, requestToken: "cancel" });
    const owned = runtime.analysisJobs.insertQueued([]);
    const unrelated = runtime.analysisJobs.insertQueued([]);
    row.analysisJobIds = [owned.id];
    runtime.workflows.repository.save(row);
    expect(runtime.workflows.cancel(row.id).status).toBe("cancelled");
    expect(runtime.analysisJobs.require(owned.id).status).toBe("cancelled");
    expect(runtime.analysisJobs.require(unrelated.id).status).toBe("queued");
    await runtime.close();
    const reader = createCatalogRuntime(config, undefined, { passive: true, useFakeFfmpeg: true });
    cleanup.push(() => reader.close());
    expect(reader.workflows.get(row.id).status).toBe("cancelled");
  });
  it("does not requeue analysis when KeyFinder becomes unavailable", async () => {
    const { runtime } = await fixture();
    const row = runtime.workflows.start({ brief, requestToken: "key-gone" });
    row.stage = "plan";
    row.candidates = {};
    row.completedStages = ["preflight", "scan", "analysis"];
    row.dependencies.keyfinder = "abc";
    row.status = "blocked";
    runtime.workflows.repository.save(row);
    vi.spyOn(runtime.workflows.preflight, "check").mockResolvedValue({
      ready: true,
      issues: [],
      dependencies: { keyfinder: null, ffmpeg: "1", ffprobe: "1" },
    });
    await runtime.workflows.resume(row.id);
    expect(runtime.workflows.get(row.id).stage).toBe("plan");
  });

  it("rechecks analysis when a KeyFinder identity appears or changes", async () => {
    const { runtime } = await fixture();
    const row = runtime.workflows.start({ brief, requestToken: "key-new" });
    const child = runtime.analysisJobs.insertQueued([]);
    runtime.analysisJobs.claimNextQueued();
    runtime.analysisJobs.markSucceeded(child.id, [], []);
    row.stage = "plan";
    row.candidates = {};
    row.analysisJobIds = [child.id];
    row.completedStages = ["preflight", "scan", "analysis"];
    row.dependencies.keyfinder = null;
    row.status = "blocked";
    runtime.workflows.repository.save(row);
    vi.spyOn(runtime.workflows.preflight, "check").mockResolvedValue({
      ready: true,
      issues: [],
      dependencies: { keyfinder: "new-identity", ffmpeg: "1", ffprobe: "1" },
    });
    await runtime.workflows.resume(row.id);
    expect(runtime.workflows.get(row.id).stage).toBe("analysis");
    expect(runtime.analysisJobs.require(child.id).status).toBe("queued");
  });

  it("does not silently replan changed sources on resume", async () => {
    const { runtime, library } = await fixture();
    await writeSineWav(path.join(library, "source.wav"), { durationMs: 1000 });
    await runtime.service.scanLibrary();
    const row = runtime.workflows.start({ brief, requestToken: "source" });
    row.candidates = Object.fromEntries(
      runtime.repository.listAll().map((t) => [t.id, t.fileFingerprint]),
    );
    row.planId = crypto.randomUUID();
    row.status = "blocked";
    runtime.workflows.repository.save(row);
    await writeFile(path.join(library, "source.wav"), "changed");
    await expect(runtime.workflows.resume(row.id)).rejects.toThrow(/Sources changed/);
    expect(runtime.workflows.get(row.id).planId).toBe(row.planId);
  });
  it("rejects unwritable output and output/library overlap", async () => {
    const { runtime, config, root, library } = await fixture();
    config.outputRoot = library;
    expect(
      (await runtime.workflows.preflight.check()).issues.some(
        (i) => i.code === "OUTPUT_CONTAINMENT",
      ),
    ).toBe(true);
    const file = path.join(root, "file");
    await writeFile(file, "occupied");
    config.outputRoot = file;
    expect(
      (await runtime.workflows.preflight.check()).issues.some(
        (i) => i.code === "OUTPUT_UNWRITABLE",
      ),
    ).toBe(true);
  });
  it("rolls plan creation back if its checkpoint fails, then resumes without duplicate plans", async () => {
    const { runtime } = await fixture();
    const row = runtime.workflows.start({ brief, requestToken: "plan-crash" });
    row.stage = "plan";
    row.candidates = {};
    row.dependencies.keyfinder = null;
    row.completedStages = ["preflight", "scan", "analysis"];
    runtime.workflows.repository.save(row);
    const original = runtime.setPlans.save.bind(runtime.setPlans);
    const fault = vi.spyOn(runtime.setPlans, "save").mockImplementation((...args) => {
      original(...args);
      throw new Error("crash after plan insert");
    });
    runtime.workflows.canRun = () => true;
    runtime.workflows.kick();
    await expect.poll(() => runtime.workflows.get(row.id).status).toBe("blocked");
    expect(runtime.workflows.get(row.id).planId).toBeNull();
    expect(runtime.db.prepare("SELECT COUNT(*) AS n FROM set_plans").get()).toEqual({ n: 0 });
    fault.mockRestore();
    await runtime.workflows.resume(row.id);
    await expect
      .poll(() => {
        runtime.workflows.kick();
        return runtime.workflows.get(row.id).planId;
      })
      .not.toBeNull();
    expect(runtime.db.prepare("SELECT COUNT(*) AS n FROM set_plans").get()).toEqual({ n: 1 });
  });

  it("reuses a reserved render child after failure immediately following enqueue", async () => {
    const { runtime, config } = await fixture();
    const plan = runtime.service.createSetPlan(brief).plan;
    const row = runtime.workflows.start({ brief, requestToken: "render-crash" });
    row.stage = "render";
    row.candidates = {};
    row.planId = plan.id;
    row.renderJobId = crypto.randomUUID();
    row.renderJobIds = [row.renderJobId];
    runtime.workflows.repository.save(row);
    vi.spyOn(runtime.service, "startSetRender").mockImplementation((input) => {
      runtime.renderJobs.insertQueued({
        id: input.workflowJobId!,
        kind: "full",
        setPlanId: input.setPlanId,
      });
      return Promise.reject(new Error("crash after enqueue"));
    });
    runtime.workflows.canRun = () => true;
    runtime.workflows.kick();
    await expect.poll(() => runtime.workflows.get(row.id).status).toBe("failed");
    expect(runtime.workflows.get(row.id).renderJobId).toBe(row.renderJobId);
    await runtime.close();
    const reopened = createCatalogRuntime(config, undefined, {
      passive: true,
      useFakeFfmpeg: true,
    });
    cleanup.push(() => reopened.close());
    await reopened.workflows.resume(row.id);
    reopened.workflows.canRun = () => true;
    const enqueue = vi.spyOn(reopened.service, "startSetRender");
    reopened.workflows.kick();
    expect(reopened.workflows.get(row.id).renderJobId).toBe(row.renderJobId);
    expect(enqueue).not.toHaveBeenCalled();
    expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM render_jobs").get()).toEqual({ n: 1 });
  });

  it.each(["withheld", "bad-check", "bad-file"])(
    "never reports success for %s output",
    async (failure) => {
      const { runtime } = await fixture();
      const plan = runtime.service.createSetPlan(brief).plan;
      const row = runtime.workflows.start({ brief, requestToken: failure });
      row.stage = "check";
      row.candidates = {};
      row.planId = plan.id;
      row.renderJobId = crypto.randomUUID();
      runtime.workflows.repository.save(row);
      const base = runtime.renderJobs.insertQueued({
        id: row.renderJobId,
        kind: "full",
        setPlanId: plan.id,
      });
      vi.spyOn(runtime.service, "getRenderStatus").mockReturnValue({
        ...base,
        status: "succeeded",
        outputRootRelativePath: "renders/master.flac",
        listenRootRelativePath: failure === "withheld" ? null : "renders/listen.flac",
      });
      vi.spyOn(runtime.service, "checkRender").mockResolvedValue({
        renderJobId: row.renderJobId,
        outputPath: "private-path",
        durationMs: 180000,
        plannedDurationMs: 180000,
        durationErrorMs: 0,
        durationStatus: "pass",
        interiorSilence: [],
        joins: [],
        failures: [],
        warnings: [],
        ok: failure !== "bad-check",
      });
      vi.spyOn(runtime.workflows.preflight, "verifyOutput").mockResolvedValue(
        failure !== "bad-file",
      );
      runtime.workflows.canRun = () => true;
      runtime.workflows.kick();
      await expect.poll(() => runtime.workflows.get(row.id).status).toBe("failed");
      const result = runtime.workflows.get(row.id);
      expect(result.result).toMatchObject({ verified: false, master: "renders/master.flac" });
      expect(JSON.stringify(result)).not.toContain("private-path");
    },
  );

  it("migrates a prior catalog while preserving plans, tracks and evidence", async () => {
    const { runtime, library, config } = await fixture();
    await writeSineWav(path.join(library, "source.wav"), { durationMs: 1000 });
    await runtime.service.scanLibrary();
    const track = runtime.repository.listAll()[0]!;
    runtime.service.updateTrackMetadata(track.id, { musicalKey: "Am", keySource: "manual" });
    runtime.analyses.upsertBeatAnchor(track.id, 100);
    const plan = runtime.service.createSetPlan(brief).plan;
    runtime.db.exec(
      "DROP TABLE mix_workflows; DROP TABLE analysis_stages; DELETE FROM schema_migrations WHERE id >= 16",
    );
    await runtime.close();
    const reopened = createCatalogRuntime(config, undefined, {
      passive: true,
      useFakeFfmpeg: true,
    });
    cleanup.push(() => reopened.close());
    expect(reopened.repository.findById(track.id)).toMatchObject({
      musicalKey: "Am",
      keySource: "manual",
    });
    expect(reopened.service.getSetPlan(plan.id)).toEqual(plan);
    expect(reopened.analyses.getBeatAnchorMs(track.id)).toBe(100);
    expect(reopened.analyses.getStage(track.id, "key")).toBeNull();
  });
});
