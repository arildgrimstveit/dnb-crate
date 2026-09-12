import { planAlignmentOffsetMs, type DownbeatAlignment } from "@dnb-crate/audio-renderer";
import {
  outputToSourceMs,
  MIN_PLAYABLE_DURATION_MS,
  sectionAtMs,
  snapToNearestBeat,
  sourceToOutputMs,
  type CuePoint,
  type PhraseBarCount,
  type PhraseShape,
  type TrackSection,
} from "@dnb-crate/domain";

import { pickMixIn, pickMixOut } from "./cues.ts";
import { pickHandoffCandidate, scoreHandoff } from "./handoff.ts";

export type WindowTrack = {
  id: string;
  durationMs: number;
  bpm: number | null;
  cues?: CuePoint[];
  analysis?: {
    sections: TrackSection[];
    canonicalBpm?: number | null;
    bpm?: number | null;
    audioStartMs?: number | null;
    audioEndMs?: number | null;
    downbeatTimesMs?: number[];
    downbeatConfidence?: number | null;
    manualMixInMs?: number | null;
    manualMixOutMs?: number | null;
    bars?: {
      rms: number[];
      sub?: number[];
      midFlux?: number[];
      onsetDensity?: number[];
    } | null;
  } | null;
};

export type ExitKind = "quietTail" | "dropLanding";

export type PhraseWindow = {
  mixInMs: number;
  mixOutMs: number;
  mixInBar: number | null;
  mixOutBar: number | null;
  barCount: PhraseBarCount;
  exitKind: ExitKind | null;
  phraseShape: PhraseShape;
  incomingDropMs: number | null;
  dropAnchored: boolean;
  alignmentOffsetMs: number;
  alignmentPeriodMs: number | null;
  alignmentMode: DownbeatAlignment["mode"] | null;
  continuity?: {
    energyFloor: number;
    valleyBars: number;
    coexistenceBars: number;
    evidence: string;
    landingFadeBars?: 2 | 4 | 8;
  };
};

const PHRASE = 8;
const QUIET = 0.5;
const KIT_ON = 0.5;
/** Slightly under 16 bars at 174 BPM so a drop-16 tail still clears rounding. */
const LATE_DROP_16_MS = 22_000;
const LATE_DROP_MIN_BODY_MS = 32_000;

/** When a drop-16 start cannot host 90 s through the file end, featured music is that tail. */
export function lateDropMinPlayableMs(
  durationMs: number,
  firstDropStartMs: number | null | undefined,
): number | null {
  if (firstDropStartMs == null || !Number.isFinite(firstDropStartMs)) {
    return null;
  }
  if (durationMs < MIN_PLAYABLE_DURATION_MS) {
    return null;
  }
  const mixIn = Math.max(0, firstDropStartMs - LATE_DROP_16_MS);
  const remaining = durationMs - mixIn;
  if (remaining >= MIN_PLAYABLE_DURATION_MS) {
    return null;
  }
  return Math.max(LATE_DROP_MIN_BODY_MS, Math.round(remaining) - 1_000);
}

export function relEnergy(
  section: Pick<TrackSection, "sectionEnergy"> | null | undefined,
  sections: TrackSection[],
): number {
  if (!section) {
    return 0;
  }
  const maxDrop = Math.max(
    0,
    ...sections.filter((item) => item.type === "drop").map((item) => item.sectionEnergy),
  );
  const denom = maxDrop > 1e-6 ? maxDrop : Math.max(section.sectionEnergy, 1e-6);
  return section.sectionEnergy / denom;
}

export function firstDropSection(sections: TrackSection[]): TrackSection | undefined {
  return sections.find((section) => section.type === "drop");
}

export function barMsFor(bpm: number | null | undefined): number {
  const tempo = bpm != null && bpm > 0 ? bpm : 174;
  return (4 * 60_000) / tempo;
}

