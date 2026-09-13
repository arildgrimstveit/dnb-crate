import { DomainError, type SonicDescriptors, type TrackSection } from "@dnb-crate/domain";

import type {
  AnalysisRepository,
  StoredTrackAnalysis,
  TrackEvidenceSelection,
} from "./analysis-repository.ts";

export type ResolvedTrackEvidence = {
  trackId: string;
  selection: TrackEvidenceSelection | null;
  rhythm: StoredTrackAnalysis | null;
  structure: StoredTrackAnalysis | null;
  key: StoredTrackAnalysis | null;
};

export type FrozenEvidenceRef = {
  rhythmEngine: string | null;
  structureEngine: string | null;
  keyEngine: string | null;
};

/** Snapshot of the analysis values used to plan or render. Absent stays absent. */
export type FrozenTrackEvidence = FrozenEvidenceRef & {
  present: boolean;
  analyzerName: string | null;
  analyzerVersion: string | null;
  bpm: number | null;
  bpmConfidence: number | null;
  gridRejected: boolean;
  beatTimesMs: number[];
  downbeatTimesMs: number[];
  downbeatConfidence: number | null;
  sections: TrackSection[];
  musicalKey: string | null;
  keyConfidence: number | null;
  camelotKey: string | null;
  audioEndMs: number | null;
  fileFingerprint: string | null;
  descriptors: SonicDescriptors | null;
};

export type FrozenRenderSettings = {
  sampleRateHz: number;
  edgeFadeMs: number;
  previewWindowMs: number;
  loudnessTargetLufs: number;
  truePeakCeilingDb: number;
  rendererVersion: string;
  audioEngineId: string;
  rubberbandAvailable: boolean;
  /** Frozen executable identity; execution must use this path, not a later worker default. */
  rubberbandCliPath: string | null;
  /** SHA-256 of the Rubber Band executable at queue time. */
  rubberbandSha256: string | null;
};

/** One snapshot of the selected rhythm, structure and key rows for a track. */
export function resolveTrackEvidence(
  analyses: AnalysisRepository,
  trackId: string,
): ResolvedTrackEvidence {
  const selection = analyses.getSelection(trackId);
  const rhythm = analyses.findByTrackId(trackId);
  const structure = selection?.structureEngine
    ? (analyses.findByTrackId(trackId, selection.structureEngine) ?? rhythm)
    : rhythm;
  const key = analyses.findKeyAnalysis(trackId) ?? rhythm;
  return { trackId, selection, rhythm, structure, key };
}

export function isFrozenSnapshot(
  value: FrozenEvidenceRef | FrozenTrackEvidence | undefined,
): value is FrozenTrackEvidence {
  return Boolean(value && "present" in value);
}

export function resolveFrozenEvidence(
  analyses: AnalysisRepository,
  trackId: string,
  frozen?: FrozenEvidenceRef | FrozenTrackEvidence,
): ResolvedTrackEvidence {
  if (isFrozenSnapshot(frozen)) {
    const analysis = analysisFromFrozen(trackId, frozen);
    return {
      trackId,
      selection: null,
      rhythm: analysis,
      structure: analysis,
      key: analysis,
    };
  }
  if (!frozen) {
    return resolveTrackEvidence(analyses, trackId);
  }
  const rhythm = frozen.rhythmEngine
    ? analyses.findByTrackId(trackId, frozen.rhythmEngine)
    : analyses.findByTrackId(trackId);
  const structure = frozen.structureEngine
    ? (analyses.findByTrackId(trackId, frozen.structureEngine) ?? rhythm)
    : rhythm;
  const key = frozen.keyEngine
    ? (analyses.findByTrackId(trackId, frozen.keyEngine) ?? rhythm)
    : (analyses.findKeyAnalysis(trackId) ?? rhythm);
  return { trackId, selection: null, rhythm, structure, key };
}

/** Rhythm grid and BPM, structure sections, key fields from their selected rows. */
export function analysisForTimeline(evidence: ResolvedTrackEvidence): StoredTrackAnalysis | null {
  if (!evidence.rhythm && !evidence.structure) {
    return null;
  }
  const rhythm = evidence.rhythm ?? evidence.structure!;
  const structure = evidence.structure ?? rhythm;
  const key = evidence.key ?? rhythm;
  return {
    ...rhythm,
    sections: structure.sections,
    musicalKey: key.musicalKey,
    keyConfidence: key.keyConfidence,
    keyMode: key.keyMode,
    camelotKey: key.camelotKey,
    keyCandidates: key.keyCandidates ?? rhythm.keyCandidates,
  };
}

