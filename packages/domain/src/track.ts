export type BpmSource = "tag" | "manual" | "analyzed" | "published";
export type KeySource = "tag" | "manual" | "analyzed" | "published";
export type AnalysisStatus = "not_analyzed" | "pending" | "complete" | "failed";
export type AnalysisEngineId = "dnb-crate-dsp" | "dnb-crate-envelope" | "beat-this" | "allin1";

export type Track = {
  id: string;
  filePath: string;
  fileFingerprint: string;
  artist: string | null;
  title: string;
  album: string | null;
  durationMs: number;
  sampleRateHz: number | null;
  channels: number | null;
  bpm: number | null;
  bpmSource: BpmSource | null;
  musicalKey: string | null;
  camelotKey: string | null;
  keySource: KeySource | null;
  energy: number | null;
  rating: number | null;
  subgenres: string[];
  moods: string[];
  tags: string[];
  notes: string | null;
  analysisStatus: AnalysisStatus;
  fileMissing: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Track as returned by tools and resources. Source paths stay internal. */
export type PublicTrack = Omit<Track, "filePath">;

export type CuePointType =
  "intro_start" | "intro_end" | "drop" | "breakdown" | "outro_start" | "outro_end" | "custom";

export type CuePoint = {
  id: string;
  trackId: string;
  type: CuePointType;
  positionMs: number;
  beatIndex: number | null;
  barIndex: number | null;
  confidence: number | null;
  source: "manual" | "analyzed" | "imported";
  label: string | null;
};

export type TrackMetadataPatch = {
  energy?: number | null;
  rating?: number | null;
  moods?: string[];
  subgenres?: string[];
  tags?: string[];
  notes?: string | null;
  bpm?: number | null;
  /** When setting bpm, defaults to "manual". Pass "published" for store/label lookups. */
  bpmSource?: "manual" | "published";
  musicalKey?: string | null;
  /** When setting musicalKey, defaults to "manual". */
  keySource?: "manual" | "published";
  metadataSourceNote?: string | null;
};

export function toPublicTrack(track: Track): PublicTrack {
  const { filePath: _filePath, ...rest } = track;
  return rest;
}
