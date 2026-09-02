import {
  DSP_ANALYZER_NAME,
  DSP_ANALYZER_VERSION,
  DNB_BPM_MAX,
  DNB_BPM_MIN,
  MIN_ANALYSIS_CONFIDENCE,
  normalizeDnbBpm,
  snapToNearestBeat,
  type TrackSection,
} from "@dnb-crate/domain";

import { estimateKeyFromChroma } from "./chroma.ts";
import { stftMagnitude } from "./fft.ts";
import type { AnalyzeOptions, AnalyzerCue, AnalyzerResult, AudioAnalyzer, PcmAudio } from "./types.ts";
import { emptyDescriptors } from "./types.ts";

const NFFT = 2048;
const HOP = 512;
/** Fitted 2026-09-02 on synthetic click/DnB/sine/noise. Re-run tools/scripts/calibrate-confidence.mts after onset/tempo changes. */
const TEMPO_LOGISTIC_BIAS = -1.6;
const TEMPO_LOGISTIC_W_PROMINENCE = 1.0;
const TEMPO_LOGISTIC_W_STABILITY = 3.2;
const TEMPO_LOGISTIC_W_TEMPO_CONF = 1.2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function mad(values: number[]): number {
  const m = median(values);
  return median(values.map((value) => Math.abs(value - m)));
}

function stddev(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length);
}

function hzToBin(hz: number, sampleRateHz: number, nfft: number): number {
  return Math.max(1, Math.min(nfft / 2 - 1, Math.round((hz * nfft) / sampleRateHz)));
}

function bandFlux(
  prev: number[],
  next: number[],
  fromBin: number,
  toBin: number,
): number {
  let sum = 0;
  for (let k = fromBin; k < toBin; k += 1) {
    const a = Math.log1p(prev[k] ?? 0);
    const b = Math.log1p(next[k] ?? 0);
    sum += Math.max(0, b - a);
  }
  return sum;
}

function onsetStrength(mag: number[][], sampleRateHz: number, nfft: number): {
  onset: number[];
  low: number[];
  mid: number[];
} {
  const lowEnd = hzToBin(200, sampleRateHz, nfft);
  const midEnd = hzToBin(2000, sampleRateHz, nfft);
  const highEnd = nfft / 2;
  const onset: number[] = [];
  const low: number[] = [];
  const mid: number[] = [];
  for (let t = 1; t < mag.length; t += 1) {
    const prev = mag[t - 1]!;
    const next = mag[t]!;
    const l = bandFlux(prev, next, 1, lowEnd);
    const m = bandFlux(prev, next, lowEnd, midEnd);
    const h = bandFlux(prev, next, midEnd, highEnd);
    low.push(l);
    mid.push(m);
    onset.push(3 * l + m + 0.25 * h);
  }
  return { onset, low, mid };
}

function autocorr(env: number[], lag: number): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i + lag < env.length; i += 1) {
    sum += (env[i] ?? 0) * (env[i + lag] ?? 0);
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

function timeDomainOnset(samples: Float32Array, hop: number): number[] {
  const n = Math.floor(samples.length / hop);
  const energy = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    const start = i * hop;
    for (let j = 0; j < hop; j += 1) {
      const v = samples[start + j] ?? 0;
      sum += v * v;
    }
    energy[i] = sum;
  }
  const onset: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const prev = i === 0 ? 0 : energy[i - 1]!;
    onset.push(Math.max(0, energy[i]! - prev));
  }
  return onset;
}

function interpolateOnset(onset: number[], frame: number): number {
  const i0 = Math.floor(frame);
  const frac = frame - i0;
  if (i0 < 0 || i0 + 1 >= onset.length) {
    return 0;
  }
  return (onset[i0] ?? 0) * (1 - frac) + (onset[i0 + 1] ?? 0) * frac;
}

function scoreTempoGrid(onset: number[], hopMs: number, bpm: number, offsetMs: number): number {
  const periodMs = 60_000 / bpm;
  const durationMs = onset.length * hopMs;
  let score = 0;
  let n = 0;
  for (let tMs = offsetMs; tMs < durationMs; tMs += periodMs) {
    score += interpolateOnset(onset, tMs / hopMs);
    n += 1;
  }
  return n === 0 ? 0 : score / n;
}

function bestOffsetForBpm(
  onset: number[],
  hopMs: number,
  bpm: number,
): { offsetMs: number; score: number } {
  const periodMs = 60_000 / bpm;
  const step = Math.max(hopMs / 4, 1);
  let bestOffset = 0;
  let bestScore = -Infinity;
  for (let offsetMs = 0; offsetMs < periodMs; offsetMs += step) {
    const score = scoreTempoGrid(onset, hopMs, bpm, offsetMs);
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offsetMs;
    }
  }
  return { offsetMs: bestOffset, score: bestScore };
}