export function barToMs(
  bar: number,
  sections: TrackSection[],
  bpm: number | null | undefined,
  downbeats: number[],
  audioStartMs: number,
): number {
  for (const section of sections) {
    if (
      section.startBar != null &&
      section.endBar != null &&
      section.endBar > section.startBar &&
      bar >= section.startBar &&
      bar <= section.endBar
    ) {
      const t = (bar - section.startBar) / (section.endBar - section.startBar);
      return Math.round(section.startMs + t * (section.endMs - section.startMs));
    }
  }
  const raw = audioStartMs + bar * barMsFor(bpm);
  return downbeats.length > 0
    ? (snapToNearestBeat(raw, downbeats)?.positionMs ?? Math.round(raw))
    : Math.round(raw);
}

export function audioEndBar(
  sections: TrackSection[],
  audioEndMs: number,
  bpm: number | null | undefined,
  audioStartMs: number,
): number {
  const last = [...sections].reverse().find((section) => section.endBar != null);
  if (last?.endBar != null) {
    return last.endBar;
  }
  return Math.max(0, Math.round((audioEndMs - audioStartMs) / barMsFor(bpm)));
}

function phraseOriginBar(sections: TrackSection[]): number | null {
  const drop = firstDropSection(sections);
  return drop?.startBar ?? null;
}

function phraseBoundaries(origin: number, endBar: number): number[] {
  const bars: number[] = [];
  let cursor = origin % PHRASE;
  if (cursor < 0) {
    cursor += PHRASE;
  }
  for (; cursor <= endBar; cursor += PHRASE) {
    bars.push(cursor);
  }
  return bars;
}

function firstDownbeatAfter(downbeats: number[], audioStartMs: number): number | null {
  const hit = downbeats.find((time) => time > audioStartMs + 1);
  return hit ?? downbeats[0] ?? null;
}

function avoidSourceZero(mixInMs: number, downbeats: number[], audioStartMs: number): number {
  if (mixInMs > audioStartMs + 1) {
    return mixInMs;
  }
  return firstDownbeatAfter(downbeats, audioStartMs) ?? Math.max(audioStartMs, mixInMs);
}

function sectionAtBar(
  sections: TrackSection[],
  bar: number,
  bpm: number | null | undefined,
  downbeats: number[],
  audioStartMs: number,
): TrackSection | undefined {
  const ms = barToMs(bar, sections, bpm, downbeats, audioStartMs);
  return sectionAtMs(sections, ms);
}

function introBuildAt(section: TrackSection | undefined): boolean {
  return section == null || section.type === "intro" || section.type === "build";
}

function largestPhraseNotAfter(bar: number): PhraseBarCount {
  if (bar >= 32) {
    return 32;
  }
  if (bar >= 16) {
    return 16;
  }
  return 8;
}

