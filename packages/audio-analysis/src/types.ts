import type {
  CuePointType,
  TrackSection,
  SonicDescriptors,
  MusicalKeyEstimate,
} from "@dnb-crate/domain";

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
  gridSource: "analyzed" | "reference" | "anchor" | "sidecar";
  musicalKey: string | null;
  keyConfidence: number | null;
  keyMode: "major" | "minor" | null;
  camelotKey: string | null;
  keyRunnerUp: string | null;
  keyCandidates?: string[] | null;
  tempoStability: number | null;
  downbeatConfidence: number | null;
  lowBandEnergy: number | null;
  midBandEnergy: number | null;
  highBandEnergy: number | null;
  waveformSummary: number[];
  suggestedCues: AnalyzerCue[];
  sections: TrackSection[];
  descriptors: SonicDescriptors | null;
  engineRuntimeMs: number | null;
};

export type AnalyzeOptions = {
  durationMs?: number;
  beatAnchorMs?: number | null;
  dnbBpmMin?: number;
  dnbBpmMax?: number;
  /** Published/manual BPM. Folded into 160–190 before the lock; never writes canonical values. */
  referenceBpm?: number | null;
};

export type AudioAnalyzer = {
  readonly name: string;
  readonly version: string;
  analyze: (pcm: PcmAudio, options?: AnalyzeOptions) => AnalyzerResult;
};

export const emptyDescriptors = (waveform: number[] = []): SonicDescriptors => ({
  integratedLufs: null,
  shortTermLufsMean: null,
  shortTermLufsMax: null,
  truePeakDb: null,
  subBassRatio: null,
  brightness: null,
  onsetDensity: null,
  dynamicRange: null,
  dropIntensity: null,
  suggestedEnergy: null,
  energy: null,
  danceability: null,
  acousticness: null,
  melodicness: null,
  valence: null,
  waveformSummary: waveform,
  lowBandEnergy: null,
  midBandEnergy: null,
  highBandEnergy: null,
  chromaVector: null,
  tempoEvidence: null,
  bars: null,
  keyCandidates: null,
});

export type { TrackSection, SonicDescriptors, MusicalKeyEstimate };
