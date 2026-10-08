import { describe, expect, it } from "vitest";

import { sonicDescriptorsSchema } from "../src/analysis-contracts.ts";
import type { SonicDescriptors } from "../src/analysis.ts";
import { BAR_SERIES_KEYS, SONIC_DESCRIPTOR_KEYS } from "../src/type-mirror-checks.ts";

/**
 * F5 (repository review 2026-10-08): the public descriptor schema silently
 * stripped committed fields (grooveSyncopation, backbeatConcentration,
 * bars.syncopation) and initially missed the DSP 3.12 phase diagnostics.
 * These fixtures pin that a fully-populated descriptor survives a schema
 * round-trip byte-for-byte, that legacy descriptors stay valid, and that
 * the schema's keys and the hand-written type's keys cannot drift apart.
 */

function populatedDescriptor(): SonicDescriptors {
  return {
    integratedLufs: -9.4,
    shortTermRmsDbfsMean: -11.2,
    shortTermRmsDbfsMax: -6.8,
    truePeakDb: -0.9,
    subBassRatio: 0.42,
    brightness: 0.31,
    onsetDensity: 5.2,
    dynamicRange: 0.66,
    dropIntensity: 0.81,
    suggestedEnergy: 7,
    energy: 0.62,
    danceability: 0.7,
    acousticness: 0.08,
    melodicness: 0.44,
    valence: 0.51,
    waveformSummary: [0.1, 0.4, 0.9, 0.4],
    lowBandEnergy: 0.5,
    midBandEnergy: 0.3,
    highBandEnergy: 0.2,
    chromaVector: Array.from({ length: 12 }, (_, i) => (i === 5 ? 0.9 : 0.05)),
    tempoEvidence: {
      prominence: 0.9,
      stability: 0.8,
      tempoConf: 0.95,
      onGridRatio: 0.97,
      agreement: 0.9,
    },
    audioStartMs: 120,
    audioEndMs: 232_000,
    bars: {
      rms: [0.4, 0.8, 0.8, 0.3],
      sub: [0.5, 0.7, 0.7, 0.2],
      midFlux: [0.2, 0.6, 0.6, 0.1],
      onsetDensity: [0.2, 0.9, 0.9, 0.1],
      syncopation: [0.1, null, 0.84, 0.44],
      beatKick: [1, 0, 0, 0],
      beatSnare: [0, 1, 0, 1],
      beatOnset: [0.8, 0.8, 0.1, 0.8],
    },
    keyCandidates: ["Fm", "Dm"],
    grooveSyncopation: 0.84,
    backbeatConcentration: 0.66,
    gridPhaseMaxErrorMs: 93,
    gridPhaseSuspect: true,
    beatPhaseHistogram: Array.from({ length: 20 }, (_, i) => (i === 0 ? 1 : 0.1)),
  };
}

describe("sonic descriptor contract (F5)", () => {
  it("keeps every committed and 3.12 field through a schema round-trip", () => {
    const descriptor = populatedDescriptor();
    const parsed = sonicDescriptorsSchema.parse(descriptor);
    expect(parsed).toEqual(descriptor);
  });

  it("keeps JSON-serialization round-trips lossless", () => {
    const descriptor = populatedDescriptor();
    const parsed = sonicDescriptorsSchema.parse(JSON.parse(JSON.stringify(descriptor)));
    expect(parsed).toEqual(descriptor);
  });

  it("still accepts legacy descriptors that predate the optional fields", () => {
    const parsed = sonicDescriptorsSchema.parse({
      integratedLufs: null,
      shortTermRmsDbfsMean: null,
      shortTermRmsDbfsMax: null,
      truePeakDb: null,
      subBassRatio: 0.5,
      brightness: 0.1,
      onsetDensity: null,
      dynamicRange: null,
      dropIntensity: null,
      suggestedEnergy: 6,
      waveformSummary: [],
      lowBandEnergy: null,
      midBandEnergy: null,
      highBandEnergy: null,
      bars: { rms: [0.5, 0.5] },
    });
    expect(parsed.grooveSyncopation).toBeUndefined();
    expect(parsed.bars?.syncopation).toBeUndefined();
    expect(parsed.bars?.sub).toBeUndefined();
  });

  it("rejects a descriptor key the schema does not know", () => {
    // The guard's other half: a field that is NOT in the contract must not
    // slip through parsing unnoticed. zod strips unknown keys, so an
    // unlisted field on the wire is dropped — the key-set checks below are
    // what make that visible instead of silent.
    const parsed = sonicDescriptorsSchema.parse({
      ...populatedDescriptor(),
      notARealDescriptorField: 42,
    });
    expect(Object.keys(parsed)).not.toContain("notARealDescriptorField");
  });

  it("keeps the schema's keys exactly on the type's key list", () => {
    expect([...Object.keys(sonicDescriptorsSchema.shape)].sort()).toEqual(
      [...SONIC_DESCRIPTOR_KEYS].sort(),
    );
  });

  it("keeps the per-bar series keys exactly on the type's key list", () => {
    const bars = sonicDescriptorsSchema.shape.bars?.unwrap().unwrap();
    expect(bars).toBeDefined();
    expect(Object.keys(bars.shape).sort()).toEqual([...BAR_SERIES_KEYS].sort());
  });
});