function pickOutgoingExit(
  outgoing: WindowTrack,
  barCount: PhraseBarCount,
  targetBpm: number | null,
): { mixOutMs: number; mixOutBar: number | null; exitKind: ExitKind; phraseShape: PhraseShape } {
  const analysis = outgoing.analysis;
  const sections = analysis?.sections ?? [];
  const bpm = targetBpm ?? analysis?.canonicalBpm ?? outgoing.bpm;
  const audioStart = analysis?.audioStartMs ?? 0;
  const audioEnd = analysis?.audioEndMs ?? outgoing.durationMs;
  const downbeats = analysis?.downbeatTimesMs ?? [];
  const endBar = audioEndBar(sections, audioEnd, bpm, audioStart);
  const origin = phraseOriginBar(sections);
  const manualOut = outgoing.analysis?.manualMixOutMs;
  if (manualOut != null && Number.isFinite(manualOut)) {
    const at = sectionAtMs(sections, manualOut);
    const quiet =
      relEnergy(at, sections) <= QUIET && (at?.type === "outro" || at?.type === "breakdown");
    return {
      mixOutMs: Math.round(manualOut),
      mixOutBar: null,
      exitKind: quiet ? "quietTail" : "dropLanding",
      phraseShape: quiet ? "complementary" : "landing",
    };
  }
  if (origin == null) {
    const fallback = pickMixOut({
      track: { id: outgoing.id, durationMs: outgoing.durationMs },
      analysis: {
        sections,
        downbeatTimesMs: downbeats,
        descriptors: { audioStartMs: audioStart, audioEndMs: audioEnd },
      },
      cues: outgoing.cues ?? [],
    });
    const at = sectionAtMs(sections, fallback.ms);
    const quiet =
      relEnergy(at, sections) <= QUIET && (at?.type === "outro" || at?.type === "breakdown");
    return {
      mixOutMs: fallback.ms,
      mixOutBar: null,
      exitKind: quiet ? "quietTail" : "dropLanding",
      phraseShape: quiet ? "complementary" : "landing",
    };
  }
  const candidates = phraseBoundaries(origin, endBar).filter((bar) => bar + barCount <= endBar);
  const usable = candidates.length > 0 ? candidates : phraseBoundaries(origin, endBar);
  let quietBar: number | null = null;
  for (const bar of [...usable].reverse()) {
    const section =
      sections.find((item) => item.startBar === bar) ??
      sectionAtBar(sections, bar, bpm, downbeats, audioStart);
    if (
      section &&
      (section.type === "outro" || section.type === "breakdown") &&
      relEnergy(section, sections) <= QUIET &&
      (section.startBar == null || Math.abs(section.startBar - bar) < 0.51)
    ) {
      quietBar = bar;
      break;
    }
  }
  if (quietBar != null) {
    return {
      mixOutMs: barToMs(quietBar, sections, bpm, downbeats, audioStart),
      mixOutBar: quietBar,
      exitKind: "quietTail",
      phraseShape: "complementary",
    };
  }
  const drops = sections.filter((section) => section.type === "drop");
  const finalDrop = drops.at(-1);
  let landingBar: number | null = null;
  for (const bar of [...usable].reverse()) {
    const ms = barToMs(bar, sections, bpm, downbeats, audioStart);
    if (finalDrop && ms >= finalDrop.startMs && ms < finalDrop.endMs) {
      landingBar = bar;
      break;
    }
  }
  const chosen = landingBar ?? usable.at(-1) ?? origin;
  return {
    mixOutMs: barToMs(chosen, sections, bpm, downbeats, audioStart),
    mixOutBar: chosen,
    exitKind: "dropLanding",
    phraseShape: "landing",
  };
}

export function phraseOriginMs(track: WindowTrack): number | null {
  const drop = firstDropSection(track.analysis?.sections ?? []);
  if (drop?.startBar == null || drop.startBar % 8 !== 0) {
    return null;
  }
  return drop.startMs;
}