function fitTempoGrid(
  onset: number[],
  hopMs: number,
  seedBpm: number,
  minBpm: number,
  maxBpm: number,
): { bpm: number; offsetMs: number } {
  const folded = normalizeDnbBpm(seedBpm, minBpm, maxBpm)?.bpm ?? seedBpm;
  let bestBpm = folded;
  let bestScore = -Infinity;
  let bestOffset = 0;
  for (let bpm = minBpm; bpm <= maxBpm + 1e-9; bpm += 0.5) {
    const { offsetMs, score } = bestOffsetForBpm(onset, hopMs, bpm);
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
      bestOffset = offsetMs;
    }
  }
  const lo = Math.max(minBpm, bestBpm - 0.75);
  const hi = Math.min(maxBpm, bestBpm + 0.75);
  for (let bpm = lo; bpm <= hi + 1e-9; bpm += 0.05) {
    const { offsetMs, score } = bestOffsetForBpm(onset, hopMs, bpm);
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
      bestOffset = offsetMs;
    }
  }
  return { bpm: bestBpm, offsetMs: bestOffset };
}

function lagsRelated(a: number, b: number): boolean {
  const ratio = a > b ? a / b : b / a;
  return [1, 1.5, 2, 3, 4].some((harmonic) => Math.abs(ratio - harmonic) < 0.14);
}

function interpolatePeak(values: number[], index: number): number {
  const a = values[index - 1] ?? 0;
  const b = values[index] ?? 0;
  const c = values[index + 1] ?? 0;
  const denom = a - 2 * b + c;
  const delta = Math.abs(denom) < 1e-12 ? 0 : clamp((0.5 * (a - c)) / denom, -0.75, 0.75);
  return index + delta;
}

function logistic3(prominence: number, stability: number, tempoConf: number): number {
  const z =
    TEMPO_LOGISTIC_BIAS +
    TEMPO_LOGISTIC_W_PROMINENCE * prominence +
    TEMPO_LOGISTIC_W_STABILITY * stability +
    TEMPO_LOGISTIC_W_TEMPO_CONF * tempoConf;
  return 1 / (1 + Math.exp(-z));
}

function peakBpm(
  onset: number[],
  hopMs: number,
  minBpm: number,
  maxBpm: number,
): { bpmRaw: number; confidence: number } | null {
  const minLag = Math.max(2, Math.round(60_000 / (maxBpm * 2) / hopMs));
  const maxLag = Math.min(onset.length - 2, Math.round(60_000 / (minBpm / 2) / hopMs));
  if (maxLag <= minLag || onset.length < maxLag + 4) {
    return null;
  }
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    scores.push(autocorr(onset, lag));
  }
  const peaks: Array<{ lag: number; index: number; score: number; bpm: number; folded: number | null }> =
    [];
  for (let i = 1; i < scores.length - 1; i += 1) {
    const prev = scores[i - 1] ?? 0;
    const cur = scores[i] ?? 0;
    const next = scores[i + 1] ?? 0;
    if (cur >= prev && cur >= next && cur > 0) {
      const lag = minLag + interpolatePeak(scores, i);
      const bpm = 60_000 / (lag * hopMs);
      peaks.push({
        lag,
        index: i,
        score: cur,
        bpm,
        folded: normalizeDnbBpm(bpm, minBpm, maxBpm)?.bpm ?? null,
      });
    }
  }
  if (peaks.length === 0) {
    return null;
  }
  const ranked = [...peaks].sort((a, b) => {
    const aNative = a.bpm >= minBpm && a.bpm <= maxBpm ? 1.4 : a.folded !== null ? 1 : 0.4;
    const bNative = b.bpm >= minBpm && b.bpm <= maxBpm ? 1.4 : b.folded !== null ? 1 : 0.4;
    return b.score * bNative - a.score * aNative;
  });
  const best = ranked[0]!;
  const competing =
    ranked.find((p) => !lagsRelated(p.lag, best.lag) && p.score > best.score * 0.5)?.score ??
    best.score * 0.35;
  const confidence = clamp(1 - competing / (best.score + 1e-9), 0, 1);
  return { bpmRaw: best.bpm, confidence };
}

