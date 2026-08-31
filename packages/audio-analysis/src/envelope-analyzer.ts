import {
  ANALYZER_NAME,
  ANALYZER_VERSION,
  DNB_BPM_MAX,
  DNB_BPM_MIN,
  MIN_ANALYSIS_CONFIDENCE,
  normalizeDnbBpm,
  reconstructGrid,
  snapToNearestBeat,
  barIndexForBeat,
} from "@dnb-crate/domain";

import { estimateKeyFromPitch } from "./key.ts";
import type {
  AnalyzeOptions,
  AnalyzerCue,
  AnalyzerResult,
  AudioAnalyzer,
  PcmAudio,
} from "./types.ts";

function hopSize(sampleRateHz: number): number {
  return Math.max(32, Math.round(sampleRateHz * 0.005));
}

function onsetEnvelope(samples: Float32Array, hop: number): number[] {
  const env: number[] = [];
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let peak = 0;
    for (let j = 0; j < hop; j += 1) {
      const v = Math.abs(samples[i + j] ?? 0);
      if (v > peak) {
        peak = v;
      }
    }
    env.push(peak);
  }
  return env;
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

function lagsRelated(a: number, b: number): boolean {
  const ratio = a > b ? a / b : b / a;
  return Math.abs(ratio - 1) < 0.08 || Math.abs(ratio - 2) < 0.12 || Math.abs(ratio - 3) < 0.12;
}

function estimateBpm(
  env: number[],
  hopMs: number,
  minBpm: number,
  maxBpm: number,
): { bpmRaw: number; score: number; second: number } | null {
  const minLag = Math.max(2, Math.round(60_000 / (maxBpm * 2) / hopMs));
  const maxLag = Math.min(env.length - 2, Math.round(60_000 / (minBpm / 2) / hopMs));
  if (maxLag <= minLag) {
    return null;
  }
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    scores.push(autocorr(env, lag));
  }
  const peaks: Array<{ lag: number; score: number }> = [];
  for (let i = 1; i < scores.length - 1; i += 1) {
    const prev = scores[i - 1] ?? 0;
    const cur = scores[i] ?? 0;
    const next = scores[i + 1] ?? 0;
    if (cur >= prev && cur >= next && cur > 0) {
      peaks.push({ lag: minLag + i, score: cur });
    }
  }
  peaks.sort((a, b) => b.score - a.score);
  const best = peaks[0];
  if (!best) {
    return null;
  }
  const second = peaks.find((peak) => !lagsRelated(peak.lag, best.lag))?.score ?? best.score * 0.4;
  return { bpmRaw: 60_000 / (best.lag * hopMs), score: best.score, second };
}

function bandEnergy(
  samples: Float32Array,
  sampleRateHz: number,
  lowHz: number,
  highHz: number,
): number {
  const hop = hopSize(sampleRateHz);
  let energy = 0;
  let prev = 0;
  const rcHigh = highHz > 0 ? 1 / (2 * Math.PI * highHz) : 0;
  const rcLow = lowHz > 0 ? 1 / (2 * Math.PI * lowHz) : 0;
  const dt = 1 / sampleRateHz;
  const alphaHigh = rcHigh === 0 ? 1 : dt / (rcHigh + dt);
  const alphaLow = rcLow === 0 ? 0 : dt / (rcLow + dt);
  let lp = 0;
  let hp = 0;
  for (let i = 0; i < samples.length; i += hop) {
    const x = samples[i] ?? 0;
    lp += alphaLow * (x - lp);
    hp += alphaHigh * (x - prev - hp);
    prev = x;
    const y = highHz >= sampleRateHz / 2 ? x - lp : hp - (lowHz <= 0 ? 0 : lp);
    energy += y * y;
  }
  return Math.sqrt(energy / Math.max(1, Math.floor(samples.length / hop)));
}

function waveformSummary(samples: Float32Array, buckets = 128): number[] {
  const out: number[] = [];
  const size = Math.max(1, Math.floor(samples.length / buckets));
  for (let b = 0; b < buckets; b += 1) {
    let peak = 0;
    const start = b * size;
    const end = Math.min(samples.length, start + size);
    for (let i = start; i < end; i += 1) {
      peak = Math.max(peak, Math.abs(samples[i] ?? 0));
    }
    out.push(Number(peak.toFixed(4)));
  }
  return out;
}

