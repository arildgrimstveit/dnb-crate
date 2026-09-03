import type { TempoEvidence } from "@dnb-crate/domain";

/** Reference ranges dated 2026-09-03. Re-tune once after the whole-library 3.0.0 run if a crate spread is < 0.3. */
export const ENERGY_DBFS_LO = -24;
export const ENERGY_DBFS_HI = -8;
export const DFA_FRAME_MS = 10;
export const DFA_TAU_MIN_MS = 310;
export const DFA_TAU_MAX_MS = 8800;
export const DFA_TAU_MULTIPLIER = 1.1;
export const DFA_ALPHA_LO = 0.3;
export const DFA_ALPHA_HI = 1.15;

export type DescriptorChromaStats = {
  chromaClarity: number;
  tonalStability: number;
  tonalPeakRatio: number;
  strongPeakRatio: number;
  majorness: number;
  keyConfidence: number;
};

export type DescriptorPackInput = {
  samples: Float32Array;
  sampleRateHz: number;
  rms: number;
  dropIntensity: number;
  onsetDensity: number;
  subBassRatio: number;
  brightness: number;
  dynamicRangeDb: number;
  tempoEvidence: TempoEvidence | null;
  chroma: DescriptorChromaStats;
};

export type DescriptorPack = {
  energy: number;
  danceability: number;
  acousticness: number;
  melodicness: number;
  valence: number;
  suggestedEnergy: number;
  shortTermLufsMean: number;
  shortTermLufsMax: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length);
}

function rmsToDbfs(rms: number): number {
  return 20 * Math.log10(rms + 1e-12);
}

export function loudnessFromRms(rms: number): number {
  const db = rmsToDbfs(rms);
  return clamp((db - ENERGY_DBFS_LO) / (ENERGY_DBFS_HI - ENERGY_DBFS_LO), 0, 1);
}

function linearDetrend(segment: number[]): number[] {
  const n = segment.length;
  if (n < 2) {
    return segment.map(() => 0);
  }
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    const y = segment[i] ?? 0;
    sumX += i;
    sumY += y;
    sumXY += i * y;
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  const slope = Math.abs(denom) < 1e-12 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return segment.map((y, i) => y - (intercept + slope * i));
}

function dfaFluctuation(integrated: number[], window: number): number | null {
  const nWindows = Math.floor(integrated.length / window);
  if (nWindows < 2 || window < 4) {
    return null;
  }
  let sumVar = 0;
  for (let w = 0; w < nWindows; w += 1) {
    const start = w * window;
    const segment = integrated.slice(start, start + window);
    const residual = linearDetrend(segment);
    let acc = 0;
    for (const value of residual) {
      acc += value * value;
    }
    sumVar += acc / window;
  }
  return Math.sqrt(sumVar / nWindows);
}

function highpass(samples: Float32Array, sampleRateHz: number, hz: number): Float32Array {
  const rc = 1 / (2 * Math.PI * hz);
  const dt = 1 / sampleRateHz;
  const a = rc / (rc + dt);
  const out = new Float32Array(samples.length);
  let prevY = 0;
  let prevX = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const x = samples[i] ?? 0;
    const y = a * (prevY + x - prevX);
    out[i] = y;
    prevY = y;
    prevX = x;
  }
  return out;
}

/** Essentia-style DFA on a 10 ms frame-stddev envelope. Returns a 0–1 danceability term. */
export function dfaDanceabilityTerm(samples: Float32Array, sampleRateHz: number): number {
  const pulsed = highpass(samples, sampleRateHz, 180);
  const frame = Math.max(1, Math.round((sampleRateHz * DFA_FRAME_MS) / 1000));
  const envelope: number[] = [];
  for (let start = 0; start + frame <= pulsed.length; start += frame) {
    const chunk: number[] = [];
    for (let i = 0; i < frame; i += 1) {
      chunk.push(pulsed[start + i] ?? 0);
    }
    envelope.push(stddev(chunk));
  }
  if (envelope.length < 16) {
    return 0.35;
  }
  const envMean = mean(envelope);
  const envStd = stddev(envelope);
  if (envMean < 1e-6 || envStd / envMean < 0.18) {
    return 0;
  }
  const trendWin = Math.max(8, Math.round(2000 / DFA_FRAME_MS));
  const detrended: number[] = [];
  for (let i = 0; i < envelope.length; i += 1) {
    const lo = Math.max(0, i - trendWin);
    const hi = Math.min(envelope.length, i + trendWin + 1);
    let sum = 0;
    for (let j = lo; j < hi; j += 1) {
      sum += envelope[j] ?? 0;
    }
    detrended.push(Math.abs((envelope[i] ?? 0) - sum / Math.max(1, hi - lo)));
  }
  const centeredMean = mean(detrended);
  const integrated: number[] = [];
  let running = 0;
  for (const value of detrended) {
    running += value - centeredMean;
    integrated.push(running);
  }

  const logTau: number[] = [];
  const logF: number[] = [];
  for (
    let tauMs = DFA_TAU_MIN_MS;
    tauMs <= DFA_TAU_MAX_MS;
    tauMs *= DFA_TAU_MULTIPLIER
  ) {
    const window = Math.round(tauMs / DFA_FRAME_MS);
    const fluctuation = dfaFluctuation(integrated, window);
    if (fluctuation == null || fluctuation <= 1e-12) {
      continue;
    }
    logTau.push(Math.log(tauMs));
    logF.push(Math.log(fluctuation));
  }
  if (logTau.length < 3) {
    return 0.35;
  }
  const xMean = mean(logTau);
  const yMean = mean(logF);
  let num = 0;
  let den = 0;
  for (let i = 0; i < logTau.length; i += 1) {
    const dx = (logTau[i] ?? 0) - xMean;
    num += dx * ((logF[i] ?? 0) - yMean);
    den += dx * dx;
  }
  const alpha = den <= 1e-12 ? 1 : num / den;
  return clamp((DFA_ALPHA_HI - alpha) / (DFA_ALPHA_HI - DFA_ALPHA_LO), 0, 1);
}