export function bakeWindowAlignment(
  outgoing: WindowTrack,
  incoming: WindowTrack,
  window: PhraseWindow,
  options: { targetBpm?: number | null; outgoingRate?: number; incomingRate?: number } = {},
): PhraseWindow {
  const outDownbeats = outgoing.analysis?.downbeatTimesMs ?? [];
  const inDownbeats = incoming.analysis?.downbeatTimesMs ?? [];
  if (outDownbeats.length === 0 || inDownbeats.length === 0) {
    return {
      ...window,
      alignmentOffsetMs: window.alignmentOffsetMs,
      alignmentPeriodMs: window.alignmentPeriodMs,
      alignmentMode: window.alignmentMode,
    };
  }
  const targetBpm = options.targetBpm ?? incoming.analysis?.canonicalBpm ?? incoming.bpm;
  const outgoingRate = options.outgoingRate && options.outgoingRate > 0 ? options.outgoingRate : 1;
  const incomingRate = options.incomingRate && options.incomingRate > 0 ? options.incomingRate : 1;
  const aligned = planAlignmentOffsetMs({
    outgoingDownbeatsMs: outDownbeats,
    incomingDownbeatsMs: inDownbeats,
    outgoingOverlapStartMs: window.mixOutMs,
    incomingOverlapStartMs: window.mixInMs,
    bpm: targetBpm,
    outgoingRate,
    incomingRate,
    targetBpm,
    outgoingDownbeatConfidence: outgoing.analysis?.downbeatConfidence ?? null,
    incomingDownbeatConfidence: incoming.analysis?.downbeatConfidence ?? null,
    outgoingPhraseOriginMs: phraseOriginMs(outgoing),
    incomingPhraseOriginMs: phraseOriginMs(incoming),
  });
  const inStart = incoming.analysis?.audioStartMs ?? 0;
  const inEnd = incoming.analysis?.audioEndMs ?? incoming.durationMs;
  const nextMixIn = window.mixInMs + aligned.offsetMs;
  if (!window.dropAnchored && nextMixIn >= inStart && nextMixIn < inEnd - 1000) {
    return {
      ...window,
      mixInMs: Math.round(nextMixIn),
      alignmentOffsetMs: aligned.offsetMs,
      alignmentPeriodMs: aligned.periodMs,
      alignmentMode: aligned.mode,
    };
  }
  return {
    ...window,
    mixOutMs: Math.round(
      Math.max(
        0,
        window.mixOutMs -
          outputToSourceMs(sourceToOutputMs(aligned.offsetMs, incomingRate), outgoingRate),
      ),
    ),
    alignmentOffsetMs: aligned.offsetMs,
    alignmentPeriodMs: aligned.periodMs,
    alignmentMode: aligned.mode,
  };
}

function incomingHeadRelEnergy(incoming: WindowTrack, mixInMs: number, bpm: number | null): number {
  const sections = incoming.analysis?.sections ?? [];
  const headMs = mixInMs + barMsFor(bpm) * PHRASE;
  const head = sectionAtMs(sections, mixInMs) ?? sectionAtMs(sections, (mixInMs + headMs) / 2);
  return relEnergy(head, sections);
}

/** Play through a late-only drop, then leave on the remaining tail. */
function lateTailExit(
  outgoing: WindowTrack,
  barCount: PhraseBarCount,
  targetBpm: number | null,
): ReturnType<typeof pickOutgoingExit> | null {
  const analysis = outgoing.analysis;
  const sections = analysis?.sections ?? [];
  const drop = firstDropSection(sections);
  if (lateDropMinPlayableMs(outgoing.durationMs, drop?.startMs) == null) {
    return null;
  }
  const bpm = targetBpm ?? analysis?.canonicalBpm ?? outgoing.bpm;
  const audioStart = analysis?.audioStartMs ?? 0;
  const audioEnd = analysis?.audioEndMs ?? outgoing.durationMs;
  const overlap = barCount * barMsFor(bpm);
  const mixOutMs = Math.round(Math.max(drop?.endMs ?? drop?.startMs ?? 0, audioEnd - overlap));
  if (mixOutMs + overlap > audioEnd + 1) {
    return {
      mixOutMs: Math.round(audioEnd - overlap),
      mixOutBar: audioEndBar(sections, audioEnd, bpm, audioStart) - barCount,
      exitKind: "dropLanding",
      phraseShape: "landing",
    };
  }
  const at = sectionAtMs(sections, mixOutMs);
  const quiet =
    relEnergy(at, sections) <= QUIET &&
    (at?.type === "outro" || at?.type === "breakdown" || at?.type === "bridge");
  return {
    mixOutMs,
    mixOutBar: audioEndBar(sections, mixOutMs, bpm, audioStart),
    exitKind: quiet ? "quietTail" : "dropLanding",
    phraseShape: quiet ? "complementary" : "landing",
  };
}

