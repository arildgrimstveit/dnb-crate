import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DSP_ANALYZER_NAME, DSP_ANALYZER_VERSION, type AppConfig } from "@dnb-crate/domain";

import { createCatalogRuntime, writeSineWav } from "../src/index.ts";
import {
  analysisForTimeline,
  resolveFrozenEvidence,
  snapshotTrackEvidence,
} from "../src/evidence.ts";

function testConfig(root: string): AppConfig {
  return {
    databasePath: path.join(root, "catalog.sqlite"),
    libraryRoots: [path.join(root, "library")],
    outputRoot: path.join(root, "output"),
    logLevel: "error",
    supportedExtensions: [".wav"],
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

const analysisBase = {
  analyzerVersion: DSP_ANALYZER_VERSION,
  bpm: 174,
  bpmConfidence: 0.9,
  bpmRaw: 174,
  referenceBpm: null,
  beatTimesMs: [0, 345],
  downbeatTimesMs: [0],
  gridRejected: false,
  gridRejectionReason: null,
  musicalKey: "Fm",
  keyConfidence: 0.7,
  keyMode: "minor" as const,
  camelotKey: "4A",
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
};

describe("evidence and cue edits", () => {
  it("leaves stored cues unchanged when a beat-anchor edit is rejected", async () => {
    const root = path.join(os.tmpdir(), `dnb-cue-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, { useFakeFfmpeg: true });
    cleanups.push(() => catalog.close());
    await writeSineWav(path.join(library, "short.wav"), { title: "Short", durationMs: 1000 });
    await catalog.service.scanLibrary();
    const track = catalog.service.searchTracks({ query: "Short", limit: 1 }).tracks[0]!;
    catalog.service.setCuePoints(track.id, [{ type: "drop", positionMs: 500, label: "drop" }]);
    expect(catalog.service.getTrack(track.id).cuePoints).toHaveLength(1);
    expect(() => catalog.service.setCuePoints(track.id, [], 2000)).toThrow(
      /Beat anchor is past the track duration/,
    );
    const after = catalog.service.getTrack(track.id);
    expect(after.cuePoints).toHaveLength(1);
    expect(after.cuePoints[0]?.positionMs).toBe(500);
  });

  it("plans sections from the selected structure engine", async () => {
    const root = path.join(os.tmpdir(), `dnb-struct-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, { useFakeFfmpeg: true });
    cleanups.push(() => catalog.close());
    await writeSineWav(path.join(library, "split.wav"), {
      title: "Split",
      durationMs: 12_000,
    });
    await catalog.service.scanLibrary();
    const track = catalog.service.searchTracks({ query: "Split", limit: 1 }).tracks[0]!;
    catalog.analyses.upsert({
      ...analysisBase,
      trackId: track.id,
      analyzerName: DSP_ANALYZER_NAME,
      gridSource: "analyzed",
      sections: [
        {
          type: "intro",
          startMs: 0,
          endMs: 4_000,
          startBar: 0,
          endBar: 8,
          confidence: 0.8,
          sectionEnergy: 0.3,
        },
        {
          type: "drop",
          startMs: 4_000,
          endMs: 12_000,
          startBar: 8,
          endBar: 32,
          confidence: 0.9,
          sectionEnergy: 0.8,
        },
      ],
    });
    catalog.analyses.upsert({
      ...analysisBase,
      trackId: track.id,
      analyzerName: "legacy-structure",
      bpm: 170,
      gridSource: "sidecar",
      sections: [
        {
          type: "intro",
          startMs: 0,
          endMs: 8_000,
          startBar: 0,
          endBar: 16,
          confidence: 0.8,
          sectionEnergy: 0.3,
        },
        {
          type: "drop",
          startMs: 8_000,
          endMs: 12_000,
          startBar: 16,
          endBar: 32,
          confidence: 0.9,
          sectionEnergy: 0.8,
        },
      ],
    });
    expect(catalog.service.getTrackSections(track.id).sections[1]?.startMs).toBe(4_000);
    catalog.service.selectTrackEvidence({
      trackId: track.id,
      rhythmEngine: DSP_ANALYZER_NAME,
      structureEngine: "legacy-structure",
      reason: "test",
    });
    const sections = catalog.service.getTrackSections(track.id);
    expect(sections.analyzerName).toBe("legacy-structure");
    expect(sections.sections.find((section) => section.type === "drop")?.startMs).toBe(8_000);
    expect(catalog.service.getTrackAnalysis(track.id).bpm).toBe(174);
    expect(catalog.service.getTrackAnalysis(track.id).sections[1]?.startMs).toBe(8_000);
    expect(() =>
      catalog.service.selectTrackEvidence({
        trackId: track.id,
        structureEngine: "missing-engine",
      }),
    ).toThrow(/No structure analysis/);
  });

  it("does not fall back to live analysis when frozen evidence is absent", async () => {
    const root = path.join(os.tmpdir(), `dnb-frozen-${crypto.randomUUID()}`);
    const library = path.join(root, "library");
    await mkdir(library, { recursive: true });
    const catalog = createCatalogRuntime(testConfig(root), undefined, { useFakeFfmpeg: true });
    cleanups.push(() => catalog.close());
    await writeSineWav(path.join(library, "empty.wav"), { title: "Empty", durationMs: 1000 });
    await catalog.service.scanLibrary();
    const track = catalog.service.searchTracks({ query: "Empty", limit: 1 }).tracks[0]!;
    const absent = snapshotTrackEvidence(catalog.analyses, track.id, track.fileFingerprint);
    expect(absent.present).toBe(false);
    catalog.analyses.upsert({
      ...analysisBase,
      trackId: track.id,
      analyzerName: DSP_ANALYZER_NAME,
      gridSource: "analyzed",
      sections: [],
    });
    const resolved = resolveFrozenEvidence(catalog.analyses, track.id, absent);
    expect(analysisForTimeline(resolved)).toBeNull();
    const live = snapshotTrackEvidence(catalog.analyses, track.id, track.fileFingerprint);
    expect(live.present).toBe(true);
    expect(live.bpm).toBe(174);
    catalog.analyses.upsert({
      ...analysisBase,
      trackId: track.id,
      analyzerName: DSP_ANALYZER_NAME,
      bpm: 160,
      gridSource: "analyzed",
      sections: [],
    });
    expect(analysisForTimeline(resolveFrozenEvidence(catalog.analyses, track.id, live))?.bpm).toBe(
      174,
    );
  });
});
