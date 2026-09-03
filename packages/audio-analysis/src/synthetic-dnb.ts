import type { PcmAudio } from "./types.ts";

export type SyntheticDnbOptions = {
  bpm?: number;
  sampleRateHz?: number;
  introBars?: number;
  dropBars?: number;
  breakdownBars?: number;
  drop2Bars?: number;
  outroBars?: number;
  subHz?: number;
  padFrequencies?: number[];
  detuneCents?: number;
  includeSub?: boolean;
  downbeatOffsetBeats?: number;
  barAccentEvery?: number;
};

function addKick(samples: Float32Array, sampleRateHz: number, start: number, gain: number): void {
  const n = Math.round(sampleRateHz * 0.08);
  for (let i = 0; i < n && start + i < samples.length; i += 1) {
    const t = i / sampleRateHz;
    const env = Math.exp(-t * 28) * gain;
    samples[start + i] = (samples[start + i] ?? 0) + Math.sin(2 * Math.PI * 55 * t) * env;
  }
}

function addSnare(samples: Float32Array, sampleRateHz: number, start: number, gain: number): void {
  const n = Math.round(sampleRateHz * 0.04);
  for (let i = 0; i < n && start + i < samples.length; i += 1) {
    const t = i / sampleRateHz;
    const env = Math.exp(-t * 40) * gain;
    const noise = ((i * 1103515245 + 12345) >>> 16) / 32768 - 1;
    samples[start + i] = (samples[start + i] ?? 0) + noise * env;
  }
}

function addHat(samples: Float32Array, sampleRateHz: number, start: number, gain: number): void {
  const n = Math.round(sampleRateHz * 0.012);
  for (let i = 0; i < n && start + i < samples.length; i += 1) {
    const noise = ((i * 214013 + 2531011) >>> 16) / 32768 - 1;
    samples[start + i] = (samples[start + i] ?? 0) + noise * gain * (1 - i / n);
  }
}

function addSub(
  samples: Float32Array,
  sampleRateHz: number,
  start: number,
  end: number,
  hz: number,
  gain: number,
): void {
  for (let i = start; i < end && i < samples.length; i += 1) {
    const t = i / sampleRateHz;
    samples[i] = (samples[i] ?? 0) + Math.sin(2 * Math.PI * hz * t) * gain;
  }
}

function addPad(
  samples: Float32Array,
  sampleRateHz: number,
  frequencies: number[],
  detuneCents: number,
  gain: number,
): void {
  const detune = 2 ** (detuneCents / 1200);
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / sampleRateHz;
    let v = 0;
    for (const hz of frequencies) {
      v += Math.sin(2 * Math.PI * hz * detune * t);
    }
    samples[i] = (samples[i] ?? 0) + (v / Math.max(1, frequencies.length)) * gain;
  }
}

const KEY_PADS: Record<string, number[]> = {
  "F#m": [185.0, 220.0, 277.18, 369.99, 440.0, 554.37],
  Fm: [174.61, 220.0, 261.63, 349.23, 440.0, 523.25],
  C: [261.63, 329.63, 392.0, 523.25],
  Em: [164.81, 196.0, 246.94, 329.63, 392.0],
};

/** Synthetic 4/4 DnB: kick on 1, snare on 2/4, hats on 8ths, optional pad + sub. */
export function buildSyntheticDnbPcm(options: SyntheticDnbOptions = {}): PcmAudio & {
  expected: { bpm: number; dropMs: number; drop2Ms: number | null; breakdownMs: number; outroMs: number };
} {
  const bpm = options.bpm ?? 174;
  const sampleRateHz = options.sampleRateHz ?? 22_050;
  const introBars = options.introBars ?? 8;
  const dropBars = options.dropBars ?? 16;
  const breakdownBars = options.breakdownBars ?? 8;
  const drop2Bars = options.drop2Bars ?? 0;
  const outroBars = options.outroBars ?? 8;
  const beatMs = 60_000 / bpm;
  const barMs = beatMs * 4;
  const totalBars = introBars + dropBars + breakdownBars + drop2Bars + outroBars;
  const durationMs = totalBars * barMs;
  const frameCount = Math.max(1, Math.round((sampleRateHz * durationMs) / 1000));
  const samples = new Float32Array(frameCount);
  const dropMs = introBars * barMs;
  const breakdownMs = dropMs + dropBars * barMs;
  const drop2Ms = drop2Bars > 0 ? breakdownMs + breakdownBars * barMs : null;
  const outroMs = (drop2Ms ?? breakdownMs) + (drop2Ms !== null ? drop2Bars * barMs : breakdownBars * barMs);

  const totalBeats = totalBars * 4;
  for (let beat = 0; beat < totalBeats; beat += 1) {
    const tMs = beat * beatMs;
    const start = Math.round((tMs / 1000) * sampleRateHz);
    const inDrop =
      (tMs >= dropMs && tMs < breakdownMs) ||
      (drop2Ms !== null && tMs >= drop2Ms && tMs < outroMs);
    const inOutro = outroBars > 0 && tMs >= outroMs;
    const kickGain = inDrop ? 0.95 : inOutro ? 0.25 : 0.45;
    const snareGain = inDrop ? 0.7 : 0.35;
    const phase = options.downbeatOffsetBeats ?? 0;
    const pos = ((beat - phase) % 4 + 4) % 4;
    const barIndex = Math.floor((beat - phase) / 4);
    const accentEvery = Math.max(1, options.barAccentEvery ?? 1);
    const accent = barIndex % accentEvery === 0 ? 1 : 0.55;
    if (pos === 0) {
      addKick(samples, sampleRateHz, start, kickGain * accent);
    }
    if (pos === 1 || pos === 3) {
      addSnare(samples, sampleRateHz, start, snareGain);
    }
    addHat(samples, sampleRateHz, start, inDrop ? 0.12 : 0.06);
    addHat(
      samples,
      sampleRateHz,
      start + Math.round((beatMs / 2 / 1000) * sampleRateHz),
      inDrop ? 0.08 : 0.04,
    );
  }
  const includeSub = options.includeSub !== false;
  const subHz = options.subHz ?? 87.31;
  const dropStart = Math.round((dropMs / 1000) * sampleRateHz);
  const dropEnd = Math.round((breakdownMs / 1000) * sampleRateHz);
  if (includeSub) {
    addSub(samples, sampleRateHz, dropStart, dropEnd, subHz, 0.35);
  }
  if (includeSub && drop2Ms !== null) {
    const d2s = Math.round((drop2Ms / 1000) * sampleRateHz);
    const d2e = Math.round((outroMs / 1000) * sampleRateHz);
    addSub(samples, sampleRateHz, d2s, d2e, subHz, 0.35);
  }
  if (options.padFrequencies && options.padFrequencies.length > 0) {
    addPad(samples, sampleRateHz, options.padFrequencies, options.detuneCents ?? 0, 0.85);
  }

  return {
    samples,
    sampleRateHz,
    durationMs: (frameCount / sampleRateHz) * 1000,
    channels: 1,
    expected: { bpm, dropMs, drop2Ms, breakdownMs, outroMs },
  };
}

