import {
  chooseMixIntent,
  expandPreset,
  type MixIntent,
  type PhraseBarCount,
  type PhraseShape,
} from "@dnb-crate/domain";

import type { ExitKind } from "./windows.ts";

export type BarSeries = {
  rms: number[];
  sub?: number[];
  midFlux?: number[];
  onsetDensity?: number[];
};

export type HandoffCandidate = {
  barCount: PhraseBarCount;
  exitKind: ExitKind | null;
  phraseShape: PhraseShape;
  incomingHeadEnergy: number;
  outgoingTailEnergy: number;
  mixOutBar?: number | null;
  mixInMs?: number | null;
  mixInBar?: number | null;
  audioStartMs?: number | null;
  incomingBars?: BarSeries | null;
  outgoingBars?: BarSeries | null;
};

export type HandoffScore = {
  score: number;
  intent: MixIntent;
  energyFloor: number;
  drumCompetition: number;
  incomingEarly: number;
  reasons: string[];
  valleyBars?: number;
  coexistenceBars?: number;
  landingFadeBars?: 2 | 4 | 8;
};

export function sliceBars(bars: BarSeries | null | undefined, startBar: number, count: number): BarSeries | null {
  if (!bars || bars.rms.length === 0 || count <= 0) {
    return null;
  }
  const start = Math.max(0, Math.floor(startBar));
  const end = Math.min(bars.rms.length, start + count);
  if (end <= start) {
    return null;
  }
  return {
    rms: bars.rms.slice(start, end),
    sub: bars.sub?.slice(start, end),
    midFlux: bars.midFlux?.slice(start, end),
    onsetDensity: bars.onsetDensity?.slice(start, end),
  };
}

export function scoreHandoff(candidate: HandoffCandidate): HandoffScore {
  const intent = chooseMixIntent(candidate);
  const bars = candidate.barCount;
  const lateIncoming = candidate.incomingBars?.rms.slice(-4);
  const landingFadeBars = candidate.phraseShape === "landing"
    ? ((lateIncoming ? mean(lateIncoming) : candidate.incomingHeadEnergy) < 0.35 ? 2 : bars === 8 ? 4 : 8)
    : undefined;
  const events = expandPreset("phrase_mix", {
    phraseShape: candidate.phraseShape, intent, sequentialHandoff: "supported", landingFadeBars,
  }, bars, 1);
  const gain = (target: string, bar: number): number => {
    let value = target.startsWith("incoming") ? 0 : 1;
    for (const event of events.filter((item) => item.target === target)) {
      const start = event.atBar ?? 0;
      if (bar < start) continue;
      const from = event.fromDb == null ? 0 : 10 ** (event.fromDb / 20);
      const to = event.toDb == null ? 0 : 10 ** (event.toDb / 20);
      const fraction = Math.min(1, (bar - start) / Math.max(event.durationBars ?? 0, 1e-6));
      // Match the renderer's hsin fade shape; energy remains a source-derived proxy.
      const fade = (1 - Math.cos(Math.PI * fraction)) / 2;
      value = from + (to - from) * fade;
    }
    return value;
  };
  let valleyBars = 0;
  let coexistenceBars = 0;
  let competition = 0;
  let floor = 1;
  for (let i = 0; i < bars; i += 1) {
    const out = candidate.outgoingBars?.rms[i] ?? candidate.outgoingTailEnergy;
    const incoming = candidate.incomingBars?.rms[i] ?? candidate.incomingHeadEnergy;
    const at = i + 0.5;
    const outGain = 0.65 * gain("outgoing_mid", at) + 0.35 * gain("outgoing_low", at);
    const inGain = 0.65 * gain("incoming_mid", at) + 0.35 * gain("incoming_low", at);
    const outAudible = out * outGain;
    const inAudible = incoming * inGain;
    const combined = Math.min(1, Math.hypot(outAudible, inAudible));
    floor = Math.min(floor, combined);
    valleyBars += Math.max(0, (0.5 - combined) / 0.5);
    if (outAudible > 0.15 && inAudible > 0.15) coexistenceBars += 1;
    if (out > 0.65 && incoming > 0.65) competition += Math.min(outGain, inGain);
  }
  // Absolute valley duration matters: extending a quiet handoff must not improve its score.
  // Outgoing-only carry through a quiet incoming intro can still look like a high floor.
  const coexistenceRatio = bars > 0 ? coexistenceBars / bars : 0;
  const quietPrefix = quietIncomingPrefix(candidate);
  const landing = candidate.exitKind === "dropLanding" || candidate.phraseShape === "landing";
  const lengthBias = landing ? (bars === 32 ? 0.28 : bars === 16 ? 0.18 : 0) : 0;
  const score = floor * 3 - valleyBars * 0.35 + Math.min(coexistenceBars, 16) * 0.035
    + coexistenceRatio * 1.2 - quietPrefix * (bars >= 16 ? 0.9 : 0.2)
    - competition * 0.025 + lengthBias;
  return {
    score, intent, energyFloor: floor, drumCompetition: competition / bars,
    incomingEarly: incomingEarlyScore(candidate), valleyBars, coexistenceBars, landingFadeBars,
    reasons: [
      "source-window continuity proxy",
      `${valleyBars.toFixed(1)} weighted valley bars`,
      ...(lengthBias > 0 ? [`prefer ${bars}-bar landing`] : []),
    ],
  };
}

