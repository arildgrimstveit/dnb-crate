import type { RenderReadiness } from "./render.ts";
import type { Track } from "./track.ts";

export type EnergyArcPoint = {
  atFraction: number;
  targetEnergy: number;
};

export type TransitionType = "crossfade" | "phrase_mix" | "bass_swap" | "double_drop";

export type TransitionPlan = {
  id: string;
  type: TransitionType;
  durationMs: number;
  outgoingCuePointId: string | null;
  incomingCuePointId: string | null;
  parameters: Record<string, number | string | boolean>;
};

export type SetPlanEntry = {
  id: string;
  trackId: string;
  order: number;
  sourceStartMs: number;
  sourceEndMs: number;
  timelineStartMs: number;
  playbackRate: number;
  gainDb: number;
  transitionToNext: TransitionPlan | null;
};

export type SetPlanV1 = {
  schemaVersion: 1;
  id: string;
  name: string;
  targetDurationMs: number;
  targetBpm: number | null;
  requestedArc: EnergyArcPoint[];
  entries: SetPlanEntry[];
  createdAt: string;
  updatedAt: string;
};

export type ScoreComponents = {
  mood: number;
  subgenre: number;
  energy: number;
  bpm: number;
  harmonic: number;
  rating: number;
  preferredArtist: number;
  exploration: number;
  repeatedArtist: number;
  recentlyUsed: number;
  missingMetadata: number;
};

export type ScoreBreakdown = {
  total: number;
  components: ScoreComponents;
  reasons: string[];
};

export type EnergyDirection = "up" | "down" | "any";

export type CreateSetPlanInput = {
  name: string;
  targetDurationMs?: number;
  targetBpm?: number | null;
  bpmMin?: number;
  bpmMax?: number;
  requestedArc?: EnergyArcPoint[];
  requiredTrackIds?: string[];
  excludedTrackIds?: string[];
  excludedArtists?: string[];
  preferredMoods?: string[];
  preferredSubgenres?: string[];
  preferredTags?: string[];
  preferredArtists?: string[];
  minRating?: number;
  artistRepeatSpacing?: number;
  harmonicImportance?: number;
  explorationWeight?: number;
  startTrackId?: string;
  endTrackId?: string;
  seed?: number;
};

export type SelectionExplanation = {
  trackId: string;
  title: string;
  artist: string | null;
  order: number;
  score: ScoreBreakdown;
};

export type RejectionExplanation = {
  trackId: string;
  title: string;
  reason: string;
};

export type PlanExplanation = {
  seed: number;
  selected: SelectionExplanation[];
  rejected: RejectionExplanation[];
};

export type ValidationIssue = {
  code: string;
  message: string;
  entryId?: string;
  trackId?: string;
};

export type EnergyDiagnostic = {
  entryId: string;
  trackId: string;
  atFraction: number;
  actualEnergy: number | null;
  targetEnergy: number;
  deviation: number | null;
};

export type ValidateSetPlanResult = {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  diagnostics: {
    durationMs: number;
    durationDeltaMs: number;
    energyByEntry: EnergyDiagnostic[];
  };
  renderReadiness?: RenderReadiness;
};

export type CreateSetPlanResult = {
  plan: SetPlanV1;
  explanation: PlanExplanation;
  validation: ValidateSetPlanResult;
  partial: boolean;
};

export type CompatibleTrack = {
  track: Pick<
    Track,
    "id" | "artist" | "title" | "bpm" | "musicalKey" | "camelotKey" | "energy" | "rating"
  >;
  score: ScoreBreakdown;
};

export type PlanningReadiness = {
  trackId: string;
  title: string;
  ready: boolean;
  missing: string[];
  cuePointTypes: string[];
};

export type SetPlanSummary = {
  id: string;
  name: string;
  targetDurationMs: number;
  entryCount: number;
  createdAt: string;
  updatedAt: string;
};
