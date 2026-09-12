import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildClickTrackPcm,
  createCatalogRuntime,
  encodeMonoWav,
  writeSineWav,
} from "@dnb-crate/catalog";
import type { AppConfig } from "@dnb-crate/domain";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { createDnbCrateMcpServer } from "../src/create-server.ts";

async function tempWorkspace(): Promise<{ config: AppConfig; library: string }> {
  const root = path.join(
    os.tmpdir(),
    `dnb-mcp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(path.join(root, "library"), { recursive: true });
  await mkdir(path.join(root, "output"), { recursive: true });
  return {
    library: path.join(root, "library"),
    config: {
      databasePath: path.join(root, "catalog.sqlite"),
      libraryRoots: [path.join(root, "library")],
      outputRoot: path.join(root, "output"),
      logLevel: "error",
      supportedExtensions: [".wav", ".flac", ".mp3", ".m4a", ".aiff", ".aif"],
    },
  };
}

describe("MCP tool handlers", () => {
  const closers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (closers.length > 0) {
      await closers.pop()?.();
    }
  });

  it("lists tools and round-trips scan, search, resource read, and metadata update", async () => {
    const workspace = await tempWorkspace();
    const runtime = createCatalogRuntime(workspace.config);
    closers.push(() => runtime.close());

    await writeSineWav(path.join(workspace.library, "nightfall.wav"), {
      title: "The Nightfall",
      artist: "Technimatic",
      durationMs: 350,
    });

    const handler = createMcpHandler(() => createDnbCrateMcpServer({ service: runtime.service }));
    const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    const client = new Client(
      { name: "stage1-harness", version: "0.1.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);
    closers.push(async () => {
      await client.close();
      await handler.close();
    });

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "cancel_render_job",
        "compare_track_analyses",
        "create_cue_preview",
        "create_set_plan",
        "create_transition_preview",
        "delete_set_plan",
        "find_compatible_tracks",
        "get_transition_preferences",
        "get_analysis_report",
        "get_analysis_status",
        "get_enrichment_report",
        "get_enrichment_status",
        "get_library_stats",
        "get_planning_readiness",
        "get_render_manifest",
        "get_render_status",
        "get_server_status",
        "get_set_plan",
        "get_track",
        "get_track_analysis",
        "get_track_sections",
        "list_approved_recipes",
        "list_hour_feedback",
        "record_hour_feedback",
        "list_transition_feedback",
        "list_render_jobs",
        "list_set_plans",
        "plan_transition",
        "rate_transition",
        "select_track_evidence",
        "scan_library",
        "search_tracks",
        "set_cue_points",
        "start_metadata_enrichment",
        "start_set_render",
        "start_track_analysis",
        "update_set_plan",
        "update_track_metadata",
        "validate_set_plan",
        "validate_transition",
      ].sort(),
    );

    const status = await client.callTool({ name: "get_server_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({ ok: true, data: { name: "dnb-crate-mcp" } });

    const scanned = await client.callTool({ name: "scan_library", arguments: {} });
    expect(scanned.structuredContent).toMatchObject({
      ok: true,
      data: { upserted: 1, dryRun: false },
    });

    const search = await client.callTool({
      name: "search_tracks",
      arguments: { query: "Technimatic" },
    });
    const searchData = search.structuredContent as {
      ok: true;
      data: { tracks: Array<{ id: string; title: string }> };
    };
    expect(searchData.ok).toBe(true);
    expect(searchData.data.tracks[0]?.title).toBe("The Nightfall");
    const trackId = searchData.data.tracks[0]!.id;

    const updated = await client.callTool({
      name: "update_track_metadata",
      arguments: { trackId, rating: 5, moods: ["liquid"], energy: 4 },
    });
    expect(updated.structuredContent).toMatchObject({
      ok: true,
      data: { rating: 5, energy: 4, moods: ["liquid"] },
    });

    const resources = await client.listResources();
    expect(
      resources.resources.some((resource) => resource.uri === `dnbcrate://tracks/${trackId}`),
    ).toBe(true);

    const read = await client.readResource({ uri: `dnbcrate://tracks/${trackId}` });
    const body = JSON.parse(
      read.contents[0] && "text" in read.contents[0] ? read.contents[0].text : "{}",
    ) as {
      title: string;
      filePath?: string;
    };
    expect(body.title).toBe("The Nightfall");
    expect(body.filePath).toBeUndefined();

    const missing = await client.callTool({
      name: "get_track",
      arguments: { trackId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(missing.structuredContent).toMatchObject({
      ok: false,
      error: { code: "TRACK_NOT_FOUND" },
    });
  });

  it("creates, validates, lists, and reads a set plan over MCP", async () => {
    const workspace = await tempWorkspace();
    const runtime = createCatalogRuntime(workspace.config);
    closers.push(() => runtime.close());

    const insert = (title: string, artist: string, energy: number) => {
      const id = crypto.randomUUID();
      runtime.repository.upsertFromScan({
        id,
        filePath: path.join(workspace.library, `${title}.wav`),
        fileFingerprint: title,
        artist,
        title,
        album: null,
        durationMs: 150_000,
        sampleRateHz: 44100,
        channels: 2,
        bpm: 174,
        bpmSource: "manual",
        musicalKey: "F#m",
        camelotKey: "11A",
        keySource: "manual",
      });
      runtime.service.updateTrackMetadata(id, { energy, rating: 4, moods: ["liquid"] });
      return id;
    };
    const start = insert("Opener", "Alpha", 3);
    insert("Peak", "Bravo", 8);
    const ending = insert("Closer", "Technimatic", 6);

    const handler = createMcpHandler(() => createDnbCrateMcpServer({ service: runtime.service }));
    const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    const client = new Client(
      { name: "stage2-harness", version: "0.2.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);
    closers.push(async () => {
      await client.close();
      await handler.close();
    });

    const prompts = await client.listPrompts();
    expect(prompts.prompts.some((prompt) => prompt.name === "build-dnb-set")).toBe(true);

    const created = await client.callTool({
      name: "create_set_plan",
      arguments: {
        name: "MCP liquid",
        qualityPolicy: "off", // Transport fixture has tags, not accepted beatgrid evidence.
        targetDurationMs: 600_000,
        startTrackId: start,
        endTrackId: ending,
        preferredMoods: ["liquid"],
        seed: 1,
      },
    });
    const payload = created.structuredContent as {
      ok: true;
      data: { plan: { id: string; entries: Array<{ trackId: string }> } };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.plan.entries[0]?.trackId).toBe(start);
    expect(payload.data.plan.entries.at(-1)?.trackId).toBe(ending);

    const planId = payload.data.plan.id;
    const validated = await client.callTool({
      name: "validate_set_plan",
      arguments: { setPlanId: planId },
    });
    expect(validated.structuredContent).toMatchObject({ ok: true, data: { valid: true } });

    const listed = await client.listResources();
    expect(
      listed.resources.some((resource) => resource.uri === `dnbcrate://set-plans/${planId}`),
    ).toBe(true);
  });

  it("queues a WAV render over MCP and exposes the manifest resource", async () => {
    const workspace = await tempWorkspace();
    const runtime = createCatalogRuntime(workspace.config, undefined, { useFakeFfmpeg: true });
    closers.push(() => runtime.close());

    await writeSineWav(path.join(workspace.library, "alpha.wav"), {
      title: "Alpha",
      artist: "A",
      durationMs: 8000,
    });
    await writeSineWav(path.join(workspace.library, "bravo.wav"), {
      title: "Bravo",
      artist: "B",
      durationMs: 8000,
    });
    await runtime.service.scanLibrary();
    const tracks = runtime.service.searchTracks({ limit: 10 }).tracks;
    const start = tracks.find((track) => track.title === "Alpha")!.id;
    const ending = tracks.find((track) => track.title === "Bravo")!.id;
    const created = runtime.service.createSetPlan({
      name: "MCP render",
      targetDurationMs: 12_000,
      startTrackId: start,
      endTrackId: ending,
      seed: 1,
      qualityPolicy: "off",
    });
    const firstEntry = created.plan.entries[0];
    expect(firstEntry?.transitionToNext?.id).toBeDefined();
    if (firstEntry?.transitionToNext) {
      runtime.service.updateSetPlan({
        setPlanId: created.plan.id,
        setTransition: {
          entryId: firstEntry.id,
          type: "crossfade",
          durationMs: 1000,
        },
      });
    }
    const transitionId = runtime.service.getSetPlan(created.plan.id).entries[0]?.transitionToNext
      ?.id;
    expect(transitionId).toBeDefined();

    const handler = createMcpHandler(() => createDnbCrateMcpServer({ service: runtime.service }));
    const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    const client = new Client(
      { name: "stage3-harness", version: "0.3.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);
    closers.push(async () => {
      await client.close();
      await handler.close();
    });

    const queued = await client.callTool({
      name: "start_set_render",
      arguments: { setPlanId: created.plan.id },
    });
    const jobPayload = queued.structuredContent as {
      ok: true;
      data: { id: string; status: string };
    };
    expect(jobPayload.ok).toBe(true);
    expect(["queued", "running", "succeeded"]).toContain(jobPayload.data.status);

    const done = await runtime.service.waitForRenderJob(jobPayload.data.id, 15_000);
    expect(done.status).toBe("succeeded");

    const status = await client.callTool({
      name: "get_render_status",
      arguments: { renderJobId: done.id },
    });
    expect(status.structuredContent).toMatchObject({
      ok: true,
      data: {
        status: "succeeded",
        outputFormat: "flac",
        listenRootRelativePath: "renders/mcp-render.flac",
      },
    });

    const manifest = await client.callTool({
      name: "get_render_manifest",
      arguments: { renderJobId: done.id },
    });
    expect(manifest.structuredContent).toMatchObject({
      ok: true,
      data: { schemaVersion: 1, kind: "full" },
    });

    const preview = await client.callTool({
      name: "create_transition_preview",
      arguments: { setPlanId: created.plan.id, transitionId, windowMs: 30_000 },
    });
    expect(preview.structuredContent).toMatchObject({ ok: true });

    const resources = await client.listResources();
    expect(
      resources.resources.some(
        (resource) => resource.uri === `dnbcrate://renders/${done.id}/manifest`,
      ),
    ).toBe(true);
  });

  it("returns get_analysis_report shape and create_cue_preview with fake ffmpeg", async () => {
    const workspace = await tempWorkspace();
    const runtime = createCatalogRuntime(workspace.config, undefined, { useFakeFfmpeg: true });
    closers.push(() => runtime.close());

    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(workspace.library, "click.wav"),
      encodeMonoWav(buildClickTrackPcm({ bpm: 174, durationMs: 12_000 })),
    );
    await runtime.service.scanLibrary();
    const track = runtime.service.searchTracks({ query: "click", limit: 1 }).tracks[0]!;
    runtime.service.updateTrackMetadata(track.id, { bpm: 174, bpmSource: "published" });
    const started = runtime.service.startTrackAnalysis({ trackIds: [track.id] });
    await runtime.service.waitForAnalysisJob(started.job.id, 60_000);

    const handler = createMcpHandler(() => createDnbCrateMcpServer({ service: runtime.service }));
    const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    const client = new Client(
      { name: "analysis-harness", version: "0.5.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);
    closers.push(async () => {
      await client.close();
      await handler.close();
    });

    const report = await client.callTool({ name: "get_analysis_report", arguments: {} });
    const reportPayload = report.structuredContent as {
      ok: true;
      data: {
        inRange: { count: number; withinHalf: number };
        outOfRange: { count: number };
        engines: unknown[];
        needsReview: unknown[];
      };
    };
    expect(reportPayload.ok).toBe(true);
    expect(reportPayload.data.inRange.count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(reportPayload.data.engines)).toBe(true);
    expect(Array.isArray(reportPayload.data.needsReview)).toBe(true);

    const preview = await client.callTool({
      name: "create_cue_preview",
      arguments: { trackId: track.id, cue: "drop" },
    });
    expect(preview.structuredContent).toMatchObject({
      ok: true,
      data: { trackId: track.id, cue: "drop" },
    });
  });
});
