import {
  DEFAULT_BASS_CROSSOVER_HZ,
  DEFAULT_BASS_LOW_ATTENUATION_DB,
  DEFAULT_BASS_SWAP_RAMP_MS,
  DEFAULT_MID_DIP_DB,
  MAX_BASS_CROSSOVER_HZ,
  MAX_BASS_SWAP_RAMP_MS,
  MIN_BASS_CROSSOVER_HZ,
  MIN_BASS_SWAP_RAMP_MS,
} from "./constants.ts";
import { clampBassSwapParams, type AutomationEvent, type BassSwapParams, type TrackSection } from "./analysis.ts";
import type { TransitionType } from "./planning.ts";

export type MixPresetType = "crossfade" | "phrase_mix" | "bass_swap";
export type PhraseShape = "complementary" | "sequential";

export const SEQUENTIAL_INCOMING_HEAD_ENERGY = 0.15;
export const SEQUENTIAL_OUTGOING_DROP_ENERGY = 0.3;

export type MixPresetParams = BassSwapParams & {
  barCount: 16 | 32;
  targetBpm: number | null;
  lowHandoverBar: number;
  midDipDb: number;
  phraseShape: PhraseShape;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function defaultLowHandoverBar(barCount: 16 | 32): number {
  return barCount === 32 ? 24 : 12;
}

export function clampMixPresetParams(
  input: Partial<MixPresetParams> | null | undefined,
  barCount: 16 | 32,
): MixPresetParams {
  const bass = clampBassSwapParams(input, barCount);
  const defaultHandover = defaultLowHandoverBar(barCount);
  const handoverRaw = input?.lowHandoverBar ?? bass.lowHandoverBar ?? defaultHandover;
  const lowHandoverBar =
    handoverRaw > 0 && handoverRaw <= barCount && handoverRaw % 4 === 0
      ? handoverRaw
      : defaultHandover;
  return {
    ...bass,
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
      clamp(input?.rampMs ?? bass.rampMs ?? DEFAULT_BASS_SWAP_RAMP_MS, MIN_BASS_SWAP_RAMP_MS, MAX_BASS_SWAP_RAMP_MS),
    ),
    lowAttenuationDb: clamp(
      input?.lowAttenuationDb ?? bass.lowAttenuationDb ?? DEFAULT_BASS_LOW_ATTENUATION_DB,
      -36,
      0,
    ),
    midDipDb: clamp(input?.midDipDb ?? bass.midDipDb ?? DEFAULT_MID_DIP_DB, -24, 0),
    lowHandoverBar,
    phraseShape: input?.phraseShape === "sequential" ? "sequential" : "complementary",
  };
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

function phraseEvents(params: MixPresetParams, barMs: number): AutomationEvent[] {
  const handover = params.lowHandoverBar;
  const end = params.barCount;
  const half = end / 2;
  const incomingStart = params.phraseShape === "sequential" ? half : 0;
  const incomingBars = params.phraseShape === "sequential" ? half : end;
  const outgoingBars = params.phraseShape === "sequential" ? half : end;
  return [
    event("incoming_mid", incomingStart, incomingBars, null, 0, barMs),
    event("incoming_high", incomingStart, incomingBars, null, 0, barMs),
    event("incoming_low", handover, 1, null, 0, barMs),
    event("outgoing_low", handover, 1, 0, params.lowAttenuationDb, barMs),
    event("outgoing_low", end, 0, params.lowAttenuationDb, null, barMs, Math.max(params.rampMs, 1)),
    event("outgoing_mid", 0, outgoingBars, 0, null, barMs),
    event("outgoing_high", 0, outgoingBars, 0, null, barMs),
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

export function expandPreset(
  type: MixPresetType | TransitionType,
  params: Partial<MixPresetParams> | null | undefined,
  barCount: 16 | 32,
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
    const ordered = [...list].sort((a, b) => (a.atBar ?? 0) - (b.atBar ?? 0) || (a.atMs ?? 0) - (b.atMs ?? 0));
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