export function pickHandoffCandidate<T extends HandoffCandidate>(candidates: T[]): T | null {
  if (candidates.length === 0) {
    return null;
  }
  const longer = candidates.filter((item) => item.barCount >= 16);
  const banned = longer.length > 0 ? longer : candidates;
  const laterIncoming = banned.filter((item) => !isQuietIncomingStart(item) && incomingHasEnergy(item));
  const withoutQuietStart = laterIncoming.length > 0
    ? banned.filter((item) => !isQuietIncomingStart(item))
    : banned;
  const energeticExits = withoutQuietStart.filter(
    (item) => item.exitKind === "dropLanding" && item.outgoingTailEnergy >= 0.5,
  );
  const pool = energeticExits.length > 0 ? energeticExits : withoutQuietStart;
  const deepLandings = pool.filter(
    (item) => item.barCount >= 16 && item.exitKind === "dropLanding" && !isQuietIncomingStart(item),
  );
  return pickByScore(deepLandings.length > 0 ? deepLandings : pool);
}

/** About two bars at 174 BPM; file-start mix-ins are often the first downbeat, not 0 ms. */
const FILE_START_MS = 2800;

function isFileStartIntro(candidate: HandoffCandidate): boolean {
  if (candidate.mixInBar === 0) {
    return true;
  }
  if (candidate.mixInMs == null || candidate.audioStartMs == null) {
    return false;
  }
  return candidate.mixInMs <= candidate.audioStartMs + FILE_START_MS;
}

/** 32-bar landings through a quiet intro, not only the first 2.8 s / bar 0. */
function isQuietIncomingStart(candidate: HandoffCandidate): boolean {
  if (isFileStartIntro(candidate)) {
    return true;
  }
  return candidate.barCount >= 32 && quietIncomingPrefix(candidate) > 0.5;
}

function incomingHasEnergy(candidate: HandoffCandidate): boolean {
  if (candidate.incomingHeadEnergy >= 0.35) {
    return true;
  }
  const rms = candidate.incomingBars?.rms;
  if (rms && rms.length > 0) {
    const late = mean(rms.slice(Math.max(0, Math.floor(rms.length / 2))));
    if (late >= 0.4) {
      return true;
    }
  }
  return incomingEarlyScore(candidate) >= 0.4;
}

function quietIncomingPrefix(candidate: HandoffCandidate): number {
  const rms = candidate.incomingBars?.rms;
  if (!rms || rms.length < 4) {
    return candidate.incomingHeadEnergy < 0.35 ? 1 : 0;
  }
  const front = mean(rms.slice(0, Math.max(2, Math.floor(rms.length / 2))));
  return front < 0.3 ? (0.3 - front) / 0.3 : 0;
}

function pickByScore<T extends HandoffCandidate>(candidates: T[]): T {
  return candidates
    .map((candidate) => ({ candidate, scored: scoreHandoff(candidate) }))
    .sort((a, b) => {
      const scoreDiff = b.scored.score - a.scored.score;
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return b.candidate.barCount - a.candidate.barCount;
    })[0]!
    .candidate;
}

function incomingEarlyScore(candidate: HandoffCandidate): number {
  const rms = candidate.incomingBars?.rms;
  if (!rms || rms.length < 4) {
    return candidate.incomingHeadEnergy >= 0.35 ? 0.45 : 0.1;
  }
  const early = mean(rms.slice(0, Math.max(1, Math.round(rms.length * 0.25))));
  const late = mean(rms.slice(Math.max(1, Math.round(rms.length * 0.75))));
  if (late <= 1e-6) {
    return early;
  }
  return Math.min(1, early / Math.max(late, early, 1e-6));
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
