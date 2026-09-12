import { RENDER_CHECK_AUDIO_CONFIDENT_MS, RENDER_CHECK_AUDIO_REVIEW_MS } from "@dnb-crate/domain";

export type DiagnosticConfidence = "high" | "low" | "insufficient";
export type DiagnosticStatus = "pass" | "review" | "fail" | "advisory" | "unmeasured";
export type MixIntent = "sustain" | "lift" | "breather" | null;
export type OverlapRegion = "start" | "middle" | "end";

export type RegionGridFit = {
  region: OverlapRegion;
  onsetCount: number;
  residualMs: number | null;
  confidence: DiagnosticConfidence;
};

export type DeckAudioDiagnostic = {
  regions: RegionGridFit[];
  crestFactor: number;
  clippedFraction: number;
  transientHarshness: number;
};

export type MixAudioDiagnostic = {
  holeMs: number | null;
  bassAbsence: "expected-breather" | "accidental" | "none" | "unmeasured";
  discontinuityStart: number;
  discontinuityEnd: number;
  stutterScore: number;
  lowBandCrest: number;
  clippedFraction: number;
  incomingEnergyAtEnd: number;
  outgoingEnergyAtStart: number;
};

export type OverlapAudioDiagnostic = {
  measured: true;
  outgoing: DeckAudioDiagnostic;
  incoming: DeckAudioDiagnostic;
  mix: MixAudioDiagnostic;
  worstDeckResidualMs: number | null;
  status: DiagnosticStatus;
  reasons: string[];
};

const HOP_MS = 10;
const CLIP = 0.99;
const HOLE_DB = -28;
const HOLE_MIN_MS = 400;

export function clickTrack(options: {
  sampleRate: number;
  durationMs: number;
  bpm: number;
  offsetMs?: number;
  amplitude?: number;
  clickMs?: number;
}): Float32Array {
  const samples = Math.max(1, Math.round((options.durationMs / 1000) * options.sampleRate));
  const pcm = new Float32Array(samples);
  const periodMs = 60_000 / options.bpm;
  const clickSamples = Math.max(
    1,
    Math.round(((options.clickMs ?? 4) / 1000) * options.sampleRate),
  );
  const amp = options.amplitude ?? 0.8;
  const offset = options.offsetMs ?? 0;
  for (let t = offset; t < options.durationMs; t += periodMs) {
    const start = Math.round((t / 1000) * options.sampleRate);
    for (let i = 0; i < clickSamples && start + i < samples; i += 1) {
      pcm[start + i] = amp * (1 - i / clickSamples);
    }
  }
  return pcm;
}

export function mixPcm(a: Float32Array, b: Float32Array, gainA = 1, gainB = 1): Float32Array {
  const out = new Float32Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (a[i] ?? 0) * gainA + (b[i] ?? 0) * gainB;
  }
  return out;
}

export function fadePcm(
  pcm: Float32Array,
  sampleRate: number,
  from: number,
  to: number,
): Float32Array {
  const out = pcm.slice();
  for (let i = 0; i < out.length; i += 1) {
    const t = i / (out.length - 1 || 1);
    const g = from + (to - from) * t;
    out[i] = (out[i] ?? 0) * g;
  }
  void sampleRate;
  return out;
}

export function insertSilence(
  pcm: Float32Array,
  sampleRate: number,
  atMs: number,
  durationMs: number,
): Float32Array {
  const start = Math.round((atMs / 1000) * sampleRate);
  const count = Math.round((durationMs / 1000) * sampleRate);
  const out = pcm.slice();
  for (let i = 0; i < count && start + i < out.length; i += 1) {
    out[start + i] = 0;
  }
  return out;
}

export function clipPcm(pcm: Float32Array, threshold = 0.3): Float32Array {
  const out = pcm.slice();
  for (let i = 0; i < out.length; i += 1) {
    const sample = out[i] ?? 0;
    out[i] = Math.max(-threshold, Math.min(threshold, sample)) / threshold;
  }
  return out;
}

export function expectedBeatsMs(durationMs: number, bpm: number, offsetMs = 0): number[] {
  const period = 60_000 / bpm;
  const beats: number[] = [];
  for (let t = offsetMs; t < durationMs; t += period) {
    beats.push(t);
  }
  return beats;
}

