import {
  DEFAULT_TRANSITION_OVERLAP_MS,
  snapToNearestBeat,
  type CuePoint,
  type CuePointType,
  type TrackSection,
} from "@dnb-crate/domain";

const MIN_SECTION_ENERGY = 0.05;

export type MixCueBundle = {
  track: { id: string; durationMs: number };
  analysis: {
    sections?: TrackSection[] | null;
    downbeatTimesMs?: number[] | null;
    downbeatConfidence?: number | null;
    beatTimesMs?: number[] | null;
    descriptors?: { audioStartMs?: number | null; audioEndMs?: number | null } | null;
  } | null;
  cues: CuePoint[];
};

export type MixCuePick = {
  type: CuePointType | null;
  ms: number;
  inferred: boolean;
  reason: string | null;
  confidence: number | null;
};

export type MixInOptions = {
  preferredType?: "phrase_mix" | "bass_swap" | "crossfade" | "any";
  allowDropIn?: boolean;
};

export function audioBounds(bundle: MixCueBundle): { audioStartMs: number; audioEndMs: number } {
  const start = bundle.analysis?.descriptors?.audioStartMs;
  const end = bundle.analysis?.descriptors?.audioEndMs;
  return {
    audioStartMs: typeof start === "number" && start >= 0 ? Math.round(start) : 0,
    audioEndMs:
      typeof end === "number" && end > 0 ? Math.round(end) : bundle.track.durationMs,
  };
}

export function constrainMixOut(
  mixOutMs: number,
  _overlapSourceMs: number,
  audioEndMs: number,
  _downbeatTimesMs: number[],
): number {
  return Math.round(Math.min(Math.max(0, mixOutMs), audioEndMs));
}

export function pickMixOut(
  bundle: MixCueBundle,
  options: { overlapSourceMs?: number } = {},
): MixCuePick {
  const { audioEndMs } = audioBounds(bundle);
  const downbeats = (bundle.analysis?.downbeatTimesMs ?? []).filter((time) => time <= audioEndMs);
  const overlap = options.overlapSourceMs ?? DEFAULT_TRANSITION_OVERLAP_MS;

  const applyConstraint = (pick: MixCuePick): MixCuePick => {
    const ms = constrainMixOut(pick.ms, overlap, audioEndMs, downbeats);
    return ms === pick.ms ? pick : { ...pick, ms };
  };

  const manualOutro = cueByType(bundle.cues, "outro_start", "manual");
  if (manualOutro) {
    return applyConstraint({
      type: manualOutro.type,
      ms: manualOutro.positionMs,
      inferred: false,
      reason: null,
      confidence: manualOutro.confidence,
    });
  }

  const outro = firstEnergeticSection(bundle, "outro") ?? lastEnergeticSection(bundle, "breakdown");
  if (outro) {
    return applyConstraint({
      type: outro.type,
      ms: outro.positionMs,
      inferred: true,
      reason: `Outgoing ${outro.type} cue is analyzer-derived (confidence ${(outro.confidence ?? 0).toFixed(2)})`,
      confidence: outro.confidence,
    });
  }

  const analyzedOutro = cueByType(bundle.cues, "outro_start", "analyzed");
  if (analyzedOutro && sectionIsEnergetic(bundle, analyzedOutro.positionMs)) {
    return applyConstraint({
      type: analyzedOutro.type,
      ms: analyzedOutro.positionMs,
      inferred: true,
      reason: `Outgoing outro cue is analyzer-derived (confidence ${(analyzedOutro.confidence ?? 0).toFixed(2)})`,
      confidence: analyzedOutro.confidence,
    });
  }

  if (downbeats.length > 4) {
    return applyConstraint({
      type: null,
      ms: downbeats[Math.max(0, downbeats.length - 8)] ?? 0,
      inferred: true,
      reason: "Outgoing mix-out inferred from the last eight downbeats",
      confidence: bundle.analysis?.downbeatConfidence ?? null,
    });
  }

  return applyConstraint({
    type: null,
    ms: Math.max(0, audioEndMs - overlap),
    inferred: true,
    reason: "Outgoing mix-out inferred from duration minus overlap",
    confidence: null,
  });
}

