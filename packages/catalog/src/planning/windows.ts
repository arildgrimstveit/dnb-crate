import {
  sectionAtMs,
  snapToNearestBeat,
  type PhraseBarCount,
  type PhraseShape,
  type TrackSection,
} from "@dnb-crate/domain";

import { pickMixIn, pickMixOut } from "./cues.ts";

export type WindowTrack = {
  id: string;
  durationMs: number;
  bpm: number | null;
  analysis?: {
    sections: TrackSection[];
    canonicalBpm?: number | null;
    audioStartMs?: number | null;
    audioEndMs?: number | null;
    downbeatTimesMs?: number[];
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
};

const PHRASE = 8;
const QUIET = 0.5;
const KIT_ON = 0.5;

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

function firstDownbeatAfter(
  downbeats: number[],
  audioStartMs: number,
): number | null {
  const hit = downbeats.find((time) => time > audioStartMs + 1);
  return hit ?? downbeats[0] ?? null;
}

function avoidSourceZero(
  mixInMs: number,
  downbeats: number[],
  audioStartMs: number,
): number {
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
  if (origin == null) {
    const fallback = pickMixOut({
      track: { id: outgoing.id, durationMs: outgoing.durationMs },
      analysis: {
        sections,
        downbeatTimesMs: downbeats,
        descriptors: { audioStartMs: audioStart, audioEndMs: audioEnd },
      },
      cues: [],
    });
    const at = sectionAtMs(sections, fallback.ms);
    const quiet = relEnergy(at, sections) <= QUIET && (at?.type === "outro" || at?.type === "breakdown");
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

function incomingHeadRelEnergy(
  incoming: WindowTrack,
  mixInMs: number,
  bpm: number | null,
): number {
  const sections = incoming.analysis?.sections ?? [];
  const headMs = mixInMs + barMsFor(bpm) * PHRASE;
  const head = sectionAtMs(sections, mixInMs) ?? sectionAtMs(sections, (mixInMs + headMs) / 2);
  return relEnergy(head, sections);
}

export function planPhraseWindow(
  outgoing: WindowTrack,
  incoming: WindowTrack,
  options: { dropAnchored?: boolean; targetBpm?: number | null } = {},
): PhraseWindow {
  const dropAnchored = options.dropAnchored !== false;
  const inAnalysis = incoming.analysis;
  const outAnalysis = outgoing.analysis;
  const inSections = inAnalysis?.sections ?? [];
  const inBpm = options.targetBpm ?? inAnalysis?.canonicalBpm ?? incoming.bpm;
  const outBpm = options.targetBpm ?? outAnalysis?.canonicalBpm ?? outgoing.bpm;
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
      cues: [],
    });
    const mixOut = pickOutgoingExit(outgoing, 16, options.targetBpm ?? outBpm);
    return {
      mixInMs: avoidSourceZero(mixIn.ms, inDownbeats, inStart),
      mixOutMs: mixOut.mixOutMs,
      mixInBar: null,
      mixOutBar: mixOut.mixOutBar,
      barCount: 16,
      exitKind: mixOut.exitKind,
      phraseShape: mixOut.phraseShape,
      incomingDropMs,
      dropAnchored: false,
    };
  }

  const dropBar = drop.startBar;
  const candidates: Array<{
    mixInBar: number;
    barCount: PhraseBarCount;
    mixInMs: number;
    exit: ReturnType<typeof pickOutgoingExit>;
  }> = [];

  for (const barCount of [32, 16, 8] as PhraseBarCount[]) {
    if (dropBar < barCount) {
      continue;
    }
    const mixInBar = dropBar - barCount;
    const at = sectionAtBar(inSections, mixInBar, inBpm, inDownbeats, inStart);
    if (!introBuildAt(at)) {
      continue;
    }
    if (barCount === 32 && relEnergy(at, inSections) > QUIET) {
      continue;
    }
    candidates.push({
      mixInBar,
      barCount,
      mixInMs: barToMs(mixInBar, inSections, inBpm, inDownbeats, inStart),
      exit: pickOutgoingExit(outgoing, barCount, options.targetBpm ?? outBpm),
    });
  }

  let chosen = candidates.find((item) => item.exit.exitKind === "quietTail") ?? candidates[0];

  if (!chosen) {
    const intro = inSections.find((section) => section.type === "intro");
    const mixInBar = intro?.startBar ?? 0;
    const barCount = largestPhraseNotAfter(dropBar);
    chosen = {
      mixInBar,
      barCount,
      mixInMs: intro?.startMs ?? inStart,
      exit: pickOutgoingExit(outgoing, barCount, options.targetBpm ?? outBpm),
    };
  }

  let phraseShape = chosen.exit.phraseShape;
  const headRel = incomingHeadRelEnergy(incoming, chosen.mixInMs, inBpm);
  if (headRel >= KIT_ON && phraseShape !== "landing") {
    phraseShape = "sequential";
  } else if (headRel >= KIT_ON && chosen.barCount > 8 && phraseShape === "landing") {
    const mixInBar = dropBar - 8;
    chosen = {
      mixInBar,
      barCount: 8,
      mixInMs: barToMs(mixInBar, inSections, inBpm, inDownbeats, inStart),
      exit: pickOutgoingExit(outgoing, 8, options.targetBpm ?? outBpm),
    };
    phraseShape = chosen.exit.phraseShape === "landing" ? "landing" : "sequential";
  }

  return {
    mixInMs: avoidSourceZero(chosen.mixInMs, inDownbeats, inStart),
    mixOutMs: chosen.exit.mixOutMs,
    mixInBar: chosen.mixInBar,
    mixOutBar: chosen.exit.mixOutBar,
    barCount: chosen.barCount,
    exitKind: chosen.exit.exitKind,
    phraseShape,
    incomingDropMs,
    dropAnchored: true,
  };
}