function estimateTempo(
  onset: number[],
  hopMs: number,
  minBpm: number,
  maxBpm: number,
): {
  bpmRaw: number;
  confidence: number;
  stability: number;
  offsetMs: number;
  tempoEvidence: {
    prominence: number;
    stability: number;
    tempoConf: number;
    onGridRatio: number;
  };
} | null {
  const best = peakBpm(onset, hopMs, minBpm, maxBpm);
  if (!best) {
    return null;
  }
  const window = Math.max(Math.round(16_000 / hopMs), 64);
  const locals: number[] = [];
  for (let start = 0; start + window < onset.length; start += Math.floor(window / 2)) {
    const local = peakBpm(onset.slice(start, start + window), hopMs, minBpm, maxBpm);
    if (local) {
      locals.push(local.bpmRaw);
    }
  }
  const folded = locals
    .map((bpm) => normalizeDnbBpm(bpm, minBpm, maxBpm)?.bpm)
    .filter((bpm): bpm is number => bpm !== undefined);
  const stability =
    folded.length === 0 ? best.confidence : clamp(1 - mad(folded) / 5, 0, 1);
  const prominence = clamp(0.65 * best.confidence + 0.35 * stability, 0, 1);
  const fitted = fitTempoGrid(onset, hopMs, best.bpmRaw, minBpm, maxBpm);
  const fittedBpm = normalizeDnbBpm(fitted.bpm, minBpm, maxBpm)?.bpm ?? fitted.bpm;
  const bpmRaw = fittedBpm;
  const { offsetMs: bestOffset, score: onGrid } = bestOffsetForBpm(onset, hopMs, fittedBpm);
  const rivals = [fittedBpm * 1.07, fittedBpm / 1.07, fittedBpm * 1.12, fittedBpm / 1.12];
  let rivalBest = 0;
  for (const rival of rivals) {
    rivalBest = Math.max(rivalBest, scoreTempoGrid(onset, hopMs, rival, bestOffset));
  }
  const tempoConf = clamp((onGrid - rivalBest) / (onGrid + 1e-9), 0, 1);
  const peakOnset = onset.reduce((m, v) => Math.max(m, v), 0);
  const onGridRatio = clamp(onGrid / (peakOnset + 1e-9), 0, 1);
  const confidence = clamp(logistic3(prominence, stability, tempoConf), 0, 1);
  return {
    bpmRaw,
    confidence,
    stability,
    offsetMs: bestOffset,
    tempoEvidence: {
      prominence: Number(prominence.toFixed(4)),
      stability: Number(stability.toFixed(4)),
      tempoConf: Number(tempoConf.toFixed(4)),
      onGridRatio: Number(onGridRatio.toFixed(4)),
    },
  };
}

function wrapOffsetMs(offsetMs: number, periodMs: number): number {
  if (periodMs <= 0) {
    return 0;
  }
  const wrapped = offsetMs % periodMs;
  return wrapped < 0 ? wrapped + periodMs : wrapped;
}

function scoreReferenceTempo(
  onset: number[],
  hopMs: number,
  referenceBpm: number,
): {
  offsetMs: number;
  confidence: number;
  tempoEvidence: {
    prominence: number;
    stability: number;
    tempoConf: number;
    onGridRatio: number;
  };
} {
  const { offsetMs, score: onGrid } = bestOffsetForBpm(onset, hopMs, referenceBpm);
  const rivals = [referenceBpm * 1.07, referenceBpm / 1.07, referenceBpm * 1.12, referenceBpm / 1.12];
  let rivalBest = 0;
  for (const rival of rivals) {
    rivalBest = Math.max(rivalBest, scoreTempoGrid(onset, hopMs, rival, offsetMs));
  }
  const tempoConf = clamp((onGrid - rivalBest) / (onGrid + 1e-9), 0, 1);
  const peakOnset = onset.reduce((max, value) => Math.max(max, value), 0);
  const onGridRatio = clamp(onGrid / (peakOnset + 1e-9), 0, 1);
  const periodMs = 60_000 / referenceBpm;
  const window = Math.max(Math.round(16_000 / hopMs), 64);
  const ratios: number[] = [];
  for (let start = 0; start + window < onset.length; start += Math.floor(window / 2)) {
    const slice = onset.slice(start, start + window);
    const adj = wrapOffsetMs(offsetMs - start * hopMs, periodMs);
    const score = scoreTempoGrid(slice, hopMs, referenceBpm, adj);
    const peak = slice.reduce((max, value) => Math.max(max, value), 0);
    ratios.push(clamp(score / (peak + 1e-9), 0, 1));
  }
  const stability = ratios.length === 0 ? 0.45 : clamp(mean(ratios), 0, 1);
  const prominence = clamp(0.65 * onGridRatio + 0.35 * tempoConf, 0, 1);
  const confidence = clamp(logistic3(prominence, stability, tempoConf), 0, 1);
  return {
    offsetMs,
    confidence,
    tempoEvidence: {
      prominence: Number(prominence.toFixed(4)),
      stability: Number(stability.toFixed(4)),
      tempoConf: Number(tempoConf.toFixed(4)),
      onGridRatio: Number(onGridRatio.toFixed(4)),
    },
  };
}

function trackBeats(
  onset: number[],
  hopMs: number,
  bpm: number,
  offsetMs: number,
  durationMs: number,
): number[] {
  const periodMs = 60_000 / bpm;
  const snapThresh = 0.15 * periodMs;
  const times: number[] = [];
  let t = offsetMs;
  if (t > 0 && t >= periodMs) {
    t -= periodMs * Math.floor(t / periodMs);
  }
  while (t < 0) {
    t += periodMs;
  }
  while (t < durationMs) {
    const frame = clamp(Math.round(t / hopMs), 0, Math.max(0, onset.length - 1));
    const interpolated = interpolatePeak(onset, frame) * hopMs;
    times.push(Math.abs(interpolated - t) <= snapThresh ? interpolated : t);
    t += periodMs;
  }
  return times;
}