export function onsetTimesMs(pcm: Float32Array, sampleRate: number, hopMs = HOP_MS): number[] {
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));
  const flux: number[] = [];
  let prev = 0;
  for (let i = 0; i + hop <= pcm.length; i += hop) {
    let energy = 0;
    for (let j = 0; j < hop; j += 1) {
      const sample = pcm[i + j] ?? 0;
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / hop);
    flux.push(Math.max(0, rms - prev));
    prev = rms;
  }
  const peak = Math.max(...flux, 1e-9);
  const threshold = peak * 0.35;
  const times: number[] = [];
  for (let i = 1; i < flux.length - 1; i += 1) {
    if (
      (flux[i] ?? 0) >= threshold &&
      (flux[i] ?? 0) >= (flux[i - 1] ?? 0) &&
      (flux[i] ?? 0) > (flux[i + 1] ?? 0)
    ) {
      times.push(i * hopMs);
    }
  }
  return times;
}

export function gridFitResidualMs(
  onsetsMs: number[],
  expectedMs: number[],
  window: { startMs: number; endMs: number },
): { residualMs: number | null; onsetCount: number; confidence: DiagnosticConfidence } {
  const expected = expectedMs.filter((time) => time >= window.startMs && time < window.endMs);
  const onsets = onsetsMs.filter((time) => time >= window.startMs && time < window.endMs);
  if (expected.length < 3 || onsets.length < 2) {
    return { residualMs: null, onsetCount: onsets.length, confidence: "insufficient" };
  }
  const nearest: number[] = [];
  for (const beat of expected) {
    let best = Number.POSITIVE_INFINITY;
    for (const onset of onsets) {
      best = Math.min(best, Math.abs(onset - beat));
    }
    if (Number.isFinite(best)) {
      nearest.push(best);
    }
  }
  const residual = nearest.length >= 3 ? median(nearest) : null;
  const matched = nearest.filter((error) => error <= RENDER_CHECK_AUDIO_REVIEW_MS).length;
  const confidence: DiagnosticConfidence =
    residual == null
      ? "insufficient"
      : matched / nearest.length >= 0.7
        ? "high"
        : matched / nearest.length >= 0.4
          ? "low"
          : "insufficient";
  return { residualMs: residual, onsetCount: onsets.length, confidence };
}

export function firstEnergyMs(
  pcm: Float32Array,
  sampleRate: number,
  hopMs = HOP_MS,
): number | null {
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));
  const rms = rmsEnvelope(pcm, hop);
  const peak = Math.max(...rms, 1e-9);
  const threshold = peak * 0.2;
  for (let i = 0; i < rms.length; i += 1) {
    if ((rms[i] ?? 0) >= threshold) {
      return i * hopMs;
    }
  }
  return null;
}

export function diagnoseRenderedMix(input: {
  sampleRate: number;
  mixPcm: Float32Array;
  overlapMs: number;
  intent?: MixIntent;
}): OverlapAudioDiagnostic {
  return diagnoseOverlapAudio({
    sampleRate: input.sampleRate,
    outgoingPcm: input.mixPcm,
    incomingPcm: input.mixPcm,
    mixPcm: input.mixPcm,
    overlapMs: input.overlapMs,
    outgoingBeatsMs: [],
    incomingBeatsMs: [],
    intent: input.intent,
  });
}

export function diagnoseOverlapAudio(input: {
  sampleRate: number;
  outgoingPcm: Float32Array;
  incomingPcm: Float32Array;
  mixPcm?: Float32Array;
  overlapMs: number;
  outgoingBeatsMs: number[];
  incomingBeatsMs: number[];
  intent?: MixIntent;
}): OverlapAudioDiagnostic {
  const mix = input.mixPcm ?? mixPcm(input.outgoingPcm, input.incomingPcm);
  const outgoing = diagnoseDeck(
    input.outgoingPcm,
    input.sampleRate,
    input.outgoingBeatsMs,
    input.overlapMs,
  );
  const incoming = diagnoseDeck(
    input.incomingPcm,
    input.sampleRate,
    input.incomingBeatsMs,
    input.overlapMs,
  );
  const mixDiag = diagnoseMix(
    mix,
    input.outgoingPcm,
    input.incomingPcm,
    input.sampleRate,
    input.overlapMs,
    input.intent ?? null,
  );
  const incomingOrigin = originErrorMs(input.incomingPcm, input.sampleRate, input.incomingBeatsMs);
  const outgoingOrigin = originErrorMs(input.outgoingPcm, input.sampleRate, input.outgoingBeatsMs);
  const residuals = [...outgoing.regions, ...incoming.regions]
    .filter((region) => region.confidence !== "insufficient" && region.residualMs != null)
    .map((region) => Math.abs(region.residualMs!));
  if (incomingOrigin != null) {
    residuals.push(Math.abs(incomingOrigin));
  }
  if (outgoingOrigin != null) {
    residuals.push(Math.abs(outgoingOrigin));
  }
  const worst = residuals.length > 0 ? Math.max(...residuals) : null;
  const reasons: string[] = [];
  let status: DiagnosticStatus = "pass";
  if (worst != null && worst > RENDER_CHECK_AUDIO_CONFIDENT_MS) {
    status = worst > 80 ? "fail" : "review";
    reasons.push(`deck-grid residual ${worst.toFixed(0)} ms`);
  }
  if (mixDiag.stutterScore >= 0.65) {
    status = "fail";
    reasons.push("prefix skip/stutter");
  }
  if (mixDiag.clippedFraction > 0.008) {
    status = status === "fail" ? "fail" : "review";
    reasons.push("bass/transient distortion");
  }
  if (mixDiag.bassAbsence === "accidental") {
    status = status === "fail" ? "fail" : "review";
    reasons.push(`overlap hole ${mixDiag.holeMs ?? 0} ms`);
  }
  if (mixDiag.discontinuityStart > 0.55 || mixDiag.discontinuityEnd > 0.55) {
    if (status === "pass") {
      status = "review";
    }
    reasons.push("boundary discontinuity");
  }
  const confident = [...outgoing.regions, ...incoming.regions].some(
    (region) => region.confidence === "high",
  );
  if (!confident && status === "pass") {
    status = "advisory";
    reasons.push("insufficient onsets for independent grid fit");
  }
  return {
    measured: true,
    outgoing,
    incoming,
    mix: mixDiag,
    worstDeckResidualMs: worst,
    status,
    reasons,
  };
}