export function shortTermLoudness(
  samples: Float32Array,
  sampleRateHz: number,
  windowMs = 3000,
): { mean: number; max: number } {
  const window = Math.max(1, Math.round((sampleRateHz * windowMs) / 1000));
  const hop = Math.max(1, Math.round(window / 2));
  const values: number[] = [];
  for (let start = 0; start + window <= samples.length; start += hop) {
    let sum = 0;
    for (let i = 0; i < window; i += 1) {
      const value = samples[start + i] ?? 0;
      sum += value * value;
    }
    values.push(rmsToDbfs(Math.sqrt(sum / window)));
  }
  if (values.length === 0) {
    const rms = Math.sqrt(
      samples.reduce((sum, value) => sum + value * value, 0) / Math.max(1, samples.length),
    );
    const db = rmsToDbfs(rms);
    return { mean: Number(db.toFixed(3)), max: Number(db.toFixed(3)) };
  }
  return {
    mean: Number(mean(values).toFixed(3)),
    max: Number(Math.max(...values).toFixed(3)),
  };
}

export function computeDescriptorPack(input: DescriptorPackInput): DescriptorPack {
  const loud = loudnessFromRms(input.rms);
  const prominence = input.tempoEvidence?.prominence ?? 0;
  const stability = input.tempoEvidence?.stability ?? 0;
  const onsetDensityNorm = clamp(0.45 * (input.onsetDensity / 0.3) + 0.55 * prominence, 0, 1);
  const energy = clamp(
    0.4 * loud + 0.3 * clamp(input.dropIntensity, 0, 1) + 0.3 * onsetDensityNorm,
    0,
    1,
  );
  const dfaRaw = dfaDanceabilityTerm(input.samples, input.sampleRateHz);
  const dfaTerm = Math.max(dfaRaw, prominence * stability);
  const danceability = clamp(0.5 * dfaTerm + 0.3 * prominence + 0.2 * stability, 0, 1);
  const strongPeak = clamp(input.chroma.strongPeakRatio, 0, 1);
  const clarity = clamp(input.chroma.chromaClarity, 0, 1);
  const sub = clamp(input.subBassRatio, 0, 1);
  const acousticness = clamp(
    0.35 * (1 - clamp(sub / 0.5, 0, 1)) +
      0.3 * strongPeak * (1 - clamp(sub / 0.45, 0, 1)) +
      0.2 * clarity * (1 - sub) +
      0.15 * (1 - clamp(input.onsetDensity / 0.5, 0, 1)),
    0,
    1,
  );
  const keyConf = clamp(input.chroma.keyConfidence, 0, 1);
  const melodicness = clamp(
    2.2 * keyConf + 0.15 * strongPeak * strongPeak * (1 - clamp(input.onsetDensity, 0, 1)),
    0,
    1,
  );
  const valence = clamp(
    0.35 * clamp(input.chroma.majorness, 0, 1) +
      0.25 * clamp(input.brightness / 0.15, 0, 1) +
      0.2 * melodicness +
      0.2 * danceability,
    0,
    1,
  );
  const shortTerm = shortTermLoudness(input.samples, input.sampleRateHz);
  return {
    energy: Number(energy.toFixed(4)),
    danceability: Number(danceability.toFixed(4)),
    acousticness: Number(acousticness.toFixed(4)),
    melodicness: Number(melodicness.toFixed(4)),
    valence: Number(valence.toFixed(4)),
    suggestedEnergy: clamp(Math.round(1 + 9 * energy), 1, 10),
    shortTermLufsMean: shortTerm.mean,
    shortTermLufsMax: shortTerm.max,
  };
}