/** Drum loop only — no pad, no sub bed. */
export function buildDrumsOnlyDnbPcm(options: SyntheticDnbOptions = {}): PcmAudio & {
  expected: { bpm: number; dropMs: number; drop2Ms: number | null; breakdownMs: number; outroMs: number };
} {
  return buildSyntheticDnbPcm({
    ...options,
    includeSub: false,
    padFrequencies: undefined,
  });
}

/** Sustained triad pad, no drums. */
export function buildPadOnlyPcm(options: {
  key: string;
  durationMs?: number;
  sampleRateHz?: number;
  gain?: number;
}): PcmAudio & { expected: { key: string } } {
  const durationMs = options.durationMs ?? 12_000;
  const sampleRateHz = options.sampleRateHz ?? 22_050;
  const n = Math.round((sampleRateHz * durationMs) / 1000);
  const samples = new Float32Array(n);
  const frequencies = options.key === "C" ? KEY_PADS.C! : (KEY_PADS[options.key] ?? KEY_PADS["F#m"]!);
  addPad(samples, sampleRateHz, frequencies, 0, options.gain ?? 0.16);
  return { samples, sampleRateHz, durationMs, channels: 1, expected: { key: options.key } };
}

/** Synthetic DnB plus a sustained triad pad. Sub defaults below the chroma band (46 Hz F#1). */
export function buildKeyedDnbPcm(
  options: SyntheticDnbOptions & { key: string },
): PcmAudio & {
  expected: {
    bpm: number;
    dropMs: number;
    drop2Ms: number | null;
    breakdownMs: number;
    outroMs: number;
    key: string;
  };
} {
  const pad = options.padFrequencies ?? KEY_PADS[options.key] ?? KEY_PADS["F#m"]!;
  const pcm = buildSyntheticDnbPcm({
    ...options,
    subHz: options.subHz ?? 46.25,
    padFrequencies: pad,
  });
  return { ...pcm, expected: { ...pcm.expected, key: options.key } };
}

/** 124 BPM kicks with 186 BPM hats — 3:2 confusion fixture. */
export function buildOffbeatHatPcm(
  options: {
    kickBpm?: number;
    hatBpm?: number;
    durationMs?: number;
    sampleRateHz?: number;
  } = {},
): PcmAudio & { expected: { kickBpm: number; hatBpm: number } } {
  const kickBpm = options.kickBpm ?? 124;
  const hatBpm = options.hatBpm ?? 186;
  const durationMs = options.durationMs ?? 16_000;
  const sampleRateHz = options.sampleRateHz ?? 22_050;
  const frameCount = Math.max(1, Math.round((sampleRateHz * durationMs) / 1000));
  const samples = new Float32Array(frameCount);
  const kickPeriodMs = 60_000 / kickBpm;
  const hatPeriodMs = 60_000 / hatBpm;
  for (let t = 0; t < durationMs; t += kickPeriodMs) {
    addKick(samples, sampleRateHz, Math.round((t / 1000) * sampleRateHz), 0.95);
  }
  for (let t = hatPeriodMs / 2; t < durationMs; t += hatPeriodMs) {
    addHat(samples, sampleRateHz, Math.round((t / 1000) * sampleRateHz), 0.18);
  }
  return {
    samples,
    sampleRateHz,
    durationMs: (frameCount / sampleRateHz) * 1000,
    channels: 1,
    expected: { kickBpm, hatBpm },
  };
}

export function buildChordPcm(options: {
  frequencies: number[];
  durationMs?: number;
  sampleRateHz?: number;
}): PcmAudio {
  const durationMs = options.durationMs ?? 4000;
  const sampleRateHz = options.sampleRateHz ?? 22_050;
  const n = Math.round((sampleRateHz * durationMs) / 1000);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRateHz;
    let v = 0;
    for (const hz of options.frequencies) {
      v += Math.sin(2 * Math.PI * hz * t);
    }
    samples[i] = (v / options.frequencies.length) * 0.6;
  }
  return { samples, sampleRateHz, durationMs, channels: 1 };
}