/** End the overlap at a late active phrase boundary, before the quiet tail starts. */
function activeExits(
  outgoing: WindowTrack,
  bars: PhraseBarCount,
): ReturnType<typeof pickOutgoingExit>[] {
  if (outgoing.analysis?.manualMixOutMs != null) return [];
  const analysis = outgoing.analysis;
  const sections = analysis?.sections ?? [];
  const drop = sections.filter((item) => item.type === "drop").at(-1);
  if (drop?.startBar == null || drop.endBar == null) return [];
  const bpm = analysis?.bpm ?? analysis?.canonicalBpm ?? outgoing.bpm;
  const downbeats = analysis?.downbeatTimesMs ?? [];
  const start = analysis?.audioStartMs ?? 0;
  // Two late alternatives retain the featured body; never reach back into earlier breakdowns.
  return phraseBoundaries(drop.startBar, drop.endBar)
    .reverse()
    .filter((end) => end - bars >= drop.startBar!)
    .slice(0, 2)
    .map((end) => ({
      mixOutMs: barToMs(end - bars, sections, bpm, downbeats, start),
      mixOutBar: end - bars,
      exitKind: "dropLanding",
      phraseShape: "landing",
    }));
}

function relativeWindowBars(track: WindowTrack, startBar: number, count: number) {
  const analysis = track.analysis;
  const raw = analysis?.bars?.rms;
  const valid = raw?.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const reference = valid?.[Math.floor((valid.length - 1) * 0.9)] ?? 0;
  const sections = analysis?.sections ?? [];
  return {
    rms: Array.from({ length: count }, (_, i) => {
      const value = raw?.[startBar + i];
      if (reference > 1e-6 && value != null && Number.isFinite(value) && value >= 0)
        return Math.min(1.5, value / reference);
      return Math.min(
        1.5,
        relEnergy(
          sectionAtBar(
            sections,
            startBar + i + 0.5,
            analysis?.bpm ?? analysis?.canonicalBpm ?? track.bpm,
            analysis?.downbeatTimesMs ?? [],
            analysis?.audioStartMs ?? 0,
          ),
          sections,
        ),
      );
    }),
  };
}

