import {
  CROSSFADE_CURVE,
  PHRASE_MIX_HIGHPASS_HZ,
  clampBassSwapParams,
  type BassSwapParams,
} from "@dnb-crate/domain";

export type FilterTrim = {
  startSec: number;
  endSec: number;
  gainDb: number;
  playbackRate?: number;
};

export type MixTransitionKind = "crossfade" | "phrase_mix" | "bass_swap";

export type MixTransitionSpec = {
  type: MixTransitionKind;
  barCount?: 16 | 32;
  bassSwap?: Partial<BassSwapParams> | null;
};

export type FilterGraphOptions = {
  trims: FilterTrim[];
  overlapSeconds: number[];
  limiterAmplitude: number;
  sampleRateHz: number;
  edgeFadeSeconds?: { fadeIn: number; fadeOut: number };
  transitions?: MixTransitionSpec[];
};

export function limiterAmplitudeFromCeilingDb(ceilingDb: number): number {
  return Number(Math.pow(10, ceilingDb / 20).toFixed(9));
}

export function outputDurationSec(trim: FilterTrim): number {
  const rate = trim.playbackRate !== undefined && trim.playbackRate > 0 ? trim.playbackRate : 1;
  return Math.max(0, trim.endSec - trim.startSec) / rate;
}

export function expectedDurationMs(trims: FilterTrim[], overlapSeconds: number[]): number {
  const playable = trims.reduce((sum, trim) => sum + outputDurationSec(trim), 0);
  const overlap = overlapSeconds.reduce((sum, item) => sum + item, 0);
  return Math.max(0, Math.round((playable - overlap) * 1000));
}

function atempoSuffix(rate: number | undefined): string {
  if (rate === undefined || Math.abs(rate - 1) < 1e-6) {
    return "";
  }
  return `,atempo=${rate.toFixed(6)}`;
}

function segmentPrep(index: number, trim: FilterTrim, sampleRateHz: number): string {
  const gain = Number.isFinite(trim.gainDb) ? trim.gainDb : 0;
  return `[${index}:a]aformat=sample_fmts=fltp:sample_rates=${sampleRateHz}:channel_layouts=stereo,atrim=start=${trim.startSec}:end=${trim.endSec},asetpts=PTS-STARTPTS,volume=${gain}dB${atempoSuffix(trim.playbackRate)}[s${index}]`;
}

function limiterChain(
  trims: FilterTrim[],
  overlapSeconds: number[],
  limiterAmplitude: number,
  edgeFadeSeconds?: { fadeIn: number; fadeOut: number },
): string {
  const post: string[] = [`alimiter=limit=${limiterAmplitude}:level=false:attack=5:release=50`];
  const fadeIn = edgeFadeSeconds?.fadeIn ?? 0;
  const fadeOut = edgeFadeSeconds?.fadeOut ?? 0;
  if (fadeIn > 0) {
    post.push(`afade=t=in:st=0:d=${fadeIn}`);
  }
  if (fadeOut > 0) {
    const durationSec = expectedDurationMs(trims, overlapSeconds) / 1000;
    post.push(`afade=t=out:st=${Math.max(0, durationSec - fadeOut)}:d=${fadeOut}`);
  }
  return post.join(",");
}

function assertGraphShape(trims: FilterTrim[], overlapSeconds: number[]): void {
  if (trims.length === 0) {
    throw new Error("Need at least one audio segment");
  }
  if (overlapSeconds.length !== Math.max(0, trims.length - 1)) {
    throw new Error("overlapSeconds length must be segmentCount - 1");
  }
}

/**
 * Equal-power acrossfade graph. Paths stay on `-i` inputs; the filter uses labels only.
 * Pitch-preserving tempo matching uses `atempo` (not `asetrate`).
 */
export function buildAcrossfadeFilter(options: FilterGraphOptions): string {
  const { trims, overlapSeconds, limiterAmplitude, sampleRateHz, edgeFadeSeconds } = options;
  assertGraphShape(trims, overlapSeconds);

  const parts: string[] = [];
  for (let i = 0; i < trims.length; i += 1) {
    parts.push(segmentPrep(i, trims[i]!, sampleRateHz));
  }

  let current = "s0";
  for (let i = 0; i < overlapSeconds.length; i += 1) {
    const overlap = overlapSeconds[i]!;
    const out = i === overlapSeconds.length - 1 ? "mixed" : `m${i + 1}`;
    parts.push(
      `[${current}][s${i + 1}]acrossfade=d=${overlap}:o=1:c1=${CROSSFADE_CURVE}:c2=${CROSSFADE_CURVE}[${out}]`,
    );
    current = out;
  }

  parts.push(
    `[${current}]${limiterChain(trims, overlapSeconds, limiterAmplitude, edgeFadeSeconds)}[out]`,
  );
  return parts.join(";");
}

/**
 * 16/32-bar phrase mix: outgoing fades out over the overlap; incoming mids/highs fade in
 * through a high-pass (~250 Hz) so the incoming sub stays out of the early overlap.
 */