function diagnoseDeck(
  pcm: Float32Array,
  sampleRate: number,
  expectedMs: number[],
  overlapMs: number,
): DeckAudioDiagnostic {
  const onsets = onsetTimesMs(pcm, sampleRate);
  const third = overlapMs / 3;
  const regions: OverlapRegion[] = ["start", "middle", "end"];
  return {
    regions: regions.map((region, index) => {
      const startMs = index * third;
      const fit = gridFitResidualMs(onsets, expectedMs, { startMs, endMs: startMs + third });
      return { region, ...fit };
    }),
    crestFactor: crest(pcm),
    clippedFraction: clipped(pcm),
    transientHarshness: harshness(pcm, sampleRate, onsets),
  };
}

function diagnoseMix(
  mix: Float32Array,
  outgoing: Float32Array,
  incoming: Float32Array,
  sampleRate: number,
  _overlapMs: number,
  intent: MixIntent,
): MixAudioDiagnostic {
  const hop = Math.max(1, Math.round((HOP_MS / 1000) * sampleRate));
  const mixRms = rmsEnvelope(mix, hop);
  const outRms = rmsEnvelope(outgoing, hop);
  const inRms = rmsEnvelope(incoming, hop);
  const holeMs = longestHoleMs(mixRms, HOP_MS);
  const sustained = isSustained(mixRms);
  const startJump = sustained ? hopJump(mixRms, 0, Math.round(250 / HOP_MS)) : 0;
  const endJump = sustained
    ? hopJump(mixRms, Math.max(0, mixRms.length - Math.round(250 / HOP_MS)), mixRms.length - 1)
    : 0;
  const stutterScore = prefixStutterScore(mix, sampleRate);
  const low = lowpass(mix, sampleRate, 180);
  const bassAbsence =
    holeMs != null && holeMs >= HOLE_MIN_MS
      ? intent === "breather"
        ? "expected-breather"
        : "accidental"
      : holeMs == null
        ? "none"
        : "none";
  return {
    holeMs,
    bassAbsence,
    discontinuityStart: startJump,
    discontinuityEnd: endJump,
    stutterScore,
    lowBandCrest: crest(low),
    clippedFraction: clipped(mix),
    incomingEnergyAtEnd: meanTail(inRms, 0.2),
    outgoingEnergyAtStart: meanHead(outRms, 0.2),
  };
}

function rmsEnvelope(pcm: Float32Array, hop: number): number[] {
  const values: number[] = [];
  for (let i = 0; i + hop <= pcm.length; i += hop) {
    let energy = 0;
    for (let j = 0; j < hop; j += 1) {
      const sample = pcm[i + j] ?? 0;
      energy += sample * sample;
    }
    values.push(Math.sqrt(energy / hop));
  }
  return values;
}

