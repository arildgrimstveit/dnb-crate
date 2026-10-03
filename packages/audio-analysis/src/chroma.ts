import { normalizeKey } from "@dnb-crate/domain";

const KRUMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KRUMHANSL_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const TEMPERLEY_MAJOR = [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0];
const TEMPERLEY_MINOR = [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0];
const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/** A3-ish: kick 2nd harmonics (~110 Hz) sit below this and alias into neighbouring pitch classes. */
const CHROMA_LOW_HZ = 165;
const CHROMA_HIGH_HZ = 3520;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length);
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function hzToBin(hz: number, sampleRateHz: number, nfft: number): number {
  return Math.max(1, Math.min(nfft / 2 - 1, Math.round((hz * nfft) / sampleRateHz)));
}

function magAtBin(frame: ArrayLike<number>, bin: number): number {
  const i0 = Math.floor(bin);
  const frac = bin - i0;
  if (i0 < 0 || i0 >= frame.length) {
    return 0;
  }
  if (i0 + 1 >= frame.length) {
    return frame[i0] ?? 0;
  }
  return (frame[i0] ?? 0) * (1 - frac) + (frame[i0 + 1] ?? 0) * frac;
}

function interpolateBin(frame: ArrayLike<number>, index: number): number {
  const a = frame[index - 1] ?? 0;
  const b = frame[index] ?? 0;
  const c = frame[index + 1] ?? 0;
  const denom = a - 2 * b + c;
  const delta = Math.abs(denom) < 1e-12 ? 0 : clamp((0.5 * (a - c)) / denom, -0.75, 0.75);
  return index + delta;
}

function entropy(values: number[]): number {
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0) + 1e-12;
  let h = 0;
  for (const v of values) {
    const p = Math.max(0, v) / total;
    if (p > 0) {
      h -= p * Math.log(p);
    }
  }
  return h;
}

function pearson(left: number[], right: number[]): number {
  const n = Math.min(left.length, right.length);
  if (n === 0) {
    return 0;
  }
  const lMean = mean(left.slice(0, n));
  const rMean = mean(right.slice(0, n));
  const lStd = stddev(left.slice(0, n)) || 1;
  const rStd = stddev(right.slice(0, n)) || 1;
  let corr = 0;
  for (let i = 0; i < n; i += 1) {
    corr += (((left[i] ?? 0) - lMean) / lStd) * (((right[i] ?? 0) - rMean) / rStd);
  }
  return corr;
}

function ranks(scores: number[]): number[] {
  const indexed = scores.map((score, index) => ({ score, index }));
  indexed.sort((a, b) => b.score - a.score);
  const out = new Array<number>(scores.length).fill(scores.length);
  indexed.forEach((item, rank) => {
    out[item.index] = rank + 1;
  });
  return out;
}

export type ChromaKeyEstimate = {
  musicalKey: string | null;
  camelotKey: string | null;
  keyMode: "major" | "minor" | null;
  keyConfidence: number | null;
  keyRunnerUp: string | null;
  chromaVector: number[];
  chromaClarity: number;
  tonalStability: number;
  tonalPeakRatio: number;
  strongPeakRatio: number;
  majorness: number;
  modeConfidence: number;
};

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) + 1e-12);
}

function addToChroma(chroma: number[], hz: number, weight: number, tuningShift: number): void {
  const midi = 12 * Math.log2(hz / 440) + 69 - tuningShift;
  const wrapped = ((midi % 12) + 12) % 12;
  const lo = Math.floor(wrapped);
  const frac = wrapped - lo;
  const hi = (lo + 1) % 12;
  chroma[lo] = (chroma[lo] ?? 0) + weight * (1 - frac);
  chroma[hi] = (chroma[hi] ?? 0) + weight * frac;
}

export type SubPitchVote = { pc: number; weight: number };

/** Sub-band (35–110 Hz) dominant pitch class vote for one STFT frame. */
export function subPitchVoteOfFrame(
  frame: ArrayLike<number>,
  sampleRateHz: number,
  nfft: number,
): SubPitchVote | null {
  const lo = hzToBin(35, sampleRateHz, nfft);
  const hi = hzToBin(110, sampleRateHz, nfft);
  let best = 0;
  let bestK = lo;
  for (let k = lo; k <= hi && k < frame.length; k += 1) {
    const value = frame[k] ?? 0;
    if (value > best) {
      best = value;
      bestK = k;
    }
  }
  if (best <= 1e-9) {
    return null;
  }
  const hz = (bestK * sampleRateHz) / nfft;
  const pc = Math.round(12 * Math.log2(hz / 440)) % 12;
  const wrapped = ((pc % 12) + 12) % 12;
  return { pc: wrapped, weight: best };
}