export function buildPhraseMixFilter(options: FilterGraphOptions): string {
  const { trims, overlapSeconds, limiterAmplitude, sampleRateHz, edgeFadeSeconds } = options;
  assertGraphShape(trims, overlapSeconds);
  if (trims.length !== 2 || overlapSeconds.length !== 1) {
    throw new Error("phrase_mix graphs are pairwise (exactly two segments)");
  }
  const t0 = outputDurationSec(trims[0]!);
  const overlap = overlapSeconds[0]!;
  const delayMs = Math.max(0, Math.round((t0 - overlap) * 1000));
  const highpassHz = PHRASE_MIX_HIGHPASS_HZ;
  const incoming =
    delayMs > 0
      ? `[s1]highpass=f=${highpassHz},afade=t=in:st=0:d=${overlap},adelay=${delayMs}|${delayMs}[i]`
      : `[s1]highpass=f=${highpassHz},afade=t=in:st=0:d=${overlap}[i]`;
  const parts = [
    segmentPrep(0, trims[0]!, sampleRateHz),
    segmentPrep(1, trims[1]!, sampleRateHz),
    `[s0]afade=t=out:st=${Math.max(0, t0 - overlap)}:d=${overlap}[o]`,
    incoming,
    `[o][i]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[mixed]`,
    `[mixed]${limiterChain(trims, overlapSeconds, limiterAmplitude, edgeFadeSeconds)}[out]`,
  ];
  return parts.join(";");
}

/**
 * Bass swap: split each stream at a bounded crossover. Highs equal-power acrossfade.
 * Outgoing lows fade out at the swap bar; incoming lows fade in there. Both lows are
 * never at full strength through the overlap.
 */
export function buildBassSwapFilter(options: FilterGraphOptions): string {
  const { trims, overlapSeconds, limiterAmplitude, sampleRateHz, edgeFadeSeconds } = options;
  assertGraphShape(trims, overlapSeconds);
  if (trims.length !== 2 || overlapSeconds.length !== 1) {
    throw new Error("bass_swap graphs are pairwise (exactly two segments)");
  }
  const barCount = options.transitions?.[0]?.barCount === 32 ? 32 : 16;
  const bass = clampBassSwapParams(options.transitions?.[0]?.bassSwap, barCount);
  const t0 = outputDurationSec(trims[0]!);
  const overlap = overlapSeconds[0]!;
  const delayMs = Math.max(0, Math.round((t0 - overlap) * 1000));
  const swapTime = (bass.swapAtBar / barCount) * overlap;
  const rampSec = bass.rampMs / 1000;
  const outgoingSwap = Math.max(0, t0 - overlap + swapTime);
  const incomingDelay = delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : "";
  const parts = [
    segmentPrep(0, trims[0]!, sampleRateHz),
    segmentPrep(1, trims[1]!, sampleRateHz),
    `[s0]asplit=2[oSrcL][oSrcH]`,
    `[oSrcL]lowpass=f=${bass.crossoverHz}[oL]`,
    `[oSrcH]highpass=f=${bass.crossoverHz}[oH]`,
    `[s1]asplit=2[iSrcL][iSrcH]`,
    `[iSrcL]lowpass=f=${bass.crossoverHz}[iL]`,
    `[iSrcH]highpass=f=${bass.crossoverHz}[iH]`,
    `[oH][iH]acrossfade=d=${overlap}:o=1:c1=${CROSSFADE_CURVE}:c2=${CROSSFADE_CURVE}[hMix]`,
    `[oL]afade=t=out:st=${outgoingSwap}:d=${rampSec}[oLfade]`,
    `[iL]afade=t=in:st=${swapTime}:d=${rampSec}${incomingDelay}[iLfade]`,
    `[oLfade][iLfade]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[lMix]`,
    `[hMix][lMix]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[mixed]`,
    `[mixed]${limiterChain(trims, overlapSeconds, limiterAmplitude, edgeFadeSeconds)}[out]`,
  ];
  return parts.join(";");
}

export function buildMixFilter(options: FilterGraphOptions): string {
  const types =
    options.transitions ?? options.overlapSeconds.map(() => ({ type: "crossfade" as const }));
  if (options.trims.length === 2 && types[0]?.type === "phrase_mix") {
    return buildPhraseMixFilter(options);
  }
  if (options.trims.length === 2 && types[0]?.type === "bass_swap") {
    return buildBassSwapFilter(options);
  }
  return buildAcrossfadeFilter(options);
}

export function redactInvocation(executable: string, args: string[]): string {
  const tool = /ffprobe/i.test(executable) ? "ffprobe" : "ffmpeg";
  const redacted = args.map((arg) => {
    if (arg.startsWith("-")) {
      return arg;
    }
    if (/[\\/]/.test(arg) || /^[A-Za-z]:/.test(arg)) {
      return "[path]";
    }
    return arg;
  });
  return [tool, ...redacted].join(" ");
}

export function estimateArgvChars(args: string[]): number {
  return args.reduce((sum, arg) => sum + arg.length + 1, 0);
}
