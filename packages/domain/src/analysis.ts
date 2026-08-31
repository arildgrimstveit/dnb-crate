import {
  DEFAULT_BASS_CROSSOVER_HZ,
  DEFAULT_BASS_LOW_ATTENUATION_DB,
  DEFAULT_BASS_SWAP_RAMP_MS,
  MAX_BASS_CROSSOVER_HZ,
  MAX_BASS_SWAP_RAMP_MS,
  MIN_BASS_CROSSOVER_HZ,
  MIN_BASS_SWAP_RAMP_MS,
} from "./constants.ts";
import type { BpmSource, CuePointType, KeySource } from "./track.ts";
import type { TransitionType } from "./planning.ts";

export type TrackAnalysis = {
  trackId: string;
  analyzerName: string;
  analyzerVersion: string;
  bpm: number | null;
  bpmConfidence: number | null;
  bpmRaw: number | null;
  beatTimesMs: number[];
  downbeatTimesMs: number[];
  gridRejected: boolean;
  gridRejectionReason: string | null;
  musicalKey: string | null;
  keyConfidence: number | null;
  integratedLufs: number | null;
  truePeakDb: number | null;
  lowBandEnergy: number | null;
  midBandEnergy: number | null;
  highBandEnergy: number | null;
  waveformSummary: number[] | null;
  beatAnchorMs: number | null;
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
  completedTrackIds: string[];
  failedTrackIds: string[];
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type AutomationEvent = {
  atMs: number;
  durationMs: number;
  target: "outgoing_low" | "incoming_low" | "outgoing_high" | "incoming_high" | "playback_rate";
  action: "fade_in" | "fade_out" | "set";
  value: number;
};

export type BassSwapParams = {
  crossoverHz: number;
  swapAtBar: number;
  rampMs: number;
  lowAttenuationDb: number;
};

export type TransitionProposal = {
  type: Exclude<TransitionType, "double_drop">;
  barCount: 16 | 32 | null;
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

export type TrackAnalysisView = TrackAnalysis & {
  canonicalBpm: number | null;
  canonicalBpmSource: BpmSource | null;
  canonicalKey: string | null;
  canonicalKeySource: KeySource | null;
  suggestedCues: SuggestedCue[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampBassSwapParams(
  input: Partial<BassSwapParams> | null | undefined,
  barCount: 16 | 32,
): BassSwapParams {
  const defaultSwap = barCount === 32 ? 16 : 8;
  const swapRaw = input?.swapAtBar ?? defaultSwap;
  const swapAtBar = swapRaw > 0 && swapRaw < barCount && swapRaw % 4 === 0 ? swapRaw : defaultSwap;
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
  };
}

export function resolveCanonicalBpm(
  track: { bpm: number | null; bpmSource: BpmSource | null },
  analysis: { bpm: number | null; gridRejected: boolean } | null,
): { bpm: number | null; source: BpmSource | null } {
  if (track.bpmSource === "manual" && track.bpm !== null) {
    return { bpm: track.bpm, source: "manual" };
  }
  if (analysis && !analysis.gridRejected && analysis.bpm !== null) {
    return { bpm: analysis.bpm, source: "analyzed" };
  }
  if (track.bpm !== null) {
    return { bpm: track.bpm, source: track.bpmSource };
  }
  return { bpm: null, source: null };
}

export function resolveCanonicalKey(
  track: { musicalKey: string | null; keySource: KeySource | null },
  analysis: { musicalKey: string | null; keyConfidence: number | null } | null,
): { musicalKey: string | null; source: KeySource | null } {
  if (track.keySource === "manual" && track.musicalKey !== null) {
    return { musicalKey: track.musicalKey, source: "manual" };
  }
  if (analysis?.musicalKey && (analysis.keyConfidence ?? 0) >= 0.5) {
    return { musicalKey: analysis.musicalKey, source: "analyzed" };
  }
  if (track.musicalKey !== null) {
    return { musicalKey: track.musicalKey, source: track.keySource };
  }
  return { musicalKey: null, source: null };
}