/** Dominant sub-band pitch class over a frame range of per-frame votes. */
export function dominantSubPitchClassFromVotes(
  votes: Array<SubPitchVote | null>,
  frameStart = 0,
  frameEnd = votes.length,
): number | null {
  const votesByPc = new Array<number>(12).fill(0);
  const end = Math.min(votes.length, Math.max(frameStart + 1, frameEnd));
  for (let t = Math.max(0, frameStart); t < end; t += 1) {
    const vote = votes[t];
    if (vote) {
      votesByPc[vote.pc] = (votesByPc[vote.pc] ?? 0) + vote.weight;
    }
  }
  let bestPc = 0;
  let bestVote = 0;
  for (let i = 0; i < 12; i += 1) {
    if ((votesByPc[i] ?? 0) > bestVote) {
      bestVote = votesByPc[i] ?? 0;
      bestPc = i;
    }
  }
  return bestVote > 0 ? bestPc : null;
}

/** Per-frame data retained from one streaming STFT pass: spectral peaks with
 * precomputed half/third-fraction magnitudes (used later for harmonic
 * suppression), per-frame peak energy for the quiet-frame cutoff, the tuning
 * histogram, and spectral-flatness accumulators. Memory is a handful of values
 * per frame instead of the full frames×bins magnitude matrix. */
export type ChromaFrames = {
  /** Per frame: flat quadruples `[hz, power, halfMag, thirdMag]` per peak. */
  peaks: Float64Array[];
  frameEnergy: number[];
  tuningHist: number[];
  flatLogSum: number;
  flatLinSum: number;
  flatCount: number;
  bandPowerSum: number;
  peakPowerSum: number;
};

export function createChromaFrames(): ChromaFrames {
  return {
    peaks: [],
    frameEnergy: [],
    tuningHist: new Array<number>(100).fill(0),
    flatLogSum: 0,
    flatLinSum: 0,
    flatCount: 0,
    bandPowerSum: 0,
    peakPowerSum: 0,
  };
}

/** Collect one STFT frame's chroma evidence. `frame` is a reused streaming
 * buffer; everything needed later is copied out here. */
export function collectChromaFrame(
  frames: ChromaFrames,
  frame: ArrayLike<number>,
  sampleRateHz: number,
  nfft: number,
): void {
  const minBin = hzToBin(CHROMA_LOW_HZ, sampleRateHz, nfft);
  const maxBin = hzToBin(CHROMA_HIGH_HZ, sampleRateHz, nfft);
  const centsBins = 100;
  const peaks: number[] = [];
  let energy = 0;
  let frameBand = 0;
  let frameMax = 0;
  for (let k = minBin; k <= maxBin && k < frame.length; k += 1) {
    const magK = frame[k] ?? 0;
    frameBand += magK * magK;
    if (magK > frameMax) {
      frameMax = magK;
    }
  }
  const floor = Math.max(1e-9, frameMax * 0.02);
  for (let k = minBin; k <= maxBin && k < frame.length; k += 1) {
    const magK = frame[k] ?? 0;
    if (magK < floor) {
      continue;
    }
    frames.flatLogSum += Math.log(magK);
    frames.flatLinSum += magK;
    frames.flatCount += 1;
  }
  frames.bandPowerSum += frameBand;
  for (let k = minBin + 1; k < maxBin - 1 && k < frame.length - 1; k += 1) {
    const cur = frame[k] ?? 0;
    if (cur < (frame[k - 1] ?? 0) || cur < (frame[k + 1] ?? 0) || cur <= 0) {
      continue;
    }
    const bin = interpolateBin(frame, k);
    const hz = (bin * sampleRateHz) / nfft;
    if (hz < CHROMA_LOW_HZ || hz > CHROMA_HIGH_HZ) {
      continue;
    }
    const compressed = Math.log1p(cur * 8);
    const power = cur * cur;
    const half = magAtBin(frame, (hz * 0.5 * nfft) / sampleRateHz);
    const third = magAtBin(frame, ((hz / 3) * nfft) / sampleRateHz);
    peaks.push(hz, power, half, third);
    energy += power;
    frames.peakPowerSum += power;
    const midi = 12 * Math.log2(hz / 440) + 69;
    const frac = ((midi % 1) + 1) % 1;
    const histBin = Math.min(centsBins - 1, Math.floor(frac * centsBins));
    frames.tuningHist[histBin] = (frames.tuningHist[histBin] ?? 0) + compressed;
  }
  frames.peaks.push(Float64Array.from(peaks));
  frames.frameEnergy.push(energy);
}

