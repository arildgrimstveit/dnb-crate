import {
  BAND_HIGH_CROSSOVER_HZ,
  CROSSFADE_CURVE,
  clampMixPresetParams,
  effectivePlaybackRate,
  expandPreset,
  normalizePhraseBars,
  shouldSkipAtempo,
  type AutomationEvent,
  type BassSwapParams,
  type MixPresetParams,
  type PhraseBarCount,
} from "@dnb-crate/domain";

export type StretchScope = "all" | "overlap";

export type FilterTrim = {
  startSec: number;
  endSec: number;
  gainDb: number;
  playbackRate?: number;
  /** Solo isolate: stretch this many output seconds at the tail. */
  stretchTailSec?: number;
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
  /**
   * Kept for callers. Pairwise accumulation now joins original decks and
   * concatenates preserved bodies; it does not re-filter completed audio.
   */
  isolatePrefix?: boolean;
  /**
   * Clip 11: `atempo` on a hot drop is a wind-tunnel. Listen-accepted Rubber Band
   * settings are `27-drop-48k-rubberband.flac` (not the smooth/long `28`).
   */
  tempoEngine?: TempoEngine;
  /**
   * `overlap` (default): featured body stays at rate 1; Rubber Band only on the join.
   * `all` is the pre-6.10 whole-window stretch (flickers on long bodies).
   */
  stretchScope?: StretchScope;
  /**
   * Split the outgoing deck with this crossover so a shared middle deck keeps
   * the same IIR phase it already had as the previous join’s incoming deck.
   */
  outgoingCrossoverHz?: number;
  /** Phase-match an incoming deck that will participate in a later band join. */
  incomingCrossoverHz?: number;
};

export type TempoEngine = "rubberband" | "atempo";

/** Listen-accepted Rubber Band tempo filter (clip 11 `27`). */
export function rubberbandTempoFilter(rate: number): string {
  return `rubberband=tempo=${rate.toFixed(6)}:pitch=1:pitchq=quality:channels=together`;
}

/** Extra 3-band run-in before overlap when the outgoing prefix is isolated. */
export const PREFIX_ISOLATION_RUN_IN_BARS = 1;
/** Audible dry→primed splice. Keep IIR warmup longer than this in the wet path. */
export const PREFIX_ISOLATION_SPLICE_SEC = 0.04;
const PREFIX_ISOLATION_MIN_DRY_SEC = 0.001;
/** Hide the native→stretched splice without a long two-tempo blend. */
export const RATE_SPLICE_XFADE_SEC = 0.05;
/** Equal-power blend at a pairwise join boundary after the shared deck is phase-matched. */
export const JOIN_STITCH_XFADE_SEC = 0.012;

export function limiterAmplitudeFromCeilingDb(ceilingDb: number): number {
  return Number(Math.pow(10, ceilingDb / 20).toFixed(9));
}

export function outputDurationSec(
  trim: FilterTrim,
  context: {
    overlapSec?: number;
    stretchScope?: StretchScope;
  } = {},
): number {
  const sourceSec = Math.max(0, trim.endSec - trim.startSec);
  const requested = trim.playbackRate ?? 1;
  const overlapSec = context.overlapSec ?? trim.stretchTailSec ?? 0;
  const scope = context.stretchScope ?? "overlap";
  if (scope === "all" || overlapSec <= 0) {
    return sourceSec / effectivePlaybackRate(requested, sourceSec * 1000);
  }
  const rate = effectivePlaybackRate(requested, overlapSec * 1000);
  if (rate === 1) {
    return sourceSec;
  }
  const overlapSrc = overlapSec * rate;
  if (overlapSrc >= sourceSec) {
    return sourceSec / rate;
  }
  return sourceSec - overlapSrc + overlapSec;
}

export function expectedDurationMs(
  trims: FilterTrim[],
  overlapSeconds: number[],
  stretchScope: StretchScope = "overlap",
): number {
  const overlap = overlapSeconds.reduce((sum, item) => sum + item, 0);
  const playable = trims.reduce((sum, trim, index) => {
    const right = overlapSeconds[index] ?? 0;
    const left = overlapSeconds[index - 1] ?? 0;
    const overlapSec =
      trim.stretchTailSec ??
      (trims.length === 2 ? (index === 0 ? right : left) : index === 0 ? right : left);
    return sum + outputDurationSec(trim, { overlapSec, stretchScope });
  }, 0);
  return Math.max(0, Math.round((playable - overlap) * 1000));
}

