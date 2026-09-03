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
import type { AnalysisEngineId, BpmSource, CuePointType, KeySource } from "./track.ts";
import type { TransitionType } from "./planning.ts";

export type TrackSectionType =
  | "intro"
  | "build"
  | "drop"
  | "breakdown"
  | "bridge"
  | "outro";

export type TrackSection = {
  type: TrackSectionType;
  startMs: number;
  endMs: number;
  startBar: number | null;
  endBar: number | null;
  confidence: number;
  sectionEnergy: number;
};

export type BeatGrid = {
  bpm: number | null;
  beatTimesMs: number[];
  downbeatTimesMs: number[];
  tempoConfidence: number | null;
  downbeatConfidence: number | null;
  tempoStability: number | null;
  gridRejected: boolean;
  gridRejectionReason: string | null;
};

export type MusicalKeyEstimate = {
  tonic: string | null;
  mode: "major" | "minor" | null;
  musicalKey: string | null;
  camelotKey: string | null;
  confidence: number | null;
  runnerUp: string | null;
};

export type TempoEvidence = {
  prominence: number;
  stability: number;
  tempoConf: number;
  onGridRatio: number;
};

export type SonicDescriptors = {
  integratedLufs: number | null;
  shortTermLufsMean: number | null;
  shortTermLufsMax: number | null;
  truePeakDb: number | null;
  subBassRatio: number | null;
  brightness: number | null;
  onsetDensity: number | null;
  dynamicRange: number | null;
  dropIntensity: number | null;
  suggestedEnergy: number | null;
  energy: number | null;
  danceability: number | null;
  acousticness: number | null;
  melodicness: number | null;
  valence: number | null;
  waveformSummary: number[];
  lowBandEnergy: number | null;
  midBandEnergy: number | null;
  highBandEnergy: number | null;
  chromaVector: number[] | null;
  tempoEvidence: TempoEvidence | null;
  audioStartMs?: number | null;
  audioEndMs?: number | null;
  bars?: {
    rms: number[];
    sub: number[];
    midFlux: number[];
    onsetDensity: number[];
  } | null;
};

export type TrackAnalysis = {
  trackId: string;
  analyzerName: string;
  analyzerVersion: string;
  bpm: number | null;
  bpmConfidence: number | null;
  bpmRaw: number | null;
  referenceBpm?: number | null;
  beatTimesMs: number[];
  downbeatTimesMs: number[];
  gridRejected: boolean;
  gridRejectionReason: string | null;
  gridSource?: "analyzed" | "reference" | "anchor" | null;
  musicalKey: string | null;
  keyConfidence: number | null;
  keyMode: "major" | "minor" | null;
  camelotKey: string | null;
  tempoStability: number | null;
  downbeatConfidence: number | null;
  integratedLufs: number | null;
  truePeakDb: number | null;
  lowBandEnergy: number | null;
  midBandEnergy: number | null;
  highBandEnergy: number | null;
  waveformSummary: number[] | null;
  beatAnchorMs: number | null;
  descriptors: SonicDescriptors | null;
  engineRuntimeMs: number | null;
  analyzedAt: string;
};

export type SuggestedCue = {
  type: CuePointType;
  positionMs: number;
  beatIndex: number | null;
  barIndex: number | null;
  confidence: number;
};