/** HPCP-style chroma key estimate: 165–3520 Hz, spectral peaks, tuning,
 * harmonic suppression — over frames collected by `collectChromaFrame`. */
export function estimateKeyFromChroma(
  frames: ChromaFrames,
  options: { subRootPc?: number | null } = {},
): ChromaKeyEstimate {
  const tuningHist = frames.tuningHist;
  const frameEnergy = frames.frameEnergy;
  const peakFrames = frames.peaks;

  let peakBin = 0;
  let peakVal = -Infinity;
  for (let i = 0; i < tuningHist.length; i += 1) {
    if ((tuningHist[i] ?? 0) > peakVal) {
      peakVal = tuningHist[i] ?? 0;
      peakBin = i;
    }
  }
  const peakFrac = peakBin / tuningHist.length;
  const tuningShift = peakFrac > 0.5 ? peakFrac - 1 : peakFrac;

  const cutoff = [...frameEnergy].sort((a, b) => a - b)[Math.floor(frameEnergy.length * 0.2)] ?? 0;
  const frameChromas: number[][] = [];
  for (let t = 0; t < peakFrames.length; t += 1) {
    if ((frameEnergy[t] ?? 0) <= cutoff && peakFrames.length > 5) {
      continue;
    }
    const chroma = new Array<number>(12).fill(0);
    const peaks = peakFrames[t]!;
    for (let p = 0; p + 3 < peaks.length; p += 4) {
      const hz = peaks[p]!;
      const power = peaks[p + 1]!;
      const half = peaks[p + 2]!;
      const third = peaks[p + 3]!;
      const contrib = Math.max(0, power - 0.5 * half * half - 0.5 * third * third);
      if (contrib <= 0) {
        continue;
      }
      addToChroma(chroma, hz, contrib, tuningShift);
    }
    const l1 = chroma.reduce((sum, v) => sum + v, 0);
    if (l1 > 1e-9) {
      frameChromas.push(chroma.map((v) => v / l1));
    }
  }

  const chromaVector =
    frameChromas.length === 0
      ? new Array<number>(12).fill(1 / 12)
      : Array.from({ length: 12 }, (_, pc) => median(frameChromas.map((row) => row[pc] ?? 0)));
  const chromaL1 = chromaVector.reduce((sum, v) => sum + v, 0) || 1;
  const chroma = chromaVector.map((v) => v / chromaL1);

  type Candidate = { key: string; mode: "major" | "minor"; kk: number; temperley: number };
  const candidates: Candidate[] = [];
  for (let tonic = 0; tonic < 12; tonic += 1) {
    const rotated = (profile: number[]) =>
      Array.from({ length: 12 }, (_, i) => chroma[(i + tonic) % 12] ?? 0).map(
        (v, i) => [v, profile[i] ?? 0] as const,
      );
    for (const [kkProfile, tempProfile, mode] of [
      [KRUMHANSL_MAJOR, TEMPERLEY_MAJOR, "major"] as const,
      [KRUMHANSL_MINOR, TEMPERLEY_MINOR, "minor"] as const,
    ]) {
      const kkPairs = rotated(kkProfile);
      const tempPairs = rotated(tempProfile);
      const kk = pearson(
        kkPairs.map((p) => p[0]),
        kkPairs.map((p) => p[1]),
      );
      const temperley = pearson(
        tempPairs.map((p) => p[0]),
        tempPairs.map((p) => p[1]),
      );
      const name = PITCH_NAMES[tonic]!;
      const musicalKey = mode === "minor" ? `${name}m` : name;
      candidates.push({ key: musicalKey, mode, kk, temperley });
    }
  }

  const kkRanks = ranks(candidates.map((c) => c.kk));
  const tempRanks = ranks(candidates.map((c) => c.temperley));
  const scored = candidates.map((candidate, index) => ({
    ...candidate,
    rankScore: -((kkRanks[index] ?? 24) + (tempRanks[index] ?? 24)) / 2,
    raw: (candidate.kk + candidate.temperley) / 2,
  }));
  if (options.subRootPc != null) {
    for (const row of scored) {
      const tonic = PITCH_NAMES.findIndex((name) => row.key === name || row.key === `${name}m`);
      if (tonic === options.subRootPc) {
        row.raw += 0.06;
        row.rankScore += 0.06;
      }
    }
  }
  scored.sort((a, b) => b.rankScore - a.rankScore || b.raw - a.raw);
  const best = scored[0];
  const second = scored[1];
  const chromaClarity = clamp(1 - entropy(chroma) / Math.log(12), 0, 1);
  let stabilitySum = 0;
  let stabilityCount = 0;
  for (let i = 1; i < frameChromas.length; i += 1) {
    stabilitySum += cosineSimilarity(frameChromas[i - 1]!, frameChromas[i]!);
    stabilityCount += 1;
  }
  const tonalStability = stabilityCount === 0 ? 0 : clamp(stabilitySum / stabilityCount, 0, 1);
  const tonalPeakRatio = clamp(frames.peakPowerSum / (frames.bandPowerSum + 1e-12), 0, 1);
  const flatness =
    frames.flatCount === 0
      ? 1
      : Math.exp(frames.flatLogSum / frames.flatCount) /
        (frames.flatLinSum / frames.flatCount + 1e-12);
  const strongPeakRatio = clamp(1 - flatness, 0, 1);
  const bestMajor = scored.find((row) => row.mode === "major");
  const bestMinor = scored.find((row) => row.mode === "minor");
  const modeMargin = (bestMajor?.raw ?? 0) - (bestMinor?.raw ?? 0);
  const majorness = clamp(0.5 + modeMargin / 0.8, 0, 1);
  const modeConfidence = clamp(
    Math.abs(modeMargin) / (Math.abs(bestMajor?.raw ?? 0) + Math.abs(bestMinor?.raw ?? 0) + 1e-9),
    0,
    1,
  );
  const empty = {
    musicalKey: null,
    camelotKey: null,
    keyMode: null,
    keyConfidence: 0,
    keyRunnerUp: second?.key ?? null,
    chromaVector: chroma.map((v) => Number(v.toFixed(4))),
    chromaClarity: Number(chromaClarity.toFixed(4)),
    tonalStability: Number(tonalStability.toFixed(4)),
    tonalPeakRatio: Number(tonalPeakRatio.toFixed(4)),
    strongPeakRatio: Number(strongPeakRatio.toFixed(4)),
    majorness: Number(majorness.toFixed(4)),
    modeConfidence: Number(modeConfidence.toFixed(4)),
  };
  if (!best || best.raw <= 0) {
    return empty;
  }
  const normalized = normalizeKey(best.key);
  const raws = scored.map((row) => row.raw);
  const spread = stddev(raws) || 1e-6;
  const marginZ = (best.raw - (second?.raw ?? 0)) / spread;
  const logistic = clamp(1 / (1 + Math.exp(-(marginZ - 0.2) * 3.4)), 0, 1);
  const clarityGate = chromaClarity < 0.45 ? chromaClarity * 0.08 : chromaClarity;
  return {
    musicalKey: normalized?.musicalKey ?? best.key,
    camelotKey: normalized?.camelotKey ?? null,
    keyMode: best.mode,
    keyConfidence: Number((logistic * clarityGate).toFixed(3)),
    keyRunnerUp: second?.key ?? null,
    chromaVector: chroma.map((v) => Number(v.toFixed(4))),
    chromaClarity: Number(chromaClarity.toFixed(4)),
    tonalStability: Number(tonalStability.toFixed(4)),
    tonalPeakRatio: Number(tonalPeakRatio.toFixed(4)),
    strongPeakRatio: Number(strongPeakRatio.toFixed(4)),
    majorness: Number(majorness.toFixed(4)),
    modeConfidence: Number(modeConfidence.toFixed(4)),
  };
}
