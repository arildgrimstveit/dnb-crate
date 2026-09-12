import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildClickTrackPcm, encodeMonoWav } from "@dnb-crate/audio-analysis";
import {
  DSP_ANALYZER_NAME,
  DSP_ANALYZER_VERSION,
  type AppConfig,
  type SetPlanV1,
} from "@dnb-crate/domain";

import { createCatalogRuntime, writeSineWav } from "../src/index.ts";

function testConfig(root: string): AppConfig {
  return {
    databasePath: path.join(root, "catalog.sqlite"),
    libraryRoots: [path.join(root, "library")],
    outputRoot: path.join(root, "output"),
    logLevel: "error",
    supportedExtensions: [".wav", ".flac", ".mp3", ".m4a", ".aiff", ".aif"],
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("track analysis and aligned transitions", () => {
  it("analyzes a 174 BPM click track and keeps manual BPM over the analyzer", async () => {
    const root = path.join(
      os.tmpdir(),
      `dnb-an-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, { useFakeFfmpeg: true });
    cleanups.push(() => catalog.close());
    const pcm = buildClickTrackPcm({ bpm: 174, durationMs: 12_000 });
    await writeFile(path.join(library, "click.wav"), encodeMonoWav(pcm));
    await catalog.service.scanLibrary();
    const track = catalog.service.searchTracks({ query: "click", limit: 1 }).tracks[0]!;
    catalog.service.updateTrackMetadata(track.id, { bpm: 170, energy: 8 });
    const started = catalog.service.startTrackAnalysis({ trackIds: [track.id] });
    const done = await catalog.service.waitForAnalysisJob(started.job.id, 60_000);
    expect(done.status).toBe("succeeded");
    const analysis = catalog.service.getTrackAnalysis(track.id);
    expect(analysis.canonicalBpm).toBe(170);
    expect(analysis.canonicalBpmSource).toBe("manual");
    expect(analysis.gridRejected).toBe(false);
    expect(analysis.gridSource).toBe("analyzed");
    expect(Math.abs((analysis.bpm ?? 0) - 174)).toBeLessThan(1);
    expect(analysis.suggestedCues.length).toBeGreaterThan(0);
    expect(analysis.analyzerVersion).toBe("3.2.0");
    expect(analysis.descriptors?.energy).toBeTypeOf("number");
    expect(analysis.descriptors?.danceability).toBeTypeOf("number");
  });

  it("ranks bass_swap when energy rises and blocks aligned render on a rejected grid", async () => {
    const root = path.join(
      os.tmpdir(),
      `dnb-tr-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, { useFakeFfmpeg: true });
    cleanups.push(() => catalog.close());
    await writeSineWav(path.join(library, "alpha.wav"), {
      title: "Alpha",
      artist: "A",
      durationMs: 8000,
    });
    await writeSineWav(path.join(library, "bravo.wav"), {
      title: "Bravo",
      artist: "B",
      durationMs: 8000,
    });
    await catalog.service.scanLibrary();
    const tracks = catalog.service.searchTracks({ limit: 10 }).tracks;
    const alpha = tracks.find((item) => item.title === "Alpha")!;
    const bravo = tracks.find((item) => item.title === "Bravo")!;
    catalog.service.updateTrackMetadata(alpha.id, { energy: 4, bpm: 174 });
    catalog.service.updateTrackMetadata(bravo.id, { energy: 9, bpm: 174 });
    const started = catalog.service.startTrackAnalysis({
      trackIds: [alpha.id, bravo.id],
    });
    await catalog.service.waitForAnalysisJob(started.job.id, 60_000);
    const planned = catalog.service.planTransition({
      outgoingTrackId: alpha.id,
      incomingTrackId: bravo.id,
      preferredType: "any",
      barCount: 16,
    });
    expect(planned.proposals[0]?.type).toBe("bass_swap");
    const validated = catalog.service.validateTransition({
      outgoingTrackId: alpha.id,
      incomingTrackId: bravo.id,
      type: "phrase_mix",
      barCount: 16,
    });
    expect(validated.valid).toBe(false);

    const transitionId = crypto.randomUUID();
    const plan: SetPlanV1 = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      name: "Aligned block",
      targetDurationMs: 15_000,
      targetBpm: 174,
      requestedArc: [
        { atFraction: 0, targetEnergy: 3 },
        { atFraction: 1, targetEnergy: 9 },
      ],
      entries: [
        {
          id: crypto.randomUUID(),
          trackId: alpha.id,
          order: 0,
          sourceStartMs: 0,
          sourceEndMs: 8000,
          timelineStartMs: 0,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: {
            id: transitionId,
            type: "phrase_mix",
            durationMs: 2000,
            outgoingCuePointId: null,
            incomingCuePointId: null,
            parameters: {},
          },
        },
        {
          id: crypto.randomUUID(),
          trackId: bravo.id,
          order: 1,
          sourceStartMs: 0,
          sourceEndMs: 8000,
          timelineStartMs: 6000,
          playbackRate: 1,
          gainDb: 0,
          transitionToNext: null,
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    catalog.setPlans.save(plan, 1, {
      seed: 1,
      selected: [],
      rejected: [],
      harmonicCoverage: { knownJoins: 0, totalJoins: 0 },
    });
    await expect(catalog.service.startSetRender({ setPlanId: plan.id })).rejects.toMatchObject({
      code: "INVALID_SET_PLAN",
    });
    const crossfade = catalog.service.updateSetPlan({
      setPlanId: plan.id,
      setTransition: { entryId: plan.entries[0]!.id, type: "crossfade", durationMs: 1000 },
    });
    expect(crossfade.plan.entries[0]?.transitionToNext?.type).toBe("crossfade");
    const startedRender = await catalog.service.startSetRender({ setPlanId: plan.id });
    const done = await catalog.service.waitForRenderJob(startedRender.job.id, 15_000);
    expect(done.status).toBe("succeeded");
  });

  it("splits in-range and out-of-range published BPM in the analysis report", async () => {
    const root = path.join(
      os.tmpdir(),
      `dnb-rep-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, { useFakeFfmpeg: true });
    cleanups.push(() => catalog.close());
    const click = buildClickTrackPcm({ bpm: 174, durationMs: 12_000 });
    await writeFile(path.join(library, "inrange.wav"), encodeMonoWav(click));
    await writeSineWav(path.join(library, "outrange.wav"), {
      title: "Out",
      artist: "X",
      durationMs: 4000,
    });
    await catalog.service.scanLibrary();
    const tracks = catalog.service.searchTracks({ limit: 10 }).tracks;
    const inRange = tracks.find((item) => item.title === "inrange")!;
    const outRange = tracks.find((item) => item.title === "Out")!;
    catalog.service.updateTrackMetadata(inRange.id, { bpm: 174, bpmSource: "published" });
    catalog.service.updateTrackMetadata(outRange.id, { bpm: 125, bpmSource: "published" });
    const started = catalog.service.startTrackAnalysis({
      trackIds: [inRange.id, outRange.id],
    });
    await catalog.service.waitForAnalysisJob(started.job.id, 60_000);
    const report = catalog.service.getAnalysisReport();
    expect(report.inRange.count).toBeGreaterThanOrEqual(1);
    expect(report.outOfRange.count).toBeGreaterThanOrEqual(1);
    expect(report.needsReview.some((row) => row.reason === "out-of-range")).toBe(true);
    expect(report.engines.some((row) => row.trackId === inRange.id)).toBe(true);
    expect(report.dspWithinHalfBpm).toBe(report.inRange.withinHalf);
  });

  it("selects unanalyzed and stale scopes", async () => {
    const root = path.join(
      os.tmpdir(),
      `dnb-scope-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, { useFakeFfmpeg: true });
    cleanups.push(() => catalog.close());
    await writeSineWav(path.join(library, "fresh.wav"), { title: "Fresh", durationMs: 2000 });
    await writeSineWav(path.join(library, "oldver.wav"), { title: "OldVer", durationMs: 2000 });
    await writeSineWav(path.join(library, "noref.wav"), { title: "NoRef", durationMs: 2000 });
    await writeSineWav(path.join(library, "plain.wav"), { title: "Plain", durationMs: 2000 });
    await writeSineWav(path.join(library, "v210.wav"), { title: "V210", durationMs: 2000 });
    await catalog.service.scanLibrary();
    const tracks = catalog.service.searchTracks({ limit: 10 }).tracks;
    const fresh = tracks.find((item) => item.title === "Fresh")!;
    const oldVer = tracks.find((item) => item.title === "OldVer")!;
    const noRef = tracks.find((item) => item.title === "NoRef")!;
    const plain = tracks.find((item) => item.title === "Plain")!;
    const v210 = tracks.find((item) => item.title === "V210")!;
    catalog.service.updateTrackMetadata(fresh.id, { bpm: 174, bpmSource: "published" });
    catalog.service.updateTrackMetadata(noRef.id, { bpm: 174, bpmSource: "published" });
    catalog.service.updateTrackMetadata(v210.id, { bpm: 174, bpmSource: "published" });
    const stub = (trackId: string, version: string, referenceBpm: number | null) => {
      catalog.analyses.upsert({
        trackId,
        analyzerName: DSP_ANALYZER_NAME,
        analyzerVersion: version,
        bpm: 174,
        bpmConfidence: 0.8,
        bpmRaw: 174,
        referenceBpm,
        beatTimesMs: [],
        downbeatTimesMs: [],
        gridRejected: false,
        gridRejectionReason: null,
        gridSource: "analyzed",
        musicalKey: null,
        keyConfidence: null,
        keyMode: null,
        camelotKey: null,
        tempoStability: null,
        downbeatConfidence: null,
        integratedLufs: null,
        truePeakDb: null,
        lowBandEnergy: null,
        midBandEnergy: null,
        highBandEnergy: null,
        waveformSummary: null,
        beatAnchorMs: null,
        descriptors: null,
        engineRuntimeMs: 1,
        analyzedAt: new Date().toISOString(),
        suggestedCues: [],
        sections: [],
      });
      catalog.repository.setAnalysisStatus(trackId, "complete");
    };
    stub(fresh.id, DSP_ANALYZER_VERSION, 174);
    stub(oldVer.id, "2.0.0", null);
    stub(noRef.id, DSP_ANALYZER_VERSION, null);
    stub(v210.id, "2.1.0", 174);

    const unanalyzed = catalog.analyses.listIdsForScope("unanalyzed");
    expect(unanalyzed).toEqual([plain.id]);
    const stale = new Set(catalog.analyses.listIdsForScope("stale"));
    expect(stale.has(plain.id)).toBe(true);
    expect(stale.has(oldVer.id)).toBe(true);
    expect(stale.has(noRef.id)).toBe(true);
    expect(stale.has(v210.id)).toBe(true);
    expect(stale.has(fresh.id)).toBe(false);
    const all = catalog.analyses.listIdsForScope("all");
    expect(all).toHaveLength(5);

    const started = catalog.service.startTrackAnalysis({ scope: "unanalyzed" });
    expect(started.job.trackIds).toEqual([plain.id]);
  });

  it("stores bpmHint on a rejected in-range analysis and keeps published 176 over free 175", async () => {
    const root = path.join(
      os.tmpdir(),
      `dnb-hint-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, { useFakeFfmpeg: true });
    cleanups.push(() => catalog.close());
    const click175 = buildClickTrackPcm({ bpm: 175, durationMs: 12_000 });
    const click174 = buildClickTrackPcm({ bpm: 174, durationMs: 12_000 });
    await writeFile(path.join(library, "memory.wav"), encodeMonoWav(click175));
    await writeFile(path.join(library, "mismatch.wav"), encodeMonoWav(click174));
    await writeFile(path.join(library, "halftime.wav"), encodeMonoWav(click174));
    await writeSineWav(path.join(library, "hintonly.wav"), { title: "HintOnly", durationMs: 2000 });
    await catalog.service.scanLibrary();
    const tracks = catalog.service.searchTracks({ limit: 10 }).tracks;
    const memory = tracks.find((item) => item.title === "memory")!;
    const mismatch = tracks.find((item) => item.title === "mismatch")!;
    const halftime = tracks.find((item) => item.title === "halftime")!;
    const hintOnly = tracks.find((item) => item.title === "HintOnly")!;
    catalog.service.updateTrackMetadata(memory.id, { bpm: 176, bpmSource: "published" });
    catalog.service.updateTrackMetadata(mismatch.id, { bpm: 150, bpmSource: "published" });
    catalog.service.updateTrackMetadata(halftime.id, { bpm: 87, bpmSource: "published" });
    const started = catalog.service.startTrackAnalysis({
      trackIds: [memory.id, mismatch.id, halftime.id],
    });
    await catalog.service.waitForAnalysisJob(started.job.id, 60_000);
    const accepted = catalog.service.getTrackAnalysis(memory.id);
    expect(accepted.gridRejected).toBe(false);
    expect(accepted.gridSource).toBe("analyzed");
    expect(accepted.canonicalBpm).toBe(176);
    expect(accepted.referenceBpm).toBe(176);
    expect(accepted.bpmHint).toBeNull();

    const kept = catalog.service.getTrackAnalysis(mismatch.id);
    expect(kept.gridRejected).toBe(false);
    expect(kept.gridSource).toBe("analyzed");
    expect(Math.abs((kept.bpm ?? 0) - 174)).toBeLessThan(1);
    expect(kept.canonicalBpm).toBe(150);
    expect(kept.bpmHint).toBeNull();

    const folded = catalog.service.getTrackAnalysis(halftime.id);
    expect(folded.gridRejected).toBe(false);
    expect(Math.abs((folded.bpm ?? 0) - 174)).toBeLessThan(1);
    expect(folded.canonicalBpm).toBe(87);

    catalog.analyses.upsert({
      trackId: hintOnly.id,
      analyzerName: DSP_ANALYZER_NAME,
      analyzerVersion: DSP_ANALYZER_VERSION,
      bpm: null,
      bpmConfidence: 0.45,
      bpmRaw: 174,
      referenceBpm: null,
      beatTimesMs: [],
      downbeatTimesMs: [],
      gridRejected: true,
      gridRejectionReason: "low confidence",
      gridSource: "analyzed",
      musicalKey: null,
      keyConfidence: null,
      keyMode: null,
      camelotKey: null,
      tempoStability: null,
      downbeatConfidence: null,
      integratedLufs: null,
      truePeakDb: null,
      lowBandEnergy: null,
      midBandEnergy: null,
      highBandEnergy: null,
      waveformSummary: null,
      beatAnchorMs: null,
      descriptors: null,
      engineRuntimeMs: 1,
      analyzedAt: new Date().toISOString(),
      suggestedCues: [],
      sections: [],
    });
    const readiness = catalog.service.getPlanningReadiness(hintOnly.id).tracks[0]!;
    expect(readiness.missing).not.toContain("bpm");
    expect(readiness.bpmSource).toBe("hint");
  });

  it("pipelines prefetch without changing stored rows", async () => {
    const root = path.join(
      os.tmpdir(),
      `dnb-pipe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const click = buildClickTrackPcm({ bpm: 174, durationMs: 12_000 });
    await writeFile(path.join(library, "one.wav"), encodeMonoWav(click));
    await writeFile(path.join(library, "two.wav"), encodeMonoWav(click));
    const sequential = createCatalogRuntime(
      { ...testConfig(root), analysis: { defaultEngine: "dnb-crate-dsp", prefetch: 0 } },
      undefined,
      { useFakeFfmpeg: true },
    );
    cleanups.push(() => sequential.close());
    await sequential.service.scanLibrary();
    const seqTracks = sequential.service.searchTracks({ limit: 10 }).tracks;
    const seqStarted = sequential.service.startTrackAnalysis({
      trackIds: seqTracks.map((item) => item.id),
    });
    await sequential.service.waitForAnalysisJob(seqStarted.job.id, 60_000);
    const seqRows = seqTracks.map((item) => sequential.service.getTrackAnalysis(item.id));

    const pipedRoot = path.join(
      os.tmpdir(),
      `dnb-pipe2-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const pipedLibrary = path.join(pipedRoot, "library");
    await mkdir(pipedLibrary, { recursive: true });
    await writeFile(path.join(pipedLibrary, "one.wav"), encodeMonoWav(click));
    await writeFile(path.join(pipedLibrary, "two.wav"), encodeMonoWav(click));
    const piped = createCatalogRuntime(
      { ...testConfig(pipedRoot), analysis: { defaultEngine: "dnb-crate-dsp", prefetch: 1 } },
      undefined,
      { useFakeFfmpeg: true },
    );
    cleanups.push(() => piped.close());
    await piped.service.scanLibrary();
    const pipedTracks = piped.service.searchTracks({ limit: 10 }).tracks;
    const pipedStarted = piped.service.startTrackAnalysis({
      trackIds: pipedTracks.map((item) => item.id),
    });
    await piped.service.waitForAnalysisJob(pipedStarted.job.id, 60_000);
    const pipedRows = pipedTracks.map((item) => piped.service.getTrackAnalysis(item.id));
    expect(pipedRows.map((row) => row.bpm)).toEqual(seqRows.map((row) => row.bpm));
    expect(pipedRows.map((row) => row.gridRejected)).toEqual(
      seqRows.map((row) => row.gridRejected),
    );
    expect(pipedRows.map((row) => row.gridSource)).toEqual(seqRows.map((row) => row.gridSource));
  });

  it("rebuilds an anchor grid at the canonical BPM, not the stored analysis BPM", async () => {
    const root = path.join(
      os.tmpdir(),
      `dnb-anchor-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, { useFakeFfmpeg: true });
    cleanups.push(() => catalog.close());
    await writeSineWav(path.join(library, "memory.wav"), {
      title: "Memory",
      artist: "Test",
      durationMs: 12_000,
    });
    await catalog.service.scanLibrary();
    const track = catalog.service.searchTracks({ query: "Memory", limit: 1 }).tracks[0]!;
    catalog.service.updateTrackMetadata(track.id, { bpm: 176, bpmSource: "published" });
    catalog.analyses.upsert({
      trackId: track.id,
      analyzerName: DSP_ANALYZER_NAME,
      analyzerVersion: DSP_ANALYZER_VERSION,
      bpm: 175,
      bpmConfidence: 0.4,
      bpmRaw: 175,
      referenceBpm: 176,
      beatTimesMs: [0, 343],
      downbeatTimesMs: [0],
      gridRejected: true,
      gridRejectionReason: "low confidence",
      gridSource: "analyzed",
      musicalKey: null,
      keyConfidence: 0.01,
      keyMode: null,
      camelotKey: null,
      tempoStability: 0.4,
      downbeatConfidence: 0.4,
      integratedLufs: null,
      truePeakDb: null,
      lowBandEnergy: null,
      midBandEnergy: null,
      highBandEnergy: null,
      waveformSummary: null,
      beatAnchorMs: null,
      descriptors: null,
      engineRuntimeMs: 1,
      analyzedAt: new Date().toISOString(),
      suggestedCues: [],
      sections: [],
    });
    catalog.service.setCuePoints(track.id, [], 0);
    const analysis = catalog.service.getTrackAnalysis(track.id);
    expect(analysis.bpm).toBe(176);
    expect(analysis.gridSource).toBe("anchor");
    expect(analysis.gridRejected).toBe(false);
    expect(analysis.bpmConfidence ?? 0).toBeGreaterThanOrEqual(0.6);
    const period = analysis.beatTimesMs[1]! - analysis.beatTimesMs[0]!;
    expect(period).toBeCloseTo(60_000 / 176, 0);
  });

  it("reads a leftover sidecar rhythm row when evidence is selected", async () => {
    const root = path.join(
      os.tmpdir(),
      `dnb-sel-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, { useFakeFfmpeg: true });
    cleanups.push(() => catalog.close());
    await writeSineWav(path.join(library, "sidecar.wav"), {
      title: "Sidecar",
      artist: "Test",
      durationMs: 12_000,
    });
    await catalog.service.scanLibrary();
    const track = catalog.service.searchTracks({ query: "Sidecar", limit: 1 }).tracks[0]!;
    const base = {
      trackId: track.id,
      analyzerVersion: DSP_ANALYZER_VERSION,
      bpmConfidence: 0.9,
      bpmRaw: 174,
      referenceBpm: null,
      beatTimesMs: [0, 345],
      downbeatTimesMs: [0],
      gridRejected: false,
      gridRejectionReason: null,
      musicalKey: null,
      keyConfidence: null,
      keyMode: null,
      camelotKey: null,
      tempoStability: 0.9,
      downbeatConfidence: 0.8,
      integratedLufs: null,
      truePeakDb: null,
      lowBandEnergy: null,
      midBandEnergy: null,
      highBandEnergy: null,
      waveformSummary: null,
      beatAnchorMs: null,
      descriptors: null,
      engineRuntimeMs: 1,
      analyzedAt: new Date().toISOString(),
      suggestedCues: [],
      sections: [],
    };
    catalog.analyses.upsert({
      ...base,
      analyzerName: DSP_ANALYZER_NAME,
      bpm: 174,
      gridSource: "analyzed",
    });
    catalog.analyses.upsert({
      ...base,
      analyzerName: "beat-this",
      bpm: 176,
      bpmRaw: 176,
      gridSource: "sidecar",
    });
    expect(catalog.service.getTrackAnalysis(track.id).bpm).toBe(174);
    catalog.service.selectTrackEvidence({
      trackId: track.id,
      rhythmEngine: "beat-this",
      reason: "test",
    });
    expect(catalog.service.getTrackAnalysis(track.id).bpm).toBe(176);
    expect(catalog.service.getTrackAnalysis(track.id).analyzerName).toBe("beat-this");
  });
});