export type AnalysisJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type AnalysisJob = {
  id: string;
  status: AnalysisJobStatus;
  progress: number;
  trackIds: string[];
  engines: AnalysisEngineId[];
  completedTrackIds: string[];
  failedTrackIds: string[];
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type AutomationTarget =
  | "outgoing_low"
  | "outgoing_mid"
  | "outgoing_high"
  | "incoming_low"
  | "incoming_mid"
  | "incoming_high"
  | "playback_rate";

export type AutomationEvent = {
  target: AutomationTarget;
  action: "ramp" | "set";
  atBar?: number;
  durationBars?: number;
  atMs?: number;
  durationMs?: number;
  fromDb: number | null;
  toDb: number | null;
};

export type BassSwapParams = {
  crossoverHz: number;
  swapAtBar: number;
  rampMs: number;
  lowAttenuationDb: number;
  midDipDb?: number;
  lowHandoverBar?: number;
};

export type TransitionProposal = {
  type: Exclude<TransitionType, "double_drop">;
  barCount: 8 | 16 | 32 | null;
  durationMs: number;
  targetBpm: number | null;
  outgoingTrackId: string;
  incomingTrackId: string;
  outgoingCueType: CuePointType | null;
  incomingCueType: CuePointType | null;
  outgoingCuePositionMs: number | null;
  incomingCuePositionMs: number | null;
  outgoingPlaybackRate: number;
  incomingPlaybackRate: number;
  outgoingSourceStartMs: number;
  outgoingSourceEndMs: number;
  incomingSourceStartMs: number;
  incomingSourceEndMs: number;
  bassSwap: BassSwapParams | null;
  automation: AutomationEvent[];
  score: number;
  confidence: number;
  feasible: boolean;
  reasons: string[];
  blockers: string[];
};

export type TransitionValidation = {
  valid: boolean;
  feasible: boolean;
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
};

export type BeatGridSummary = {
  bpm: number | null;
  bpmConfidence: number | null;
  beatCount: number;
  firstDownbeatMs: number | null;
  downbeatConfidence: number | null;
  tempoStability: number | null;
  gridRejected: boolean;
  gridRejectionReason: string | null;
  gridSource?: "analyzed" | "reference" | "anchor" | null;
};

export type TrackAnalysisView = TrackAnalysis & {
  canonicalBpm: number | null;
  canonicalBpmSource: BpmSource | null;
  canonicalKey: string | null;
  canonicalKeySource: KeySource | null;
  suggestedCues: SuggestedCue[];
  sections: TrackSection[];
  availableEngines: string[];
  gridSummary: BeatGridSummary;
  bpmHint: number | null;
  bpmHintConfidence: number | null;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampBassSwapParams(
  input: Partial<BassSwapParams> | null | undefined,
  barCount: 8 | 16 | 32,
): BassSwapParams {
  const defaultSwap = barCount === 32 ? 16 : barCount === 8 ? 4 : 8;
  const swapRaw = input?.swapAtBar ?? defaultSwap;
  const step = barCount === 8 ? 2 : 4;
  const swapAtBar = swapRaw > 0 && swapRaw < barCount && swapRaw % step === 0 ? swapRaw : defaultSwap;
  return {
    crossoverHz: clamp(
      input?.crossoverHz ?? DEFAULT_BASS_CROSSOVER_HZ,
      MIN_BASS_CROSSOVER_HZ,
      MAX_BASS_CROSSOVER_HZ,
    ),
    swapAtBar,
    rampMs: Math.round(
      clamp(
        input?.rampMs ?? DEFAULT_BASS_SWAP_RAMP_MS,
        MIN_BASS_SWAP_RAMP_MS,
        MAX_BASS_SWAP_RAMP_MS,
      ),
    ),
    lowAttenuationDb: clamp(input?.lowAttenuationDb ?? DEFAULT_BASS_LOW_ATTENUATION_DB, -36, 0),
    midDipDb: clamp(input?.midDipDb ?? DEFAULT_MID_DIP_DB, -24, 0),
    lowHandoverBar: input?.lowHandoverBar,
  };
}

/** Precedence: manual > published > analyzed > tag. */
export function resolveCanonicalBpm(
  track: { bpm: number | null; bpmSource: BpmSource | null },
  analysis: { bpm: number | null; gridRejected: boolean } | null,
): { bpm: number | null; source: BpmSource | null } {
  if (track.bpmSource === "manual" && track.bpm !== null) {
    return { bpm: track.bpm, source: "manual" };
  }
  if (track.bpmSource === "published" && track.bpm !== null) {
    return { bpm: track.bpm, source: "published" };
  }
  if (analysis && !analysis.gridRejected && analysis.bpm !== null) {
    return { bpm: analysis.bpm, source: "analyzed" };
  }
  if (track.bpm !== null) {
    return { bpm: track.bpm, source: track.bpmSource };
  }
  return { bpm: null, source: null };
}

/** Precedence: manual > published > analyzed > tag. */
export function resolveCanonicalKey(
  track: { musicalKey: string | null; keySource: KeySource | null },
  analysis: { musicalKey: string | null; keyConfidence: number | null } | null,
): { musicalKey: string | null; source: KeySource | null } {
  if (track.keySource === "manual" && track.musicalKey !== null) {
    return { musicalKey: track.musicalKey, source: "manual" };
  }
  if (track.keySource === "published" && track.musicalKey !== null) {
    return { musicalKey: track.musicalKey, source: "published" };
  }
  if (analysis?.musicalKey && (analysis.keyConfidence ?? 0) >= 0.5) {
    return { musicalKey: analysis.musicalKey, source: "analyzed" };
  }
  if (track.musicalKey !== null) {
    return { musicalKey: track.musicalKey, source: track.keySource };
  }
  return { musicalKey: null, source: null };
}

export function buildBeatGridSummary(analysis: TrackAnalysis): BeatGridSummary {
  return {
    bpm: analysis.bpm,
    bpmConfidence: analysis.bpmConfidence,
    beatCount: analysis.beatTimesMs.length,
    firstDownbeatMs: analysis.downbeatTimesMs[0] ?? null,
    downbeatConfidence: analysis.downbeatConfidence,
    tempoStability: analysis.tempoStability,
    gridRejected: analysis.gridRejected,
    gridRejectionReason: analysis.gridRejectionReason,
    gridSource: analysis.gridSource ?? "analyzed",
  };
}
