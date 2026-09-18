import { describe, expect, it } from "vitest";

import { searchOnsetLockOffset } from "../src/planning/onset-lock.ts";

const BEAT_MS = 60_000 / 174;
const BARS = 16;

function drumPattern(
  beats: number,
  kickShift = 0,
): {
  rms: number[];
  beatKick: number[];
  beatSnare: number[];
  beatOnset: number[];
} {
  const beatKick: number[] = [];
  const beatSnare: number[] = [];
  const beatOnset: number[] = [];
  for (let i = 0; i < beats; i += 1) {
    const pos = (((i - kickShift) % 4) + 4) % 4;
    const kick = pos === 0 ? 1 : pos === 2 ? 0.08 : 0.02;
    const snare = pos === 2 ? 1 : 0.05;
    beatKick.push(kick);
    beatSnare.push(snare);
    beatOnset.push(kick + snare);
  }
  return {
    rms: new Array<number>(Math.ceil(beats / 4)).fill(0.7),
    beatKick,
    beatSnare,
    beatOnset,
  };
}

function barEnergy(
  bars: number,
  shiftBars = 0,
): {
  rms: number[];
  sub: number[];
  onsetDensity: number[];
} {
  const motif = [0.1, 0.85, 0.2, 0.9, 0.15, 0.7, 0.25, 0.95];
  const rms: number[] = [];
  const sub: number[] = [];
  const onsetDensity: number[] = [];
  for (let i = 0; i < bars; i += 1) {
    const value = motif[(((i - shiftBars) % motif.length) + motif.length) % motif.length] ?? 0.1;
    rms.push(value);
    sub.push(value * 0.9);
    onsetDensity.push(value);
  }
  return { rms, sub, onsetDensity };
}

describe("onset lock", () => {
  it("slips incoming one beat when kicks sit on the outgoing snare", () => {
    const outgoing = drumPattern(64);
    const incoming = drumPattern(64, 1);
    const locked = searchOnsetLockOffset({
      outgoing,
      incoming,
      mixOutBar: 0,
      mixInBar: 0,
      barCount: BARS,
      beatMs: BEAT_MS,
    });
    expect(locked.applied).toBe(true);
    expect(locked.beats).toBe(1);
    expect(Math.abs(locked.offsetMs - BEAT_MS)).toBeLessThan(2);
  });

  it("leaves an already-aligned drum pattern alone", () => {
    const pattern = drumPattern(64);
    const locked = searchOnsetLockOffset({
      outgoing: pattern,
      incoming: pattern,
      mixOutBar: 0,
      mixInBar: 0,
      barCount: BARS,
      beatMs: BEAT_MS,
    });
    expect(locked.applied).toBe(false);
    expect(locked.beats).toBe(0);
    expect(locked.offsetMs).toBe(0);
  });

  it("uses bar energy to slip a late vocal/drop by one bar", () => {
    const outgoing = barEnergy(32);
    const incoming = barEnergy(32, 1);
    const locked = searchOnsetLockOffset({
      outgoing,
      incoming,
      mixOutBar: 0,
      mixInBar: 0,
      barCount: BARS,
      beatMs: BEAT_MS,
    });
    expect(locked.applied).toBe(true);
    expect(locked.beats).toBe(4);
    expect(Math.abs(locked.offsetMs - 4 * BEAT_MS)).toBeLessThan(2);
  });

  it("compares bar-anchored content when the beat arrays start before bar 0", () => {
    // Same absolute grid on both decks, but the incoming beat tracker emitted
    // two leading beats before the first downbeat. Bar coordinates match, so no
    // slip is needed. Without the beat offsets the lock compares non-overlapping
    // content and invents a +2-beat slip that ruins a good join.
    const base = drumPattern(128);
    const outgoing = { ...base };
    const incoming = {
      rms: base.rms,
      beatKick: [0.01, 0.01, ...base.beatKick],
      beatSnare: [0.01, 0.01, ...base.beatSnare],
      beatOnset: [0.01, 0.01, ...base.beatOnset],
    };
    const anchored = searchOnsetLockOffset({
      outgoing,
      incoming,
      mixOutBar: 8,
      mixInBar: 8,
      barCount: BARS,
      beatMs: BEAT_MS,
      outBeatOffset: 0,
      inBeatOffset: 2,
    });
    expect(anchored.applied).toBe(false);
    expect(anchored.beats).toBe(0);
    const unanchored = searchOnsetLockOffset({
      outgoing,
      incoming,
      mixOutBar: 8,
      mixInBar: 8,
      barCount: BARS,
      beatMs: BEAT_MS,
    });
    expect(unanchored.applied).toBe(true);
    // +2 and -2 align period-4 content identically; the loop prefers -2.
    expect(Math.abs(unanchored.beats)).toBe(2);
  });

  it("still finds a one-beat slip relative to anchored bar coordinates", () => {
    const outgoing = drumPattern(128);
    const incoming = drumPattern(128, 1);
    const locked = searchOnsetLockOffset({
      outgoing,
      incoming,
      mixOutBar: 8,
      mixInBar: 8,
      barCount: BARS,
      beatMs: BEAT_MS,
      outBeatOffset: 0,
      inBeatOffset: 2,
    });
    expect(locked.applied).toBe(true);
    // +1 pattern slip minus the 2-beat grid phase: net -1 beat.
    expect(locked.beats).toBe(-1);
  });

  it("abstains when every shift scores weakly on sparse content", () => {
    // Flat low-energy patterns: nothing genuinely locks, so even the best
    // shift must not move the join.
    const flat: {
      rms: number[];
      beatKick: number[];
      beatSnare: number[];
      beatOnset: number[];
    } = {
      rms: new Array<number>(32).fill(0.2),
      beatKick: new Array<number>(64).fill(0.05),
      beatSnare: new Array<number>(64).fill(0.05),
      beatOnset: new Array<number>(64).fill(0.05),
    };
    const locked = searchOnsetLockOffset({
      outgoing: flat,
      incoming: {
        ...flat,
        beatKick: flat.beatKick.map((v: number, i: number) => (i % 7 === 0 ? v + 0.02 : v)),
      },
      mixOutBar: 0,
      mixInBar: 0,
      barCount: BARS,
      beatMs: BEAT_MS,
    });
    expect(locked.applied).toBe(false);
    expect(locked.beats).toBe(0);
    expect(locked.offsetMs).toBe(0);
  });

  it("does nothing without overlap energy", () => {
    const locked = searchOnsetLockOffset({
      outgoing: null,
      incoming: null,
      mixOutBar: 8,
      mixInBar: 8,
      barCount: BARS,
      beatMs: BEAT_MS,
    });
    expect(locked.applied).toBe(false);
    expect(locked.offsetMs).toBe(0);
  });
});