function tempoSuffix(
  rate: number | undefined,
  sourceDurationMs: number,
  engine: TempoEngine,
): string {
  if (rate === undefined || shouldSkipAtempo(rate, sourceDurationMs)) {
    return "";
  }
  if (engine === "rubberband") {
    return `,${rubberbandTempoFilter(rate)}`;
  }
  return `,atempo=${rate.toFixed(6)}`;
}

function segmentPrep(
  index: number,
  trim: FilterTrim,
  sampleRateHz: number,
  tempoEngine: TempoEngine,
  overlapSeconds: number[],
  stretchScope: StretchScope,
): string {
  const gain = Number.isFinite(trim.gainDb) ? trim.gainDb : 0;
  const sourceSec = Math.max(0, trim.endSec - trim.startSec);
  const formatted = `[${index}:a]aformat=sample_fmts=fltp:sample_rates=${sampleRateHz}:channel_layouts=stereo,asetpts=PTS-STARTPTS,atrim=start=${trim.startSec}:end=${trim.endSec},asetpts=PTS-STARTPTS,volume=${gain}dB`;
  const right = overlapSeconds[index] ?? 0;
  const left = overlapSeconds[index - 1] ?? 0;
  const overlapOut = trim.stretchTailSec ?? (index === 0 ? right : left);
  const role: "outgoing" | "incoming" | "all" =
    stretchScope === "all" || overlapOut <= 0
      ? "all"
      : trim.stretchTailSec != null || index === 0
        ? "outgoing"
        : "incoming";
  const rate = effectivePlaybackRate(trim.playbackRate, overlapOut * 1000);
  if (role === "all") {
    return `${formatted}${tempoSuffix(trim.playbackRate, sourceSec * 1000, tempoEngine)}[s${index}]`;
  }
  if (rate === 1) {
    return `${formatted}[s${index}]`;
  }
  const overlapSrc = overlapOut * rate;
  const xfade = RATE_SPLICE_XFADE_SEC;
  if (overlapSrc >= sourceSec - xfade || overlapSrc < xfade) {
    return `${formatted}${tempoSuffix(rate, overlapSrc * 1000, tempoEngine)}[s${index}]`;
  }
  const raw = `r${index}`;
  const split = `[${raw}]asplit=2[rb${index}][rt${index}]`;
  if (role === "outgoing") {
    const bodySrc = sourceSec - overlapSrc;
    return [
      `${formatted}[${raw}]`,
      split,
      `[rb${index}]atrim=start=0:end=${(bodySrc + xfade).toFixed(6)},asetpts=PTS-STARTPTS[b${index}]`,
      `[rt${index}]atrim=start=${bodySrc.toFixed(6)},asetpts=PTS-STARTPTS${tempoSuffix(rate, overlapSrc * 1000, tempoEngine)}[t${index}]`,
      `[b${index}][t${index}]acrossfade=d=${xfade}:o=1:c1=${CROSSFADE_CURVE}:c2=${CROSSFADE_CURVE}[s${index}]`,
    ].join(";");
  }
  const headStart = Math.max(0, overlapSrc - xfade);
  return [
    `${formatted}[${raw}]`,
    split,
    `[rb${index}]atrim=start=0:end=${overlapSrc.toFixed(6)},asetpts=PTS-STARTPTS${tempoSuffix(rate, overlapSrc * 1000, tempoEngine)}[h${index}]`,
    `[rt${index}]atrim=start=${headStart.toFixed(6)},asetpts=PTS-STARTPTS[n${index}]`,
    `[h${index}][n${index}]acrossfade=d=${xfade}:o=1:c1=${CROSSFADE_CURVE}:c2=${CROSSFADE_CURVE}[s${index}]`,
  ].join(";");
}

