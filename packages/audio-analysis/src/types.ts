import type { CuePointType } from "@dnb-crate/domain";

export type PcmAudio = {
  samples: Float32Array;
  sampleRateHz: number;
  durationMs: number;
  channels: number;
};

export type AnalyzerCue = {
  type: CuePointType;
  positionMs: number;
  confidence: number;
};

export type AnalyzerResult = {
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
  lowBandEnergy: number | null;
  midBandEnergy: number | null;
  highBandEnergy: number | null;
  waveformSummary: number[];
  suggestedCues: AnalyzerCue[];
};

export type AnalyzeOptions = {
  durationMs?: number;
  beatAnchorMs?: number | null;
  dnbBpmMin?: number;
  dnbBpmMax?: number;
};

export type AudioAnalyzer = {
  readonly name: string;
  readonly version: string;
  analyze: (pcm: PcmAudio, options?: AnalyzeOptions) => AnalyzerResult;
};