function downbeatPhase(
  beats: number[],
  low: number[],
  mid: number[],
  hopMs: number,
  dropMs: number | null,
  beatAnchorMs: number | null,
): { downbeats: number[]; confidence: number } {
  if (beats.length < 8) {
    return { downbeats: beats.filter((_, i) => i % 4 === 0), confidence: 0.3 };
  }
  const sampleAt = (ms: number, series: number[]): number => {
    const start = Math.round((ms - hopMs) / hopMs);
    const end = Math.round((ms + hopMs * 2) / hopMs);
    let peak = 0;
    for (let idx = start; idx <= end; idx += 1) {
      peak = Math.max(peak, series[clamp(idx, 0, series.length - 1)] ?? 0);
    }
    return peak;
  };
  let bestPhase = 0;
  let bestScore = -Infinity;
  const scores: number[] = [];
  for (let phase = 0; phase < 4; phase += 1) {
    let score = 0;
    for (let i = 0; i < beats.length; i += 1) {
      const t = beats[i]!;
      const pos = (i - phase + 4) % 4;
      const lowV = sampleAt(t, low);
      const midV = sampleAt(t, mid);
      if (pos === 0) {
        score += lowV;
      } else if (pos === 1 || pos === 3) {
        score += 0.5 * midV;
      } else {
        score += 0.35 * midV - 0.35 * lowV;
      }
    }
    if (dropMs !== null) {
      const nearest = beats.reduce(
        (best, t, i) =>
          Math.abs(t - dropMs) < Math.abs(beats[best]! - dropMs) ? i : best,
        0,
      );
      if (Math.abs((beats[nearest] ?? 0) - dropMs) < 600 && (nearest - phase + 4) % 4 === 0) {
        score *= 1.08;
      }
    }
    if (beatAnchorMs !== null) {
      const nearest = beats.reduce(
        (best, t, i) =>
          Math.abs(t - beatAnchorMs) < Math.abs(beats[best]! - beatAnchorMs) ? i : best,
        0,
      );
      if ((nearest - phase + 4) % 4 === 0) {
        score *= 1.35;
      }
    }
    scores.push(score);
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  const sorted = [...scores].sort((a, b) => b - a);
  const threshold = (sorted[0] ?? 0) / 1.25;
  const firstDownbeat = (phase: number): number =>
    beats.find((_, i) => (i - phase + 4) % 4 === 0) ?? beats[0] ?? 0;
  const close = scores
    .map((score, phase) => ({ score, phase }))
    .filter((item) => item.score >= threshold);
  close.sort((a, b) => firstDownbeat(a.phase) - firstDownbeat(b.phase) || b.score - a.score);
  const chosen = close[0]?.phase ?? bestPhase;
  const confidence = clamp(1 - (sorted[1] ?? 0) / ((sorted[0] ?? 1) + 1e-9), 0, 1);
  return {
    downbeats: beats.filter((_, i) => (i - chosen + 4) % 4 === 0),
    confidence,
  };
}

type BarFeatures = {
  startMs: number;
  rms: number;
  sub: number;
  midFlux: number;
  highRatio: number;
};

function featureVec(bar: BarFeatures): number[] {
  return [bar.rms, bar.sub, bar.midFlux, bar.highRatio];
}

function meanVec(bars: BarFeatures[]): number[] {
  if (bars.length === 0) {
    return [0, 0, 0, 0];
  }
  const acc = [0, 0, 0, 0];
  for (const bar of bars) {
    const v = featureVec(bar);
    for (let i = 0; i < 4; i += 1) {
      acc[i] = (acc[i] ?? 0) + (v[i] ?? 0);
    }
  }
  return acc.map((v) => v / bars.length);
}

function l1(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  return sum;
}

function rms(samples: Float32Array, start: number, end: number): number {
  let sum = 0;
  const last = Math.min(end, samples.length);
  const first = Math.max(0, start);
  const n = Math.max(1, last - first);
  for (let i = first; i < last; i += 1) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

const SILENCE_LINEAR = 10 ** (-50 / 20);
const SILENCE_FRAME_MS = 50;
const SILENCE_MIN_RUN_MS = 500;

function detectAudioBounds(
  samples: Float32Array,
  sampleRateHz: number,
  durationMs: number,
): { audioStartMs: number; audioEndMs: number } {
  const frameSamples = Math.max(1, Math.round((sampleRateHz * SILENCE_FRAME_MS) / 1000));
  const nFrames = Math.floor(samples.length / frameSamples);
  if (nFrames === 0) {
    return { audioStartMs: 0, audioEndMs: Math.round(durationMs) };
  }
  const silent: boolean[] = [];
  for (let i = 0; i < nFrames; i += 1) {
    const start = i * frameSamples;
    const end = Math.min(start + frameSamples, samples.length);
    let sum = 0;
    let peak = 0;
    for (let s = start; s < end; s += 1) {
      const v = samples[s] ?? 0;
      const a = Math.abs(v);
      sum += v * v;
      if (a > peak) {
        peak = a;
      }
    }
    const frameRms = Math.sqrt(sum / Math.max(1, end - start));
    silent.push(frameRms < SILENCE_LINEAR && peak < 1e-6);
  }
  const minFrames = Math.ceil(SILENCE_MIN_RUN_MS / SILENCE_FRAME_MS);
  const frameMs = (frameSamples / sampleRateHz) * 1000;
  let lead = 0;
  while (lead < silent.length && silent[lead]) {
    lead += 1;
  }
  let trail = 0;
  while (trail < silent.length && silent[silent.length - 1 - trail]) {
    trail += 1;
  }
  const audioStartMs = lead >= minFrames ? Math.round(lead * frameMs) : 0;
  const audioEndMs =
    trail >= minFrames
      ? Math.round((silent.length - trail) * frameMs)
      : Math.round(durationMs);
  return {
    audioStartMs,
    audioEndMs: Math.max(audioStartMs, Math.min(audioEndMs, Math.round(durationMs))),
  };
}

function waveformSummary(samples: Float32Array, buckets = 128): number[] {
  const out: number[] = [];
  const size = Math.max(1, Math.floor(samples.length / buckets));
  for (let i = 0; i < buckets; i += 1) {
    let peak = 0;
    const start = i * size;
    const end = i === buckets - 1 ? samples.length : start + size;
    for (let j = start; j < end; j += 1) {
      peak = Math.max(peak, Math.abs(samples[j] ?? 0));
    }
    out.push(Number(peak.toFixed(4)));
  }
  return out;
}

function bandMagEnergy(mag: number[][], fromBin: number, toBin: number): number[] {
  return mag.map((frame) => {
    let sum = 0;
    for (let k = fromBin; k < toBin; k += 1) {
      const v = frame[k] ?? 0;
      sum += v * v;
    }
    return sum;
  });
}

function detectDropMs(low: number[], hopMs: number, durationMs: number): number | null {
  if (low.length < 16) {
    return null;
  }
  const win = Math.max(8, Math.round(1000 / hopMs));
  let best = 0;
  let bestJump = 0;
  for (let i = win; i + win < low.length; i += 1) {
    const before = mean(low.slice(i - win, i));
    const after = mean(low.slice(i, i + win));
    const jump = after - before;
    if (jump > bestJump) {
      bestJump = jump;
      best = i;
    }
  }
  const t = best * hopMs;
  if (t < durationMs * 0.08 || t > durationMs * 0.85) {
    return null;
  }
  return t;
}

function labelSections(
  bars: BarFeatures[],
  durationMs: number,
  dropHintMs: number | null,
  introStartMs: number,
): TrackSection[] {
  if (bars.length === 0) {
    return [
      {
        type: "intro",
        startMs: 0,
        endMs: durationMs,
        startBar: 0,
        endBar: 0,
        confidence: 0.2,
        sectionEnergy: 0.5,
      },
    ];
  }
  const novelty = new Array<number>(bars.length + 1).fill(0);
  for (let i = 4; i <= bars.length - 4; i += 1) {
    const left = meanVec(bars.slice(i - 4, i));
    const right = meanVec(bars.slice(i, i + 4));
    let d = l1(left, right);
    if (i % 8 === 0) {
      d *= 1.2;
    }
    if (i % 16 === 0) {
      d *= 1.15;
    }
    novelty[i] = d;
  }
  const grid = novelty.filter((_, i) => i % 4 === 0 && i >= 8 && i <= bars.length - 8);
  const thresh = mean(grid) + 0.35 * stddev(grid);
  const cuts: number[] = [0];
  let lastCut = 0;
  for (let i = 8; i <= bars.length - 8; i += 4) {
    if (i - lastCut < 8) {
      continue;
    }
    const n = novelty[i] ?? 0;
    const prev = novelty[i - 4] ?? 0;
    const next = novelty[i + 4] ?? 0;
    const isPeak = n >= prev && n >= next;
    const subLeft = mean(bars.slice(i - 4, i).map((b) => b.sub));
    const subRight = mean(bars.slice(i, Math.min(i + 4, bars.length)).map((b) => b.sub));
    const rmsLeft = mean(bars.slice(i - 4, i).map((b) => b.rms));
    const rmsRight = mean(bars.slice(i, Math.min(i + 4, bars.length)).map((b) => b.rms));
    const relSub = Math.abs(subRight - subLeft) / (subLeft + subRight + 1e-9);
    const relRms = Math.abs(rmsRight - rmsLeft) / (rmsLeft + rmsRight + 1e-9);
    const energyCut = (relSub > 0.35 || relRms > 0.22) && (isPeak || i % 8 === 0);
    if ((n >= thresh && isPeak) || energyCut) {
      cuts.push(i);
      lastCut = i;
    }
  }
  if (cuts[cuts.length - 1] !== bars.length) {
    cuts.push(bars.length);
  }
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const start = cuts[i]!;
    const end = cuts[i + 1]!;
    if (end > start) {
      ranges.push({ start, end });
    }
  }

  const stats = ranges.map((range) => ({
    ...range,
    rms: mean(bars.slice(range.start, range.end).map((b) => b.rms)),
    sub: mean(bars.slice(range.start, range.end).map((b) => b.sub)),
    startMs: bars[range.start]?.startMs ?? 0,
  }));

  let dropIdx = 0;
  let bestDrop = -Infinity;
  for (let i = 1; i < stats.length; i += 1) {
    const prev = stats[i - 1]!;
    const here = stats[i]!;
    const rise = here.sub - prev.sub + (here.rms - prev.rms);
    const dropBias =
      dropHintMs !== null ? 1 - Math.min(1, Math.abs(here.startMs - dropHintMs) / 8000) : 0;
    const score = rise + dropBias;
    if (score > bestDrop) {
      bestDrop = score;
      dropIdx = i;
    }
  }
  const dropSub = stats[dropIdx]?.sub ?? 0;
  const dropRms = stats[dropIdx]?.rms ?? 0;
  const laterDropIdx = stats.reduce((best, item, i) => {
    if (i <= dropIdx) {
      return best;
    }
    if (item.sub >= dropSub * 0.85 && item.rms >= dropRms * 0.8) {
      return i;
    }
    return best;
  }, -1);

  const types: TrackSection["type"][] = stats.map((_, i) => {
    if (i === 0) {
      return "intro";
    }
    if (i === dropIdx || i === laterDropIdx) {
      return "drop";
    }
    if (i < dropIdx) {
      return "build";
    }
    if (i === laterDropIdx) {
      return "drop";
    }
    if (i > dropIdx && laterDropIdx > dropIdx && i < laterDropIdx) {
      const here = stats[i]!;
      if (here.sub < dropSub * 0.6) {
        return "breakdown";
      }
      if (here.rms > (stats[i - 1]?.rms ?? 0)) {
        return "build";
      }
      return "bridge";
    }
    const here = stats[i]!;
    if (here.sub < dropSub * 0.6) {
      return "breakdown";
    }
    if (here.rms > (stats[i - 1]?.rms ?? 0) && laterDropIdx > i) {
      return "build";
    }
    return "bridge";
  });
  const last = types.length - 1;
  if (last >= 0) {
    const lastRms = stats[last]?.rms ?? 0;
    if (lastRms < dropRms * 0.7 && types[last] !== "drop") {
      types[last] = "outro";
    } else if (types[last] === "outro") {
      types[last] = "drop";
    }
  }

  const noveltyMax = Math.max(...novelty, 1e-9);
  const noveltyMean = mean(novelty);
  const raw: TrackSection[] = ranges.map((range, i) => {
    const startMs = i === 0 ? introStartMs : (bars[range.start]?.startMs ?? 0);
    const lastBar = bars[Math.min(range.end, bars.length) - 1];
    const barLen = (bars[1]?.startMs ?? 0) - (bars[0]?.startMs ?? 0);
    const endMs = lastBar ? lastBar.startMs + barLen : durationMs;
    const energy = stats[i]?.rms ?? 0;
    const n = novelty[range.start] ?? 0;
    const margin = (n - noveltyMean) / (noveltyMax - noveltyMean + 1e-9);
    return {
      type: types[i] ?? "build",
      startMs: Math.round(startMs),
      endMs: Math.round(Math.min(durationMs, endMs)),
      startBar: range.start,
      endBar: range.end,
      confidence: Number(clamp(0.3 + 0.65 * clamp(margin, 0, 1), 0.3, 0.95).toFixed(3)),
      sectionEnergy: Number(clamp(energy, 0, 1).toFixed(3)),
    };
  });
  if (raw.length > 0) {
    raw[raw.length - 1]!.endMs = Math.round(durationMs);
  }
  const merged: TrackSection[] = [];
  for (const section of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === section.type) {
      prev.endMs = section.endMs;
      prev.endBar = section.endBar;
      prev.sectionEnergy = Number(
        clamp((prev.sectionEnergy + section.sectionEnergy) / 2, 0, 1).toFixed(3),
      );
      prev.confidence = Math.max(prev.confidence, section.confidence);
    } else {
      merged.push({ ...section });
    }
  }
  if (!merged.some((s) => s.type === "drop") && merged.length > 1) {
    merged[Math.min(1, merged.length - 1)]!.type = "drop";
  }
  if (merged.length > 1 && (merged[merged.length - 1]?.sectionEnergy ?? 1) < 0.02) {
    merged.pop();
  }
  return merged;
}