function longestHoleMs(rms: number[], hopMs: number): number | null {
  if (rms.length < 8) {
    return null;
  }
  const peak = Math.max(...rms, 1e-9);
  const floor = peak * Math.pow(10, HOLE_DB / 20);
  let best = 0;
  let run = 0;
  const innerStart = Math.round(rms.length * 0.15);
  const innerEnd = Math.round(rms.length * 0.85);
  for (let i = innerStart; i < innerEnd; i += 1) {
    if ((rms[i] ?? 0) < floor) {
      run += hopMs;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }
  return best >= HOLE_MIN_MS ? best : null;
}

function hopJump(rms: number[], left: number, right: number): number {
  const a = rms[Math.max(0, Math.min(rms.length - 1, left))] ?? 0;
  const b = rms[Math.max(0, Math.min(rms.length - 1, right))] ?? 0;
  const denom = Math.max(a, b, 1e-6);
  return Math.abs(a - b) / denom;
}

function prefixStutterScore(pcm: Float32Array, sampleRate: number): number {
  const prefixMs = Math.min(2000, (pcm.length / sampleRate) * 1000 * 0.25);
  const prefix = pcm.subarray(0, Math.max(1, Math.round((prefixMs / 1000) * sampleRate)));
  const hop = Math.max(1, Math.round((HOP_MS / 1000) * sampleRate));
  const rms = rmsEnvelope(prefix, hop);
  if (rms.length < 8 || !isSustained(rms)) {
    return 0;
  }
  const peak = Math.max(...rms, 1e-9);
  let hole = 0;
  let bestHole = 0;
  let restart = 0;
  for (let i = 1; i < rms.length; i += 1) {
    if ((rms[i] ?? 0) < peak * 0.05) {
      hole += HOP_MS;
      bestHole = Math.max(bestHole, hole);
    } else {
      if (hole >= 30 && hole <= 180) {
        restart = Math.max(restart, (rms[i] ?? 0) / peak);
      }
      hole = 0;
    }
  }
  return bestHole >= 30 && bestHole <= 180 ? Math.min(1, 0.45 + restart * 0.55) : 0;
}

function originErrorMs(pcm: Float32Array, sampleRate: number, expectedMs: number[]): number | null {
  const firstExpected = expectedMs[0];
  if (firstExpected == null) {
    return null;
  }
  const early = expectedMs.slice(0, 3);
  const energies = early.map((time) => energyAt(pcm, sampleRate, time));
  const peak = Math.max(...energies, 0);
  if (peak < 1e-5) {
    const firstEnergy = firstEnergyMs(pcm, sampleRate);
    return firstEnergy == null ? null : firstEnergy - firstExpected;
  }
  const firstLoud = energies.findIndex((value) => value >= peak * 0.35);
  if (firstLoud <= 0) {
    return 0;
  }
  return (early[firstLoud] ?? firstExpected) - firstExpected;
}

function energyAt(pcm: Float32Array, sampleRate: number, timeMs: number, windowMs = 20): number {
  const start = Math.max(0, Math.round(((timeMs - windowMs / 2) / 1000) * sampleRate));
  const count = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  let energy = 0;
  for (let i = 0; i < count && start + i < pcm.length; i += 1) {
    const sample = pcm[start + i] ?? 0;
    energy += sample * sample;
  }
  return Math.sqrt(energy / count);
}

function isSustained(rms: number[]): boolean {
  const sorted = rms.slice().sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const peak = sorted[sorted.length - 1] ?? 0;
  return mid > peak * 0.12 && mid > 0.02;
}

function lowpass(pcm: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  const out = new Float32Array(pcm.length);
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const alpha = dt / (rc + dt);
  let prev = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    prev = prev + alpha * ((pcm[i] ?? 0) - prev);
    out[i] = prev;
  }
  return out;
}

function crest(pcm: Float32Array): number {
  let peak = 0;
  let energy = 0;
  for (const sample of pcm) {
    peak = Math.max(peak, Math.abs(sample));
    energy += sample * sample;
  }
  const rms = Math.sqrt(energy / Math.max(1, pcm.length));
  return rms > 1e-9 ? peak / rms : 0;
}

function clipped(pcm: Float32Array): number {
  let count = 0;
  for (const sample of pcm) {
    if (Math.abs(sample) >= CLIP) {
      count += 1;
    }
  }
  return count / Math.max(1, pcm.length);
}

function harshness(pcm: Float32Array, sampleRate: number, onsetsMs: number[]): number {
  if (onsetsMs.length === 0) {
    return 0;
  }
  const window = Math.round(0.008 * sampleRate);
  let sum = 0;
  for (const time of onsetsMs.slice(0, 12)) {
    const start = Math.round((time / 1000) * sampleRate);
    let energy = 0;
    for (let i = 0; i < window && start + i < pcm.length; i += 1) {
      const delta = (pcm[start + i] ?? 0) - (pcm[start + i - 1] ?? 0);
      energy += delta * delta;
    }
    sum += energy;
  }
  return sum / onsetsMs.slice(0, 12).length;
}

function meanHead(values: number[], fraction: number): number {
  const n = Math.max(1, Math.round(values.length * fraction));
  return values.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
}

function meanTail(values: number[], fraction: number): number {
  const n = Math.max(1, Math.round(values.length * fraction));
  return values.slice(-n).reduce((sum, value) => sum + value, 0) / n;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}