export function limiterFilter(
  limiterAmplitude: number,
  applyLimiter: boolean,
  options: { compensateLatency?: boolean } = {},
): string {
  if (!applyLimiter) {
    return "anull";
  }
  const latency = options.compensateLatency === false ? "" : ":latency=1";
  return `alimiter=limit=${limiterAmplitude}:level=false:attack=5:release=50${latency}`;
}

function edgeFadeChain(
  trims: FilterTrim[],
  overlapSeconds: number[],
  edgeFadeSeconds?: { fadeIn: number; fadeOut: number },
  stretchScope: StretchScope = "overlap",
): string {
  const post: string[] = [];
  const fadeIn = edgeFadeSeconds?.fadeIn ?? 0;
  const fadeOut = edgeFadeSeconds?.fadeOut ?? 0;
  if (fadeIn > 0) {
    post.push(`afade=t=in:st=0:d=${fadeIn}`);
  }
  if (fadeOut > 0) {
    const durationSec = expectedDurationMs(trims, overlapSeconds, stretchScope) / 1000;
    post.push(`afade=t=out:st=${Math.max(0, durationSec - fadeOut)}:d=${fadeOut}`);
  }
  return post.length > 0 ? post.join(",") : "anull";
}

function limiterChain(
  trims: FilterTrim[],
  overlapSeconds: number[],
  limiterAmplitude: number,
  edgeFadeSeconds?: { fadeIn: number; fadeOut: number },
  applyLimiter = false,
  stretchScope: StretchScope = "overlap",
): string {
  const lim = limiterFilter(limiterAmplitude, applyLimiter);
  const fades = edgeFadeChain(trims, overlapSeconds, edgeFadeSeconds, stretchScope);
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

export function prefixIsolationRunInSec(prefixSec: number, barMs: number): number {
  if (prefixSec <= PREFIX_ISOLATION_MIN_DRY_SEC) {
    return 0;
  }
  const barSec = barMs > 0 ? barMs / 1000 : 0.25;
  const desired = Math.max(0.25, barSec * PREFIX_ISOLATION_RUN_IN_BARS);
  const runIn = Math.min(prefixSec, desired);
  return prefixSec - runIn > PREFIX_ISOLATION_MIN_DRY_SEC ? runIn : 0;
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
 * Pitch-preserving tempo matching uses Rubber Band when requested, else `atempo` (not `asetrate`).
 */
export function buildAcrossfadeFilter(options: FilterGraphOptions): string {
  const { trims, overlapSeconds, limiterAmplitude, sampleRateHz, edgeFadeSeconds } = options;
  assertGraphShape(trims, overlapSeconds);
  const tempoEngine = options.tempoEngine ?? "atempo";
  const stretchScope = options.stretchScope ?? "overlap";

  const parts: string[] = [];
  for (let i = 0; i < trims.length; i += 1) {
    parts.push(segmentPrep(i, trims[i]!, sampleRateHz, tempoEngine, overlapSeconds, stretchScope));
  }

  // A shared deck must have the same reconstruction on both sides of a stitch,
  // including when one of its joins uses full-band crossfading.
  const labels = trims.map((_, i) => {
    const hz = i === 0 ? options.outgoingCrossoverHz : options.incomingCrossoverHz;
    if (hz == null) return `s${i}`;
    parts.push(
      `[s${i}]asplit=3[c${i}l][c${i}m][c${i}h]`,
      `[c${i}l]${lr4Lowpass(hz)}[c${i}lo]`,
      `[c${i}m]${lr4Highpass(hz)},${lr4Lowpass(BAND_HIGH_CROSSOVER_HZ)}[c${i}mi]`,
      `[c${i}h]${lr4Highpass(BAND_HIGH_CROSSOVER_HZ)}[c${i}hi]`,
      `[c${i}lo][c${i}mi][c${i}hi]amix=inputs=3:normalize=0:dropout_transition=0[c${i}]`,
    );
    return `c${i}`;
  });

  let current = labels[0]!;
  for (let i = 0; i < overlapSeconds.length; i += 1) {
    const overlap = overlapSeconds[i]!;
    const out = i === overlapSeconds.length - 1 ? "mixed" : `m${i + 1}`;
    parts.push(
      `[${current}][${labels[i + 1]}]acrossfade=d=${overlap}:o=1:c1=${CROSSFADE_CURVE}:c2=${CROSSFADE_CURVE}[${out}]`,
    );
    current = out;
  }

  parts.push(
    `[${current}]${limiterChain(trims, overlapSeconds, limiterAmplitude, edgeFadeSeconds, options.applyLimiter === true, stretchScope)}[out]`,
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
    !warnings.includes(
      "FFmpeg afade lacks unity/silence; partial band levels collapsed to full fades.",
    )
  ) {
    warnings.push("FFmpeg afade lacks unity/silence; partial band levels collapsed to full fades.");
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
  const stretchScope = options.stretchScope ?? "overlap";
  const overlap = overlapSeconds[0]!;
  const t0 = outputDurationSec(trims[0]!, { overlapSec: overlap, stretchScope });
  const prefixSec = t0 - overlap;
  const barMs =
    params.targetBpm != null && params.targetBpm > 0
      ? (4 * 60_000) / params.targetBpm
      : (overlap * 1000) / barCount;
  const tempoEngine = options.tempoEngine ?? "atempo";
  void options.isolatePrefix;
  const expectedSec = expectedDurationMs(trims, overlapSeconds, stretchScope) / 1000;
  const delayMs = Math.max(0, Math.round(prefixSec * 1000));
  const events = expandPreset(type, params, barCount, barMs);
  const hasUnity = options.hasAfadeUnity !== false;
  const warnings = options.warnings ?? [];
  const outgoingOrigin = Math.max(0, prefixSec);
  const byTarget = (target: AutomationEvent["target"]) =>
    events.filter((ev) => ev.target === target);
  const incomingDelay = delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : "";
  const band = (target: AutomationEvent["target"], origin: number, suffix: string): string => {
    const fades = compileBandAfades(byTarget(target), origin, hasUnity, warnings);
    return fades.length > 0 ? `${fades}${suffix}` : suffix.replace(/^,/, "") || "anull";
  };
  const incomingLowHz = params.crossoverHz;
  const outgoingLowHz = options.outgoingCrossoverHz ?? incomingLowHz;
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
  const parts = [
    segmentPrep(0, trims[0]!, sampleRateHz, tempoEngine, overlapSeconds, stretchScope),
    segmentPrep(1, trims[1]!, sampleRateHz, tempoEngine, overlapSeconds, stretchScope),
    `[s0]asplit=3[oRawL][oRawM][oRawH]`,
    `[oRawL]${lr4Lowpass(outgoingLowHz)}[oL0]`,
    `[oRawM]${lr4Highpass(outgoingLowHz)},${lr4Lowpass(highHz)}[oM0]`,
    `[oRawH]${lr4Highpass(highHz)}[oH0]`,
    `[s1]asplit=3[iRawL][iRawM][iRawH]`,
    `[iRawL]${lr4Lowpass(incomingLowHz)}[iL0]`,
    `[iRawM]${lr4Highpass(incomingLowHz)},${lr4Lowpass(highHz)}[iM0]`,
    `[iRawH]${lr4Highpass(highHz)}[iH0]`,
    withFade("oL0", oL, "oL"),
    withFade("oM0", oM, "oM"),
    withFade("oH0", oH, "oH"),
    withFade("iL0", iL, "iL"),
    withFade("iM0", iM, "iM"),
    withFade("iH0", iH, "iH"),
    `[oL][oM][oH][iL][iM][iH]amix=inputs=6:normalize=0:dropout_transition=0[mixed]`,
    `[mixed]${limiterFilter(limiterAmplitude, options.applyLimiter === true)}[joined]`,
    `[joined]atrim=start=0:end=${expectedSec.toFixed(6)},asetpts=PTS-STARTPTS[capped]`,
    `[capped]${edgeFadeChain(trims, overlapSeconds, edgeFadeSeconds, stretchScope)}[out]`,
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
  if (
    options.trims.length === 2 &&
    (types[0]?.type === "phrase_mix" || types[0]?.type === "bass_swap")
  ) {
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
