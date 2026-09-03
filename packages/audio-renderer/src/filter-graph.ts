import {
  BAND_HIGH_CROSSOVER_HZ,
  CROSSFADE_CURVE,
  clampMixPresetParams,
  expandPreset,
  normalizePhraseBars,
  type AutomationEvent,
  type BassSwapParams,
  type MixPresetParams,
  type PhraseBarCount,
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
  barCount?: PhraseBarCount;
  bassSwap?: Partial<BassSwapParams> | null;
  params?: Partial<MixPresetParams> | null;
};

export type FilterGraphOptions = {
  trims: FilterTrim[];
  overlapSeconds: number[];
  limiterAmplitude: number;
  sampleRateHz: number;
  edgeFadeSeconds?: { fadeIn: number; fadeOut: number };
  transitions?: MixTransitionSpec[];
  hasAfadeUnity?: boolean;
  warnings?: string[];
  /** When false, skip the mix-wide alimiter (used for intermediate pairwise joins). */
  applyLimiter?: boolean;
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

function limiterFilter(limiterAmplitude: number, applyLimiter: boolean): string {
  return applyLimiter
    ? `alimiter=limit=${limiterAmplitude}:level=false:attack=5:release=50`
    : "anull";
}

function edgeFadeChain(
  trims: FilterTrim[],
  overlapSeconds: number[],
  edgeFadeSeconds?: { fadeIn: number; fadeOut: number },
): string {
  const post: string[] = [];
  const fadeIn = edgeFadeSeconds?.fadeIn ?? 0;
  const fadeOut = edgeFadeSeconds?.fadeOut ?? 0;
  if (fadeIn > 0) {
    post.push(`afade=t=in:st=0:d=${fadeIn}`);
  }
  if (fadeOut > 0) {
    const durationSec = expectedDurationMs(trims, overlapSeconds) / 1000;
    post.push(`afade=t=out:st=${Math.max(0, durationSec - fadeOut)}:d=${fadeOut}`);
  }
  return post.length > 0 ? post.join(",") : "anull";
}

function limiterChain(
  trims: FilterTrim[],
  overlapSeconds: number[],
  limiterAmplitude: number,
  edgeFadeSeconds?: { fadeIn: number; fadeOut: number },
  applyLimiter = true,
): string {
  const lim = limiterFilter(limiterAmplitude, applyLimiter);
  const fades = edgeFadeChain(trims, overlapSeconds, edgeFadeSeconds);
  if (lim === "anull") {
    return fades;
  }
  if (fades === "anull") {
    return lim;
  }
  return `${lim},${fades}`;
}

/** Linkwitz–Riley 4th-order: two cascaded 2-pole Butterworths at the same cutoff. */
function lr4Lowpass(hz: number): string {
  return `lowpass=f=${hz},lowpass=f=${hz}`;
}

function lr4Highpass(hz: number): string {
  return `highpass=f=${hz},highpass=f=${hz}`;
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
    `[${current}]${limiterChain(trims, overlapSeconds, limiterAmplitude, edgeFadeSeconds, options.applyLimiter)}[out]`,
  );
  return parts.join(";");
}

function dbToGain(db: number | null | undefined): number {
  if (db == null || !Number.isFinite(db)) {
    return 0;
  }
  return 10 ** (db / 20);
}

