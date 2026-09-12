import {
  DEFAULT_BASS_CROSSOVER_HZ,
  DEFAULT_BASS_LOW_ATTENUATION_DB,
  DEFAULT_BASS_SWAP_RAMP_MS,
  DEFAULT_MID_DIP_DB,
  MAX_BASS_CROSSOVER_HZ,
  MAX_BASS_SWAP_RAMP_MS,
  MIN_BASS_CROSSOVER_HZ,
  MIN_BASS_SWAP_RAMP_MS,
  type PhraseBarCount,
} from "./constants.ts";
import {
  clampBassSwapParams,
  type AutomationEvent,
  type BassSwapParams,
  type TrackSection,
} from "./analysis.ts";
import type { TransitionType } from "./planning.ts";

export type MixPresetType = "crossfade" | "phrase_mix" | "bass_swap";
export type PhraseShape = "complementary" | "sequential" | "landing";
export type MixIntent = "sustain" | "lift" | "breather";

export const SEQUENTIAL_INCOMING_HEAD_ENERGY = 0.15;
export const SEQUENTIAL_OUTGOING_DROP_ENERGY = 0.3;

export type MixPresetParams = BassSwapParams & {
  barCount: PhraseBarCount;
  targetBpm: number | null;
  lowHandoverBar: number;
  midDipDb: number;
  phraseShape: PhraseShape;
  intent: MixIntent;
  /** How incoming kit arrives on a sequential join. New plans write "supported". */
  sequentialHandoff?: "legacy" | "early" | "supported";
  /** DJ landing release; absent preserves historical 4/8-bar fades. */
  landingFadeBars?: 2 | 4 | 8;
  /** Optional outgoing presence after the incoming drop, within the existing overlap. */
  landingCarryBars?: 2 | 3.5 | 4 | 4.5;
  /** Incoming mids/highs fade over the final bars of overlap, independently of bass arrival. */
  landingIncomingFadeBars?: PhraseBarCount;
  /** Incoming mix-in and first drop, used to time landing bass to the drop. */
  mixInMs?: number;
  incomingDropMs?: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function chooseMixIntent(
  input: {
    phraseShape?: PhraseShape | null;
    exitKind?: string | null;
    requested?: MixIntent | null;
  } = {},
): MixIntent {
  if (
    input.requested === "sustain" ||
    input.requested === "lift" ||
    input.requested === "breather"
  ) {
    return input.requested;
  }
  if (input.phraseShape === "landing" || input.exitKind === "dropLanding") {
    return "sustain";
  }
  if (input.phraseShape === "sequential") {
    return "sustain";
  }
  return "lift";
}

export function defaultLowHandoverBar(
  barCount: PhraseBarCount,
  intent: MixIntent = "lift",
): number {
  if (intent === "lift") {
    return barCount === 32 ? 16 : barCount === 8 ? 4 : 8;
  }
  return barCount === 32 ? 24 : barCount === 8 ? 6 : 12;
}

export function outgoingHoldBars(
  barCount: PhraseBarCount,
  intent: MixIntent,
  phraseShape: PhraseShape,
): number {
  if (phraseShape !== "complementary" || intent !== "lift") {
    return 0;
  }
  return barCount === 8 ? 2 : 4;
}

export function clampMixPresetParams(
  input: Partial<MixPresetParams> | null | undefined,
  barCount: PhraseBarCount,
): MixPresetParams {
  const bass = clampBassSwapParams(input, barCount);
  const phraseShape: PhraseShape =
    input?.phraseShape === "sequential" || input?.phraseShape === "landing"
      ? input.phraseShape
      : "complementary";
  const intent = chooseMixIntent({
    phraseShape,
    requested:
      input?.intent === "sustain" || input?.intent === "lift" || input?.intent === "breather"
        ? input.intent
        : null,
  });
  const defaultHandover = defaultLowHandoverBar(barCount, intent);
  const handoverRaw = input?.lowHandoverBar ?? bass.lowHandoverBar ?? defaultHandover;
  const step = barCount === 8 ? 2 : 4;
  const lowHandoverBar =
    handoverRaw > 0 && handoverRaw <= barCount && handoverRaw % step === 0
      ? handoverRaw
      : defaultHandover;
  return {
    ...bass,
    sequentialHandoff:
      input?.sequentialHandoff === "early" || input?.sequentialHandoff === "supported"
        ? input.sequentialHandoff
        : "legacy",
    ...(input?.landingFadeBars === 2 || input?.landingFadeBars === 4 || input?.landingFadeBars === 8
      ? { landingFadeBars: input.landingFadeBars }
      : {}),
    ...(input?.landingCarryBars === 2 ||
    input?.landingCarryBars === 3.5 ||
    input?.landingCarryBars === 4 ||
    input?.landingCarryBars === 4.5
      ? { landingCarryBars: input.landingCarryBars }
      : {}),
    ...(input?.landingIncomingFadeBars === 8 ||
    input?.landingIncomingFadeBars === 16 ||
    input?.landingIncomingFadeBars === 32
      ? {
          landingIncomingFadeBars: Math.min(
            input.landingIncomingFadeBars,
            barCount,
          ) as PhraseBarCount,
        }
      : {}),
    barCount,
    targetBpm:
      input?.targetBpm != null && Number.isFinite(input.targetBpm) && input.targetBpm > 0
        ? input.targetBpm
        : null,
    crossoverHz: clamp(
      input?.crossoverHz ?? bass.crossoverHz ?? DEFAULT_BASS_CROSSOVER_HZ,
      MIN_BASS_CROSSOVER_HZ,
      MAX_BASS_CROSSOVER_HZ,
    ),
    rampMs: Math.round(
      clamp(
        input?.rampMs ?? bass.rampMs ?? DEFAULT_BASS_SWAP_RAMP_MS,
        MIN_BASS_SWAP_RAMP_MS,
        MAX_BASS_SWAP_RAMP_MS,
      ),
    ),
    lowAttenuationDb: clamp(
      input?.lowAttenuationDb ?? bass.lowAttenuationDb ?? DEFAULT_BASS_LOW_ATTENUATION_DB,
      -36,
      0,
    ),
    midDipDb: clamp(input?.midDipDb ?? bass.midDipDb ?? DEFAULT_MID_DIP_DB, -24, 0),
    lowHandoverBar,
    phraseShape,
    intent,
    ...(typeof input?.mixInMs === "number" && Number.isFinite(input.mixInMs) && input.mixInMs >= 0
      ? { mixInMs: input.mixInMs }
      : {}),
    ...(typeof input?.incomingDropMs === "number" &&
    Number.isFinite(input.incomingDropMs) &&
    input.incomingDropMs >= 0
      ? { incomingDropMs: input.incomingDropMs }
      : {}),
  };
}

export function landingIncomingDropBar(
  params: Pick<MixPresetParams, "incomingDropMs" | "mixInMs">,
  barMs: number,
): number | null {
  if (!(barMs > 0)) {
    return null;
  }
  const drop = params.incomingDropMs;
  const mixIn = params.mixInMs;
  if (drop == null || mixIn == null || !Number.isFinite(drop) || !Number.isFinite(mixIn)) {
    return null;
  }
  const bar = (drop - mixIn) / barMs;
  if (!Number.isFinite(bar)) {
    return null;
  }
  const snapped = Math.round(bar);
  return Math.abs(bar - snapped) < 1e-6 ? snapped : bar;
}

export function sectionAtMs(
  sections: TrackSection[],
  atMs: number | null | undefined,
): TrackSection | undefined {
  if (atMs == null || !Number.isFinite(atMs)) {
    return sections[0];
  }
  return (
    sections.find((section) => atMs >= section.startMs && atMs < section.endMs) ??
    sections.find((section) => atMs >= section.startMs && atMs <= section.endMs)
  );
}

/**
 * Drop outro into a drum-heavy intro: do not layer kits. Incoming mid/high wait until
 * the outgoing kit has faded. Quiet intros and non-drop tails stay complementary.
 */
export function choosePhraseShape(
  outgoing: Pick<TrackSection, "type" | "sectionEnergy"> | null | undefined,
  incoming: Pick<TrackSection, "type" | "sectionEnergy"> | null | undefined,
): PhraseShape {
  if (
    incoming != null &&
    incoming.sectionEnergy >= SEQUENTIAL_INCOMING_HEAD_ENERGY &&
    outgoing != null &&
    outgoing.type === "drop" &&
    outgoing.sectionEnergy >= SEQUENTIAL_OUTGOING_DROP_ENERGY
  ) {
    return "sequential";
  }
  return "complementary";
}

/** Execute explicit musical choices; infer a shape only for legacy recipes without one. */
export function resolveRenderPhraseShape(
  planned: PhraseShape | null | undefined,
  exitKind: string | null | undefined,
  outgoing: Pick<TrackSection, "type" | "sectionEnergy"> | null | undefined,
  incoming: Pick<TrackSection, "type" | "sectionEnergy"> | null | undefined,
): PhraseShape {
  if (planned != null) {
    return planned;
  }
  if (exitKind === "dropLanding") {
    return "landing";
  }
  return choosePhraseShape(outgoing, incoming);
}

function event(
  target: AutomationEvent["target"],
  atBar: number,
  durationBars: number,
  fromDb: number | null,
  toDb: number | null,
  barMs: number,
  durationMs?: number,
): AutomationEvent {
  const durMs = durationMs ?? Math.max(0, Math.round(durationBars * barMs));
  return {
    target,
    action: "ramp",
    atBar,
    durationBars,
    atMs: Math.round(atBar * barMs),
    durationMs: durMs,
    fromDb,
    toDb,
  };
}

function landingEvents(params: MixPresetParams, barMs: number): AutomationEvent[] {
  const end = params.barCount;
  const carry = params.landingCarryBars ?? 0;
  const arrival = end - carry;
  const midHighFade = params.landingFadeBars ?? (end === 8 ? 4 : 8);
  const midHighStart = Math.max(0, end - midHighFade);
  const dropBar = landingIncomingDropBar(params, barMs);
  const dropAt = dropBar != null && dropBar > 0.5 ? Math.min(arrival, Math.max(0, dropBar)) : null;
  const midLead = end === 8 ? 2 : 4;
  const incomingFade =
    params.landingIncomingFadeBars ?? (dropAt != null ? Math.max(1, dropAt - midLead) : arrival);
  const incomingStart = params.landingIncomingFadeBars == null ? 0 : end - incomingFade;
  const lowLead = 2;
  const swapAt = dropAt != null ? Math.max(0, dropAt - Math.min(lowLead, dropAt)) : arrival - 1;
  const lowFadeBars = dropAt != null ? Math.max(dropAt - swapAt, 0) : 1;
  const lowFadeMs = lowFadeBars < 1 ? Math.max(params.rampMs, 1) : undefined;
  const outgoingDumpAt = dropAt ?? swapAt;
  const outgoingDumpBars = dropAt != null ? 0 : 1;
  const outgoingDumpMs = dropAt != null ? Math.max(params.rampMs, 1) : undefined;
  return [
    event("incoming_mid", incomingStart, incomingFade, null, 0, barMs),
    event("incoming_high", incomingStart, incomingFade, null, 0, barMs),
    event("incoming_low", swapAt, lowFadeBars, null, 0, barMs, lowFadeMs),
    event(
      "outgoing_low",
      outgoingDumpAt,
      outgoingDumpBars,
      0,
      params.lowAttenuationDb,
      barMs,
      outgoingDumpMs,
    ),
    event(
      "outgoing_low",
      arrival,
      carry ? 1 : 0,
      params.lowAttenuationDb,
      null,
      barMs,
      carry ? barMs : Math.max(params.rampMs, 1),
    ),
    event("outgoing_mid", midHighStart, midHighFade, 0, null, barMs),
    event("outgoing_high", midHighStart, midHighFade, 0, null, barMs),
  ];
}

function phraseEvents(params: MixPresetParams, barMs: number): AutomationEvent[] {
  if (params.phraseShape === "landing") {
    return landingEvents(params, barMs);
  }
  const handover = params.lowHandoverBar;
  const end = params.barCount;
  const half = end / 2;
  const overlapBars = params.phraseShape === "sequential" ? 2 : 0;
  const incomingStart = params.phraseShape === "sequential" ? Math.max(0, half - overlapBars) : 0;
  const incomingBars = params.phraseShape === "sequential" ? end - incomingStart : end;
  const hold = outgoingHoldBars(params.barCount, params.intent, params.phraseShape);
  const outgoingStart = params.phraseShape === "sequential" ? 0 : hold;
  const outgoingBars = params.phraseShape === "sequential" ? half : end - hold;
  if (
    params.phraseShape === "sequential" &&
    params.sequentialHandoff !== "legacy" &&
    params.sequentialHandoff != null
  ) {
    const blendBars = params.sequentialHandoff === "early" ? half : end;
    return [
      event("incoming_mid", 0, blendBars, null, 0, barMs),
      event("incoming_high", 0, blendBars, null, 0, barMs),
      event("outgoing_mid", 0, blendBars, 0, null, barMs),
      event("outgoing_high", 0, blendBars, 0, null, barMs),
      event("incoming_low", handover, 1, null, 0, barMs),
      event("outgoing_low", handover, 1, 0, params.lowAttenuationDb, barMs),
      event(
        "outgoing_low",
        end,
        0,
        params.lowAttenuationDb,
        null,
        barMs,
        Math.max(params.rampMs, 1),
      ),
    ];
  }
  return [
    event("incoming_mid", incomingStart, incomingBars, null, 0, barMs),
    event("incoming_high", incomingStart, incomingBars, null, 0, barMs),
    event("incoming_low", handover, 1, null, 0, barMs),
    event("outgoing_low", handover, 1, 0, params.lowAttenuationDb, barMs),
    event("outgoing_low", end, 0, params.lowAttenuationDb, null, barMs, Math.max(params.rampMs, 1)),
    event("outgoing_mid", outgoingStart, outgoingBars, 0, null, barMs),
    event("outgoing_high", outgoingStart, outgoingBars, 0, null, barMs),
  ];
}

function bassSwapEvents(params: MixPresetParams, barMs: number): AutomationEvent[] {
  const dipBar = params.barCount === 32 ? 8 : 4;
  return [
    event("outgoing_high", 0, params.barCount, 0, null, barMs),
    event("incoming_high", 0, params.barCount, null, 0, barMs),
    event("outgoing_mid", dipBar, 0, 0, params.midDipDb, barMs, params.rampMs),
    event("outgoing_mid", dipBar, params.barCount - dipBar, params.midDipDb, null, barMs),
    event("incoming_mid", 0, params.barCount, null, 0, barMs),
    event("outgoing_low", params.swapAtBar, 0, 0, params.lowAttenuationDb, barMs, params.rampMs),
    event(
      "outgoing_low",
      params.lowHandoverBar,
      0,
      params.lowAttenuationDb,
      null,
      barMs,
      params.rampMs,
    ),
    event("incoming_low", params.swapAtBar, 0, null, 0, barMs, params.rampMs),
  ];
}

export function sequentialHandoffLabel(
  handoff: MixPresetParams["sequentialHandoff"] | null | undefined,
): string {
  if (handoff === "supported") {
    return "supported overlap";
  }
  if (handoff === "early") {
    return "early overlap";
  }
  return "incoming kit held until mid-phrase";
}

export function expandPreset(
  type: MixPresetType | TransitionType,
  params: Partial<MixPresetParams> | null | undefined,
  barCount: PhraseBarCount,
  barMs: number,
): AutomationEvent[] {
  if (type === "crossfade") {
    return [
      event("outgoing_high", 0, barCount, 0, null, barMs),
      event("incoming_high", 0, barCount, null, 0, barMs),
    ];
  }
  const clamped = clampMixPresetParams(params, barCount);
  if (type === "phrase_mix") {
    return phraseEvents(clamped, barMs);
  }
  return bassSwapEvents(clamped, barMs);
}

function dbOrInf(value: number | null | undefined): number {
  return value == null || !Number.isFinite(value) ? Number.NEGATIVE_INFINITY : value;
}

export function isMonotoneBand(events: AutomationEvent[]): boolean {
  const byTarget = new Map<string, AutomationEvent[]>();
  for (const ev of events) {
    const list = byTarget.get(ev.target) ?? [];
    list.push(ev);
    byTarget.set(ev.target, list);
  }
  for (const list of byTarget.values()) {
    const ordered = [...list].sort(
      (a, b) => (a.atBar ?? 0) - (b.atBar ?? 0) || (a.atMs ?? 0) - (b.atMs ?? 0),
    );
    let direction = 0;
    for (const ev of ordered) {
      const delta = dbOrInf(ev.toDb) - dbOrInf(ev.fromDb);
      if (Math.abs(delta) < 1e-6) {
        continue;
      }
      const sign = delta > 0 ? 1 : -1;
      if (direction !== 0 && sign !== direction) {
        return false;
      }
      direction = sign;
    }
  }
  return true;
}