function suggestCues(
  env: number[],
  hopMs: number,
  beats: number[],
  durationMs: number,
): AnalyzerCue[] {
  if (env.length === 0) {
    return [];
  }
  const bar = Math.max(
    1,
    Math.round(4 * (beats[1] && beats[0] !== undefined ? (beats[1] - beats[0]) / hopMs : 8)),
  );
  const windowEnergy: number[] = [];
  for (let i = 0; i < env.length; i += bar) {
    let sum = 0;
    let n = 0;
    for (let j = 0; j < bar && i + j < env.length; j += 1) {
      sum += env[i + j] ?? 0;
      n += 1;
    }
    windowEnergy.push(n === 0 ? 0 : sum / n);
  }
  const mean = windowEnergy.reduce((a, b) => a + b, 0) / Math.max(1, windowEnergy.length);
  let dropBucket = 0;
  let bestJump = 0;
  for (let i = 1; i < windowEnergy.length; i += 1) {
    const jump = (windowEnergy[i] ?? 0) - (windowEnergy[i - 1] ?? 0);
    if (jump > bestJump) {
      bestJump = jump;
      dropBucket = i;
    }
  }
  const dropMs = Math.min(durationMs - 1, dropBucket * bar * hopMs);
  const outroBucket = windowEnergy.reduce(
    (best, value, index) =>
      index > dropBucket && value < (windowEnergy[best] ?? value) ? index : best,
    Math.max(dropBucket, windowEnergy.length - 2),
  );
  const snap = (ms: number) => snapToNearestBeat(ms, beats)?.positionMs ?? Math.round(ms);
  const dropConf = mean > 0 ? Math.min(1, bestJump / (mean * 2 + 1e-6)) : 0.2;
  return [
    { type: "intro_start", positionMs: snap(0), confidence: 0.7 },
    { type: "drop", positionMs: snap(dropMs), confidence: Number(dropConf.toFixed(3)) },
    {
      type: "outro_start",
      positionMs: snap(Math.min(durationMs - 1, outroBucket * bar * hopMs)),
      confidence: 0.45,
    },
    { type: "outro_end", positionMs: snap(durationMs - hopMs), confidence: 0.6 },
  ];
}

export const envelopeAnalyzer: AudioAnalyzer = {
  name: ANALYZER_NAME,
  version: ANALYZER_VERSION,
  analyze(pcm: PcmAudio, options: AnalyzeOptions = {}): AnalyzerResult {
    const minBpm = options.dnbBpmMin ?? DNB_BPM_MIN;
    const maxBpm = options.dnbBpmMax ?? DNB_BPM_MAX;
    const durationMs = options.durationMs ?? pcm.durationMs;
    const hop = hopSize(pcm.sampleRateHz);
    const hopMs = (hop / pcm.sampleRateHz) * 1000;
    const env = onsetEnvelope(pcm.samples, hop);
    const estimated = estimateBpm(env, hopMs, minBpm, maxBpm);
    const bpmRaw = estimated?.bpmRaw ?? null;
    const folded = bpmRaw === null ? null : normalizeDnbBpm(bpmRaw, minBpm, maxBpm);
    const prominence =
      estimated && estimated.score > 0 ? 1 - estimated.second / (estimated.score + 1e-9) : 0;
    const bpmConfidence = Number(Math.max(0, Math.min(1, prominence)).toFixed(3));
    let gridRejected = false;
    let gridRejectionReason: string | null = null;
    let bpm: number | null = folded?.bpm ?? null;
    if (!folded || bpmRaw === null) {
      gridRejected = true;
      gridRejectionReason = "No plausible DnB tempo (160–190 after half/double fold)";
      bpm = null;
    } else if (bpmConfidence < MIN_ANALYSIS_CONFIDENCE) {
      gridRejected = true;
      gridRejectionReason = `Beat-grid confidence ${bpmConfidence} is below ${MIN_ANALYSIS_CONFIDENCE}`;
    }

    let beatTimesMs: number[] = [];
    let downbeatTimesMs: number[] = [];
    if (bpm !== null && !gridRejected) {
      const anchor = options.beatAnchorMs ?? 0;
      const grid = reconstructGrid(anchor, bpm, durationMs);
      beatTimesMs = grid.beatTimesMs;
      downbeatTimesMs = grid.downbeatTimesMs;
    }

    const suggestedCues =
      beatTimesMs.length > 0 ? suggestCues(env, hopMs, beatTimesMs, durationMs) : [];
    const cuesWithBars: AnalyzerCue[] = suggestedCues.map((cue) => {
      const snapped = snapToNearestBeat(cue.positionMs, beatTimesMs);
      return {
        ...cue,
        positionMs: snapped?.positionMs ?? cue.positionMs,
      };
    });

    const key = estimateKeyFromPitch(pcm.samples, pcm.sampleRateHz);

    return {
      analyzerName: ANALYZER_NAME,
      analyzerVersion: ANALYZER_VERSION,
      bpm,
      bpmConfidence,
      bpmRaw,
      beatTimesMs,
      downbeatTimesMs,
      gridRejected,
      gridRejectionReason,
      musicalKey: key.musicalKey,
      keyConfidence: key.keyConfidence,
      lowBandEnergy: bandEnergy(pcm.samples, pcm.sampleRateHz, 0, 200),
      midBandEnergy: bandEnergy(pcm.samples, pcm.sampleRateHz, 200, 4000),
      highBandEnergy: bandEnergy(pcm.samples, pcm.sampleRateHz, 4000, pcm.sampleRateHz / 2),
      waveformSummary: waveformSummary(pcm.samples),
      suggestedCues: cuesWithBars,
    };
  },
};

export function attachBarIndices(
  cues: AnalyzerCue[],
  beatTimesMs: number[],
): Array<AnalyzerCue & { beatIndex: number | null; barIndex: number | null }> {
  return cues.map((cue) => {
    const snapped = snapToNearestBeat(cue.positionMs, beatTimesMs);
    return {
      ...cue,
      beatIndex: snapped?.beatIndex ?? null,
      barIndex: snapped ? barIndexForBeat(snapped.beatIndex) : null,
    };
  });
}