export function snapshotTrackEvidence(
  analyses: AnalysisRepository,
  trackId: string,
  fileFingerprint: string | null,
): FrozenTrackEvidence {
  const resolved = resolveTrackEvidence(analyses, trackId);
  const merged = analysisForTimeline(resolved);
  if (!merged) {
    return {
      present: false,
      rhythmEngine: resolved.selection?.rhythmEngine ?? null,
      structureEngine: resolved.selection?.structureEngine ?? null,
      keyEngine: resolved.selection?.keyEngine ?? null,
      analyzerName: null,
      analyzerVersion: null,
      bpm: null,
      bpmConfidence: null,
      gridRejected: false,
      beatTimesMs: [],
      downbeatTimesMs: [],
      downbeatConfidence: null,
      sections: [],
      musicalKey: null,
      keyConfidence: null,
      camelotKey: null,
      audioEndMs: null,
      fileFingerprint,
      descriptors: null,
    };
  }
  return {
    present: true,
    rhythmEngine: resolved.rhythm?.analyzerName ?? null,
    structureEngine: resolved.structure?.analyzerName ?? null,
    keyEngine: resolved.key?.analyzerName ?? null,
    analyzerName: merged.analyzerName,
    analyzerVersion: merged.analyzerVersion,
    bpm: merged.bpm,
    bpmConfidence: merged.bpmConfidence,
    gridRejected: merged.gridRejected,
    beatTimesMs: [...merged.beatTimesMs],
    downbeatTimesMs: [...merged.downbeatTimesMs],
    downbeatConfidence: merged.downbeatConfidence,
    sections: structuredClone(merged.sections),
    musicalKey: merged.musicalKey,
    keyConfidence: merged.keyConfidence,
    camelotKey: merged.camelotKey,
    audioEndMs:
      typeof merged.descriptors?.audioEndMs === "number" ? merged.descriptors.audioEndMs : null,
    fileFingerprint,
    descriptors: merged.descriptors ? structuredClone(merged.descriptors) : null,
  };
}

export function analysisFromFrozen(
  trackId: string,
  frozen: FrozenTrackEvidence,
): StoredTrackAnalysis | null {
  if (!frozen.present) {
    return null;
  }
  return {
    trackId,
    analyzerName: frozen.analyzerName ?? "frozen",
    analyzerVersion: frozen.analyzerVersion ?? "frozen",
    bpm: frozen.bpm,
    bpmConfidence: frozen.bpmConfidence,
    bpmRaw: frozen.bpm,
    referenceBpm: null,
    beatTimesMs: frozen.beatTimesMs,
    downbeatTimesMs: frozen.downbeatTimesMs,
    gridRejected: frozen.gridRejected,
    gridRejectionReason: null,
    gridSource: "analyzed",
    musicalKey: frozen.musicalKey,
    keyConfidence: frozen.keyConfidence,
    keyMode: null,
    camelotKey: frozen.camelotKey,
    keyCandidates: frozen.descriptors?.keyCandidates ?? null,
    tempoStability: null,
    downbeatConfidence: frozen.downbeatConfidence,
    integratedLufs: frozen.descriptors?.integratedLufs ?? null,
    truePeakDb: frozen.descriptors?.truePeakDb ?? null,
    lowBandEnergy: frozen.descriptors?.lowBandEnergy ?? null,
    midBandEnergy: frozen.descriptors?.midBandEnergy ?? null,
    highBandEnergy: frozen.descriptors?.highBandEnergy ?? null,
    waveformSummary: frozen.descriptors?.waveformSummary ?? null,
    beatAnchorMs: null,
    descriptors: frozen.descriptors,
    engineRuntimeMs: null,
    analyzedAt: new Date(0).toISOString(),
    suggestedCues: [],
    sections: frozen.sections,
  };
}

export function evidenceRefOf(evidence: ResolvedTrackEvidence): FrozenEvidenceRef {
  return {
    rhythmEngine: evidence.rhythm?.analyzerName ?? null,
    structureEngine: evidence.structure?.analyzerName ?? null,
    keyEngine: evidence.key?.analyzerName ?? null,
  };
}

export function firstDropMsFromFrozen(
  evidence: Record<string, FrozenTrackEvidence | FrozenEvidenceRef>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const [trackId, row] of Object.entries(evidence)) {
    if (!isFrozenSnapshot(row) || !row.present) {
      continue;
    }
    const drop = row.sections.find((section) => section.type === "drop");
    if (drop && Number.isFinite(drop.startMs)) {
      map.set(trackId, drop.startMs);
    }
  }
  return map;
}

export function audioEndMsFromFrozen(
  evidence: Record<string, FrozenTrackEvidence | FrozenEvidenceRef>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const [trackId, row] of Object.entries(evidence)) {
    if (isFrozenSnapshot(row) && typeof row.audioEndMs === "number") {
      map.set(trackId, row.audioEndMs);
    }
  }
  return map;
}

export function keyConfidenceFromFrozen(
  evidence: Record<string, FrozenTrackEvidence | FrozenEvidenceRef>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const [trackId, row] of Object.entries(evidence)) {
    if (isFrozenSnapshot(row) && typeof row.keyConfidence === "number") {
      map.set(trackId, row.keyConfidence);
    }
  }
  return map;
}

export function assertEvidenceEnginesExist(
  analyses: AnalysisRepository,
  trackId: string,
  input: {
    rhythmEngine?: string | null;
    structureEngine?: string | null;
    keyEngine?: string | null;
  },
): void {
  const available = new Set(analyses.listByTrackId(trackId).map((row) => row.analyzerName));
  const roles: Array<["rhythm" | "structure" | "key", string | null | undefined]> = [
    ["rhythm", input.rhythmEngine],
    ["structure", input.structureEngine],
    ["key", input.keyEngine],
  ];
  for (const [role, engine] of roles) {
    if (engine && !available.has(engine)) {
      throw new DomainError(
        "ANALYSIS_ENGINE_UNAVAILABLE",
        `No ${role} analysis from engine ${engine}`,
      );
    }
  }
}