export function pickMixIn(bundle: MixCueBundle, options: MixInOptions = {}): MixCuePick {
  const { audioStartMs } = audioBounds(bundle);
  const allowDrop = options.preferredType === "bass_swap" && options.allowDropIn === true;

  const manualIntro = cueByType(bundle.cues, "intro_start", "manual");
  if (manualIntro) {
    return {
      type: manualIntro.type,
      ms: Math.max(audioStartMs, manualIntro.positionMs),
      inferred: false,
      reason: null,
      confidence: manualIntro.confidence,
    };
  }

  if (allowDrop) {
    const drop = cueByType(bundle.cues, "drop", "manual") ?? firstEnergeticSection(bundle, "drop");
    if (drop) {
      return {
        type: drop.type,
        ms: Math.max(audioStartMs, drop.positionMs),
        inferred: drop.source !== "manual",
        reason:
          drop.source === "manual"
            ? null
            : `Incoming drop cue is analyzer-derived (confidence ${(drop.confidence ?? 0).toFixed(2)})`,
        confidence: drop.confidence,
      };
    }
  }

  const intro = firstEnergeticSection(bundle, "intro");
  if (intro) {
    return {
      type: intro.type,
      ms: Math.max(audioStartMs, intro.positionMs),
      inferred: true,
      reason: `Incoming intro cue is analyzer-derived (confidence ${(intro.confidence ?? 0).toFixed(2)})`,
      confidence: intro.confidence,
    };
  }

  const analyzedIntro = cueByType(bundle.cues, "intro_start", "analyzed");
  if (analyzedIntro && sectionIsEnergetic(bundle, analyzedIntro.positionMs)) {
    return {
      type: analyzedIntro.type,
      ms: Math.max(audioStartMs, analyzedIntro.positionMs),
      inferred: true,
      reason: `Incoming intro cue is analyzer-derived (confidence ${(analyzedIntro.confidence ?? 0).toFixed(2)})`,
      confidence: analyzedIntro.confidence,
    };
  }

  const downbeats = (bundle.analysis?.downbeatTimesMs ?? []).filter((time) => time >= audioStartMs);
  if (downbeats.length > 0) {
    return {
      type: null,
      ms: downbeats[0] ?? audioStartMs,
      inferred: true,
      reason: "Incoming mix-in inferred from the first downbeat",
      confidence: bundle.analysis?.downbeatConfidence ?? null,
    };
  }

  return {
    type: null,
    ms: audioStartMs,
    inferred: true,
    reason: "Incoming mix-in inferred at 0ms",
    confidence: null,
  };
}

export function sectionEnergyAt(sections: TrackSection[] | null | undefined, ms: number): number | null {
  const hit = (sections ?? []).find((section) => ms >= section.startMs && ms < section.endMs)
    ?? (sections ?? []).find((section) => ms === section.endMs);
  return hit?.sectionEnergy ?? null;
}

function cueByType(
  cues: CuePoint[],
  type: CuePointType,
  source?: CuePoint["source"],
): CuePoint | undefined {
  return cues.find((cue) => cue.type === type && (source === undefined || cue.source === source));
}

function energetic(section: TrackSection | undefined): section is TrackSection {
  return section != null && section.sectionEnergy >= MIN_SECTION_ENERGY;
}

function sectionToCue(
  bundle: MixCueBundle,
  section: TrackSection,
  type: "intro" | "outro" | "breakdown" | "drop",
): CuePoint {
  return {
    id: `${type}-section`,
    trackId: bundle.track.id,
    type: type === "intro" ? "intro_start" : type === "outro" ? "outro_start" : type,
    positionMs: section.startMs,
    beatIndex: null,
    barIndex: section.startBar,
    confidence: section.confidence,
    source: "analyzed",
    label: null,
  };
}

function firstEnergeticSection(
  bundle: MixCueBundle,
  type: "intro" | "outro" | "breakdown" | "drop",
): CuePoint | undefined {
  const section = (bundle.analysis?.sections ?? []).find((item) => item.type === type && energetic(item));
  return section ? sectionToCue(bundle, section, type) : undefined;
}

function lastEnergeticSection(
  bundle: MixCueBundle,
  type: "intro" | "outro" | "breakdown" | "drop",
): CuePoint | undefined {
  const matches = (bundle.analysis?.sections ?? []).filter((item) => item.type === type && energetic(item));
  const section = matches.at(-1);
  return section ? sectionToCue(bundle, section, type) : undefined;
}

function sectionIsEnergetic(bundle: MixCueBundle, ms: number): boolean {
  const energy = sectionEnergyAt(bundle.analysis?.sections, ms);
  return energy == null || energy >= MIN_SECTION_ENERGY;
}

export function snapMixMs(ms: number, beatTimesMs: number[]): number {
  return snapToNearestBeat(ms, beatTimesMs)?.positionMs ?? Math.round(ms);
}