function compileBandAfades(
  events: AutomationEvent[],
  originSec: number,
  hasUnity: boolean,
  warnings: string[],
): string {
  const parts: string[] = [];
  let usedPartial = false;
  const ordered = [...events].sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
  for (const ev of ordered) {
    let fromG = dbToGain(ev.fromDb);
    let toG = dbToGain(ev.toDb);
    if (!hasUnity) {
      const collapse = (gain: number) => (gain > 0.5 ? 1 : 0);
      const nextFrom = collapse(fromG);
      const nextTo = collapse(toG);
      if (nextFrom !== fromG || nextTo !== toG) {
        usedPartial = true;
      }
      fromG = nextFrom;
      toG = nextTo;
      if (fromG === toG) {
        continue;
      }
    }
    const st = Math.max(0, originSec + (ev.atMs ?? 0) / 1000);
    const d = Math.max((ev.durationMs ?? 0) / 1000, 0.001);
    const curve = ":curve=hsin";
    if (toG < fromG - 1e-9) {
      const silence = fromG <= 1e-9 ? 0 : toG / fromG;
      const extra =
        hasUnity && silence > 1e-6
          ? `:unity=1:silence=${silence.toFixed(3)}`
          : hasUnity
            ? ":unity=1:silence=0"
            : "";
      parts.push(`afade=t=out:st=${st.toFixed(3)}:d=${d.toFixed(3)}${extra}${curve}`);
    } else if (toG > fromG + 1e-9) {
      const silence = toG <= 1e-9 ? 0 : fromG / toG;
      const extra =
        hasUnity && silence > 1e-6
          ? `:silence=${silence.toFixed(3)}:unity=1`
          : hasUnity
            ? ":silence=0:unity=1"
            : "";
      parts.push(`afade=t=in:st=${st.toFixed(3)}:d=${d.toFixed(3)}${extra}${curve}`);
    }
  }
  if (
    usedPartial &&
    !warnings.includes("FFmpeg afade lacks unity/silence; partial band levels collapsed to full fades.")
  ) {
    warnings.push(
      "FFmpeg afade lacks unity/silence; partial band levels collapsed to full fades.",
    );
  }
  return parts.join(",");
}

/**
 * 3-band phrase-mix / bass-swap: each stream is split into low/mid/high, each band
 * is faded from the preset curve, incoming bands are delayed, then six streams mix.
 */