export function planPhraseWindow(
  outgoing: WindowTrack,
  incoming: WindowTrack,
  options: {
    dropAnchored?: boolean;
    targetBpm?: number | null;
    outgoingRate?: number;
    incomingRate?: number;
    maxBars?: PhraseBarCount;
    outgoingSourceStartMs?: number;
    outgoingHeadEndMs?: number;
  } = {},
): PhraseWindow {
  const dropAnchored = options.dropAnchored !== false;
  const inAnalysis = incoming.analysis;
  const outAnalysis = outgoing.analysis;
  const inSections = inAnalysis?.sections ?? [];
  const inBpm = inAnalysis?.bpm ?? inAnalysis?.canonicalBpm ?? incoming.bpm;
  const outBpm = outAnalysis?.bpm ?? outAnalysis?.canonicalBpm ?? outgoing.bpm;
  const inStart = inAnalysis?.audioStartMs ?? 0;
  const inDownbeats = inAnalysis?.downbeatTimesMs ?? [];
  const drop = firstDropSection(inSections);
  const incomingDropMs = drop?.startMs ?? null;

  if (!dropAnchored || drop?.startBar == null) {
    const mixIn = pickMixIn({
      track: { id: incoming.id, durationMs: incoming.durationMs },
      analysis: {
        sections: inSections,
        downbeatTimesMs: inDownbeats,
        descriptors: {
          audioStartMs: inAnalysis?.audioStartMs ?? null,
          audioEndMs: inAnalysis?.audioEndMs ?? null,
        },
      },
      cues: incoming.cues ?? [],
    });
    const mixOut = pickOutgoingExit(outgoing, options.maxBars ?? 16, outBpm);
    const manualIn = incoming.analysis?.manualMixInMs;
    return bakeWindowAlignment(
      outgoing,
      incoming,
      {
        mixInMs: avoidSourceZero(
          manualIn != null && Number.isFinite(manualIn) ? Math.round(manualIn) : mixIn.ms,
          inDownbeats,
          inStart,
        ),
        mixOutMs: mixOut.mixOutMs,
        mixInBar: null,
        mixOutBar: mixOut.mixOutBar,
        barCount: options.maxBars ?? 16,
        exitKind: mixOut.exitKind,
        phraseShape: mixOut.phraseShape,
        incomingDropMs,
        dropAnchored: false,
        alignmentOffsetMs: 0,
        alignmentPeriodMs: null,
        alignmentMode: null,
      },
      { ...options, targetBpm: options.targetBpm ?? inBpm },
    );
  }

  const dropBar = drop.startBar;
  const candidates: Array<{
    mixInBar: number;
    barCount: PhraseBarCount;
    mixInMs: number;
    exit: ReturnType<typeof pickOutgoingExit>;
  }> = [];

  for (const barCount of [32, 16, 8] as PhraseBarCount[]) {
    if (barCount > (options.maxBars ?? 32)) continue;
    if (barCount === 8 && options.maxBars !== 8 && dropBar >= 16) continue;
    if (dropBar < barCount) {
      continue;
    }
    const mixInBar = dropBar - barCount;
    const at = sectionAtBar(inSections, mixInBar, inBpm, inDownbeats, inStart);
    if (!introBuildAt(at)) {
      continue;
    }
    // Weak 32-bar builds that only meet the drop at the cut stay thin; prefer a later 16.
    if (barCount === 32 && mixInBar === dropBar - 32 && (at?.sectionEnergy ?? 0) < 0.28) {
      continue;
    }
    candidates.push({
      mixInBar,
      barCount,
      mixInMs: barToMs(mixInBar, inSections, inBpm, inDownbeats, inStart),
      exit: pickOutgoingExit(outgoing, barCount, outBpm),
    });
    for (const exit of activeExits(outgoing, barCount)) {
      candidates.push({
        mixInBar,
        barCount,
        mixInMs: barToMs(mixInBar, inSections, inBpm, inDownbeats, inStart),
        exit,
      });
    }
  }

  const outSections = outAnalysis?.sections ?? [];
  for (const bars of [16, 32] as PhraseBarCount[]) {
    if (bars > (options.maxBars ?? 32) || dropBar < bars) continue;
    const tail = lateTailExit(outgoing, bars, outBpm);
    if (!tail) continue;
    candidates.push({
      mixInBar: dropBar - bars,
      barCount: bars,
      mixInMs: barToMs(dropBar - bars, inSections, inBpm, inDownbeats, inStart),
      exit: tail,
    });
  }
  const minFeatured =
    lateDropMinPlayableMs(outgoing.durationMs, firstDropSection(outSections)?.startMs) ??
    MIN_PLAYABLE_DURATION_MS;
  const feasibleCandidates = candidates.filter((item) => {
    const overlap =
      item.barCount * barMsFor(options.targetBpm ?? inBpm) * (options.outgoingRate ?? 1);
    const end = item.exit.mixOutMs + overlap;
    const start =
      options.outgoingSourceStartMs ?? outAnalysis?.manualMixInMs ?? outAnalysis?.audioStartMs ?? 0;
    return (
      end <= (outAnalysis?.audioEndMs ?? outgoing.durationMs) + 1 &&
      end - start >= Math.min(minFeatured, outgoing.durationMs) &&
      item.exit.mixOutMs > (options.outgoingHeadEndMs ?? start)
    );
  });
  let chosen =
    pickHandoffCandidate(
      feasibleCandidates.map((item) => {
        const incomingHeadEnergy = incomingHeadRelEnergy(incoming, item.mixInMs, inBpm);
        const phraseShape =
          item.exit.phraseShape === "landing"
            ? item.exit.phraseShape
            : incomingHeadEnergy >= KIT_ON
              ? "sequential"
              : item.exit.phraseShape;
        return {
          ...item,
          exitKind: item.exit.exitKind,
          phraseShape,
          incomingHeadEnergy,
          outgoingTailEnergy: relEnergy(sectionAtMs(outSections, item.exit.mixOutMs), outSections),
          mixOutBar: item.exit.mixOutBar,
          audioStartMs: inStart,
          incomingBars: relativeWindowBars(incoming, item.mixInBar, item.barCount),
          outgoingBars:
            item.exit.mixOutBar == null
              ? null
              : relativeWindowBars(outgoing, item.exit.mixOutBar, item.barCount),
        };
      }),
    ) ??
    feasibleCandidates.find((item) => item.exit.exitKind === "quietTail") ??
    candidates[0];

  if (!chosen) {
    const intro = inSections.find((section) => section.type === "intro");
    const mixInBar = intro?.startBar ?? 0;
    const barCount = Math.min(
      largestPhraseNotAfter(dropBar),
      options.maxBars ?? 32,
    ) as PhraseBarCount;
    chosen = {
      mixInBar,
      barCount,
      mixInMs: intro?.startMs ?? inStart,
      exit: pickOutgoingExit(outgoing, barCount, outBpm),
    };
  }

  const headRel = incomingHeadRelEnergy(incoming, chosen.mixInMs, inBpm);

  let phraseShape = chosen.exit.phraseShape;
  if (headRel >= KIT_ON && phraseShape !== "landing") {
    phraseShape = "sequential";
  }

  const incomingRate = options.incomingRate && options.incomingRate > 0 ? options.incomingRate : 1;
  const dropAnchoredMixIn = Math.max(
    inStart,
    incomingDropMs! -
      outputToSourceMs(chosen.barCount * barMsFor(options.targetBpm ?? inBpm), incomingRate),
  );
  const manualIn = incoming.analysis?.manualMixInMs;
  const mixInMs =
    manualIn != null && Number.isFinite(manualIn)
      ? Math.max(inStart, Math.round(manualIn))
      : dropAnchoredMixIn;
  return bakeWindowAlignment(
    outgoing,
    incoming,
    {
      // End-anchored landings keep the drop at overlap end.
      mixInMs: avoidSourceZero(mixInMs, inDownbeats, inStart),
      mixOutMs: chosen.exit.mixOutMs,
      mixInBar: chosen.mixInBar,
      mixOutBar: chosen.exit.mixOutBar,
      barCount: chosen.barCount,
      exitKind: chosen.exit.exitKind,
      phraseShape,
      incomingDropMs,
      dropAnchored: true,
      alignmentOffsetMs: 0,
      alignmentPeriodMs: null,
      alignmentMode: null,
      continuity: (() => {
        const scored = scoreHandoff({
          barCount: chosen.barCount,
          phraseShape,
          exitKind: chosen.exit.exitKind,
          incomingHeadEnergy: headRel,
          outgoingTailEnergy: relEnergy(
            sectionAtMs(outSections, chosen.exit.mixOutMs),
            outSections,
          ),
          incomingBars: relativeWindowBars(incoming, chosen.mixInBar, chosen.barCount),
          outgoingBars:
            chosen.exit.mixOutBar == null
              ? null
              : relativeWindowBars(outgoing, chosen.exit.mixOutBar, chosen.barCount),
        });
        return {
          energyFloor: scored.energyFloor,
          valleyBars: scored.valleyBars ?? 0,
          landingFadeBars: scored.landingFadeBars,
          coexistenceBars: scored.coexistenceBars ?? 0,
          evidence:
            inAnalysis?.bars?.rms.length && outAnalysis?.bars?.rms.length
              ? "relative-bar-energy-proxy"
              : "section-energy-proxy",
        };
      })(),
    },
    { ...options, targetBpm: options.targetBpm ?? inBpm },
  );
}

/** Output-time error: drop should land at overlap end. Null when landing is not intended. */
export function landingErrorMs(
  window: PhraseWindow,
  incomingRate: number,
  overlapMs: number,
): number | null {
  if (window.incomingDropMs == null || !window.dropAnchored) {
    return null;
  }
  const rate = incomingRate > 0 ? incomingRate : 1;
  return sourceToOutputMs(window.incomingDropMs - window.mixInMs, rate) - overlapMs;
}