function cuesFromSections(sections: TrackSection[]): AnalyzerCue[] {
  const cues: AnalyzerCue[] = [];
  const intro = sections.find((s) => s.type === "intro");
  const drop = sections.find((s) => s.type === "drop");
  const breakdownAfterDrop = sections.find(
    (s) => s.type === "breakdown" && (drop == null || s.startMs >= drop.endMs - 1),
  );
  const outro = sections.find((s) => s.type === "outro");
  if (intro) {
    cues.push({ type: "intro_start", positionMs: intro.startMs, confidence: intro.confidence });
  }
  if (drop) {
    cues.push({ type: "drop", positionMs: drop.startMs, confidence: drop.confidence });
  }
  if (breakdownAfterDrop) {
    cues.push({
      type: "breakdown",
      positionMs: breakdownAfterDrop.startMs,
      confidence: breakdownAfterDrop.confidence,
    });
  }
  if (outro) {
    cues.push({ type: "outro_start", positionMs: outro.startMs, confidence: outro.confidence });
  }
  return cues;
}

export const dspAnalyzer: AudioAnalyzer = {
  name: DSP_ANALYZER_NAME,
  version: DSP_ANALYZER_VERSION,
  analyze(pcm: PcmAudio, options: AnalyzeOptions = {}): AnalyzerResult {
    const started = Date.now();
    const minBpm = options.dnbBpmMin ?? DNB_BPM_MIN;
    const maxBpm = options.dnbBpmMax ?? DNB_BPM_MAX;
    const fileDurationMs = options.durationMs ?? pcm.durationMs;
    const bounds = detectAudioBounds(pcm.samples, pcm.sampleRateHz, fileDurationMs);
    const durationMs = bounds.audioEndMs;
    const stft = stftMagnitude(pcm.samples, pcm.sampleRateHz, NFFT, HOP);
    const { onset, low, mid } = onsetStrength(stft.mag, pcm.sampleRateHz, NFFT);
    const hopMs = stft.hopMs;
    const subEnergy = bandMagEnergy(stft.mag, 1, hzToBin(120, pcm.sampleRateHz, NFFT));
    const tempoHop = 128;
    const tempoOnset = timeDomainOnset(pcm.samples, tempoHop);
    const tempoHopMs = (tempoHop / pcm.sampleRateHz) * 1000;
    const estimated = estimateTempo(tempoOnset, tempoHopMs, minBpm, maxBpm);
    const bpmRaw = estimated?.bpmRaw ?? null;
    const folded = bpmRaw === null ? null : normalizeDnbBpm(bpmRaw, minBpm, maxBpm);
    let bpmConfidence = Number((estimated?.confidence ?? 0).toFixed(3));
    let gridRejected = false;
    let gridRejectionReason: string | null = null;
    let bpm: number | null = folded?.bpm ?? null;
    let gridSource: "analyzed" | "reference" | "anchor" = "analyzed";
    let gridOffsetMs = estimated?.offsetMs ?? 0;
    let tempoEvidence = estimated?.tempoEvidence ?? null;
    if (!folded || bpmRaw === null) {
      gridRejected = true;
      gridRejectionReason = "No plausible DnB tempo (160–190 after half/double fold)";
      bpm = null;
    } else if (bpmConfidence < MIN_ANALYSIS_CONFIDENCE) {
      gridRejected = true;
      gridRejectionReason = `Beat-grid confidence ${bpmConfidence} is below ${MIN_ANALYSIS_CONFIDENCE}`;
    }
    const referenceBpm = options.referenceBpm;
    const disagrees =
      referenceBpm != null && bpm != null && Math.abs(bpm - referenceBpm) > 0.5;
    if (referenceBpm != null && referenceBpm > 0 && (gridRejected || disagrees)) {
      const ref = scoreReferenceTempo(tempoOnset, tempoHopMs, referenceBpm);
      const refConf = Number(ref.confidence.toFixed(3));
      if (refConf >= MIN_ANALYSIS_CONFIDENCE) {
        bpm = referenceBpm;
        bpmConfidence = refConf;
        gridOffsetMs = ref.offsetMs;
        gridRejected = false;
        gridRejectionReason = null;
        gridSource = "reference";
        tempoEvidence = ref.tempoEvidence;
      } else {
        gridRejected = true;
        gridRejectionReason = `Reference tempo ${referenceBpm} does not fit onsets (confidence ${refConf.toFixed(2)})`;
        bpm = null;
      }
    }

    let beatTimesMs: number[] = [];
    let downbeatTimesMs: number[] = [];
    let downbeatConfidence: number | null = null;
    const dropHint = detectDropMs(subEnergy, hopMs, durationMs);
    if (bpm !== null && !gridRejected) {
      beatTimesMs = trackBeats(
        tempoOnset,
        tempoHopMs,
        bpm,
        gridOffsetMs,
        durationMs,
      );
      const down = downbeatPhase(
        beatTimesMs,
        low,
        mid,
        hopMs,
        dropHint,
        options.beatAnchorMs ?? null,
      );
      downbeatTimesMs = down.downbeats;
      downbeatConfidence = Number(down.confidence.toFixed(3));
    }

    const key = estimateKeyFromChroma(stft.mag, pcm.sampleRateHz, NFFT);
    const nyquist = pcm.sampleRateHz / 2;
    const lowE = bandEnergyTime(pcm.samples, pcm.sampleRateHz, 0, 80);
    const midE = bandEnergyTime(pcm.samples, pcm.sampleRateHz, 80, 4000);
    const highE = bandEnergyTime(pcm.samples, pcm.sampleRateHz, 4000, nyquist);
    const totalE = lowE + midE + highE + 1e-9;
    const wave = waveformSummary(pcm.samples);
    const highEnergy = bandMagEnergy(
      stft.mag,
      hzToBin(4000, pcm.sampleRateHz, NFFT),
      NFFT / 2,
    );
    const barMs = bpm ? (4 * 60_000) / bpm : 2000;
    const gridStart = downbeatTimesMs[0] ?? 0;
    const bars: BarFeatures[] = [];
    for (let t = gridStart; t < durationMs; t += barMs) {
      const start = Math.round((t / 1000) * pcm.sampleRateHz);
      const end = Math.round(((t + barMs) / 1000) * pcm.sampleRateHz);
      const e = rms(pcm.samples, start, end);
      const frame = Math.round(t / hopMs);
      const frameEnd = Math.round((t + barMs) / hopMs);
      const lo = clamp(frame, 0, Math.max(0, subEnergy.length - 1));
      const hi = clamp(frameEnd, lo + 1, subEnergy.length);
      const sub = mean(subEnergy.slice(lo, hi));
      const midFlux = mean(mid.slice(lo, Math.min(hi, mid.length)));
      const high = mean(highEnergy.slice(lo, Math.min(hi, highEnergy.length)));
      const highRatio = high / (sub + high + 1e-9);
      bars.push({ startMs: t, rms: e, sub, midFlux, highRatio });
    }
    const sections = labelSections(bars, durationMs, dropHint, 0);
    const cues = cuesFromSections(sections).map((cue) => ({
      ...cue,
      positionMs: snapToNearestBeat(cue.positionMs, beatTimesMs)?.positionMs ?? cue.positionMs,
    }));

    const rmsAll = rms(pcm.samples, 0, pcm.samples.length);
    const peak = wave.reduce((m, v) => Math.max(m, v), 0);
    const drop = sections.find((s) => s.type === "drop");
    const intro = sections.find((s) => s.type === "intro");
    const dropIntensity =
      drop && intro ? clamp((drop.sectionEnergy - intro.sectionEnergy + 1) / 2, 0, 1) : 0.5;
    const onsetDensity = onset.length === 0 ? 0 : onset.filter((v) => v > mean(onset)).length / onset.length;
    const suggestedEnergy = clamp(
      Math.round(1 + 9 * (0.45 * dropIntensity + 0.3 * onsetDensity + 0.25 * clamp(rmsAll * 4, 0, 1))),
      1,
      10,
    );

    return {
      analyzerName: DSP_ANALYZER_NAME,
      analyzerVersion: DSP_ANALYZER_VERSION,
      bpm,
      bpmConfidence,
      bpmRaw,
      beatTimesMs,
      downbeatTimesMs,
      gridRejected,
      gridRejectionReason,
      gridSource,
      musicalKey: key.musicalKey,
      keyConfidence: key.keyConfidence,
      keyMode: key.keyMode,
      camelotKey: key.camelotKey,
      keyRunnerUp: key.keyRunnerUp,
      tempoStability: estimated ? Number(estimated.stability.toFixed(3)) : null,
      downbeatConfidence,
      lowBandEnergy: Number((lowE / totalE).toFixed(4)),
      midBandEnergy: Number((midE / totalE).toFixed(4)),
      highBandEnergy: Number((highE / totalE).toFixed(4)),
      waveformSummary: wave,
      suggestedCues: cues,
      sections,
      descriptors: {
        ...emptyDescriptors(wave),
        subBassRatio: Number((lowE / totalE).toFixed(4)),
        brightness: Number((highE / totalE).toFixed(4)),
        onsetDensity: Number(onsetDensity.toFixed(4)),
        dynamicRange: peak > 0 ? Number((20 * Math.log10((peak + 1e-9) / (rmsAll + 1e-9))).toFixed(3)) : null,
        dropIntensity: Number(dropIntensity.toFixed(3)),
        suggestedEnergy,
        lowBandEnergy: Number((lowE / totalE).toFixed(4)),
        midBandEnergy: Number((midE / totalE).toFixed(4)),
        highBandEnergy: Number((highE / totalE).toFixed(4)),
        chromaVector: key.chromaVector,
        tempoEvidence,
        audioStartMs: bounds.audioStartMs,
        audioEndMs: bounds.audioEndMs,
      },
      engineRuntimeMs: Date.now() - started,
    };
  },
};

function bandEnergyTime(samples: Float32Array, sampleRateHz: number, loHz: number, hiHz: number): number {
  const rcLo = loHz > 0 ? 1 / (2 * Math.PI * loHz) : 0;
  const rcHi = hiHz > 0 ? 1 / (2 * Math.PI * hiHz) : 0;
  const dt = 1 / sampleRateHz;
  const aLo = rcLo === 0 ? 1 : dt / (rcLo + dt);
  const aHi = rcHi === 0 ? 1 : dt / (rcHi + dt);
  let lp = 0;
  let hp = 0;
  let prev = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const x = samples[i] ?? 0;
    lp += aLo * (x - lp);
    hp = aHi * (hp + x - prev);
    prev = x;
    const y = hiHz >= sampleRateHz / 2 ? x - lp : lp - (loHz <= 0 ? 0 : hp);
    sum += y * y;
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}