export function buildBandMixFilter(options: FilterGraphOptions): string {
  const { trims, overlapSeconds, limiterAmplitude, sampleRateHz, edgeFadeSeconds } = options;
  assertGraphShape(trims, overlapSeconds);
  if (trims.length !== 2 || overlapSeconds.length !== 1) {
    throw new Error("band-mix graphs are pairwise (exactly two segments)");
  }
  const spec = options.transitions?.[0];
  const type = spec?.type === "phrase_mix" ? "phrase_mix" : "bass_swap";
  const barCount = normalizePhraseBars(spec?.barCount ?? spec?.params?.barCount);
  const params = clampMixPresetParams(
    { ...spec?.bassSwap, ...spec?.params, barCount, targetBpm: spec?.params?.targetBpm ?? null },
    barCount,
  );
  const t0 = outputDurationSec(trims[0]!);
  const overlap = overlapSeconds[0]!;
  const prefixSec = t0 - overlap;
  const isolatePrefix = prefixSec > 0.001;
  const delayMs = isolatePrefix ? 0 : Math.max(0, Math.round(prefixSec * 1000));
  const barMs =
    params.targetBpm != null && params.targetBpm > 0
      ? (4 * 60_000) / params.targetBpm
      : (overlap * 1000) / barCount;
  const events = expandPreset(type, params, barCount, barMs);
  const hasUnity = options.hasAfadeUnity !== false;
  const warnings = options.warnings ?? [];
  const outgoingOrigin = isolatePrefix ? 0 : Math.max(0, prefixSec);
  const byTarget = (target: AutomationEvent["target"]) =>
    events.filter((ev) => ev.target === target);
  const incomingDelay = delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : "";
  const band = (
    target: AutomationEvent["target"],
    origin: number,
    suffix: string,
  ): string => {
    const fades = compileBandAfades(byTarget(target), origin, hasUnity, warnings);
    return fades.length > 0 ? `${fades}${suffix}` : suffix.replace(/^,/, "") || "anull";
  };
  const lowHz = params.crossoverHz;
  const highHz = BAND_HIGH_CROSSOVER_HZ;
  const oL = band("outgoing_low", outgoingOrigin, "");
  const oM = band("outgoing_mid", outgoingOrigin, "");
  const oH = band("outgoing_high", outgoingOrigin, "");
  const iL = band("incoming_low", 0, incomingDelay);
  const iM = band("incoming_mid", 0, incomingDelay);
  const iH = band("incoming_high", 0, incomingDelay);
  const withFade = (src: string, chain: string, out: string): string => {
    if (!chain || chain === "anull") {
      return `[${src}]anull[${out}]`;
    }
    return `[${src}]${chain}[${out}]`;
  };
  const prefixLabel = isolatePrefix ? prefixSec.toFixed(6) : "";
  const outgoingSplit = isolatePrefix ? "tail" : "s0";
  const parts = [
    segmentPrep(0, trims[0]!, sampleRateHz),
    segmentPrep(1, trims[1]!, sampleRateHz),
    ...(isolatePrefix
      ? [
          `[s0]atrim=start=0:end=${prefixLabel},asetpts=PTS-STARTPTS[prefix]`,
          `[s0]atrim=start=${prefixLabel},asetpts=PTS-STARTPTS[tail]`,
        ]
      : []),
    `[${outgoingSplit}]asplit=3[oRawL][oRawM][oRawH]`,
    `[oRawL]${lr4Lowpass(lowHz)}[oL0]`,
    `[oRawM]${lr4Highpass(lowHz)},${lr4Lowpass(highHz)}[oM0]`,
    `[oRawH]${lr4Highpass(highHz)}[oH0]`,
    `[s1]asplit=3[iRawL][iRawM][iRawH]`,
    `[iRawL]${lr4Lowpass(lowHz)}[iL0]`,
    `[iRawM]${lr4Highpass(lowHz)},${lr4Lowpass(highHz)}[iM0]`,
    `[iRawH]${lr4Highpass(highHz)}[iH0]`,
    withFade("oL0", oL, "oL"),
    withFade("oM0", oM, "oM"),
    withFade("oH0", oH, "oH"),
    withFade("iL0", iL, "iL"),
    withFade("iM0", iM, "iM"),
    withFade("iH0", iH, "iH"),
    `[oL][oM][oH][iL][iM][iH]amix=inputs=6:normalize=0:dropout_transition=0[mixed]`,
    isolatePrefix
      ? options.applyLimiter !== false
        ? `[mixed]${limiterFilter(limiterAmplitude, true)}[mixedLim];[prefix][mixedLim]concat=n=2:v=0:a=1[joined]`
        : `[prefix][mixed]concat=n=2:v=0:a=1[joined]`
      : `[mixed]${limiterFilter(limiterAmplitude, options.applyLimiter !== false)}[joined]`,
    `[joined]${edgeFadeChain(trims, overlapSeconds, edgeFadeSeconds)}[out]`,
  ];
  return parts.join(";");
}

/**
 * 16/32-bar phrase mix via the 3-band preset graph.
 */
export function buildPhraseMixFilter(options: FilterGraphOptions): string {
  const transitions = options.transitions ?? [{ type: "phrase_mix" as const, barCount: 16 }];
  return buildBandMixFilter({
    ...options,
    transitions: [{ ...transitions[0]!, type: "phrase_mix" }],
  });
}

/**
 * Bass swap via the 3-band preset graph.
 */
export function buildBassSwapFilter(options: FilterGraphOptions): string {
  const transitions = options.transitions ?? [{ type: "bass_swap" as const, barCount: 16 }];
  return buildBandMixFilter({
    ...options,
    transitions: [{ ...transitions[0]!, type: "bass_swap" }],
  });
}

export function buildMixFilter(options: FilterGraphOptions): string {
  const types =
    options.transitions ?? options.overlapSeconds.map(() => ({ type: "crossfade" as const }));
  if (options.trims.length === 2 && (types[0]?.type === "phrase_mix" || types[0]?.type === "bass_swap")) {
    return buildBandMixFilter(options);
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

/**
 * Prefer `-filter_complex_script` (keeps argv short). Some FFmpeg builds — including
 * recent Windows nightlies — only ship `-filter_complex`.
 */
export function mixFilterArgs(
  filter: string,
  filterPath: string,
  hasFilterComplexScript: boolean,
): string[] {
  if (hasFilterComplexScript) {
    return ["-filter_complex_script", filterPath];
  }
  return ["-filter_complex", filter];
}
