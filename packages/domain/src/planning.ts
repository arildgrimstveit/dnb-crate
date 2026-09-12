import type { HarmonicRelation } from "./keys.ts";
import type { DescriptorFilters } from "./mood-presets.ts";
import type { RenderReadiness } from "./render.ts";
import type { BpmSource, Track } from "./track.ts";

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

export type QualityPolicy = "strict" | "off";

export type RequiredTransitionStrength = "required" | "preferred";
export type RequiredTransitionReuse = "pair" | "recipe";

export type RequiredTransitionConstraint = {
  outgoingTrackId: string;
  incomingTrackId: string;
  recipeId?: string;
  strength: RequiredTransitionStrength;
  reuse: RequiredTransitionReuse;
  allowQualityException?: boolean;
};

export type PlanningConstraints = {
  startTrackId?: string;
  endTrackId?: string;
  requiredTrackIds?: string[];
  excludedTrackIds?: string[];
  excludedArtists?: string[];
  requiredTransitions?: RequiredTransitionConstraint[];
  artistRepeatSpacing?: number;
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
  rateRegionsVersion?: 1 | 2;
  handoffPolicy?: "dj-continuity-v1";
  qualityPolicy?: QualityPolicy;
  planningConstraints?: PlanningConstraints;
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
  structure: number;
  joinLevel: number;
  joinStructure: number;
  joinAligned: number;
  joinHarmonic: number;
  genrePrior: number;
  feedback: number;
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
  /** Requested length in minutes. Wins over `targetDurationMs` when both are set. */
  targetDurationMinutes?: number;
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
  /** Explicit prior mixes to diversify against; search drafts are never implicitly history. */
  variety?: { referencePlanIds: string[]; strength?: number };
  startTrackId?: string;
  endTrackId?: string;
  seed?: number;
  descriptors?: DescriptorFilters;
  genres?: { include?: string[]; exclude?: string[] };
  dropAnchored?: boolean;
  qualityPolicy?: QualityPolicy;
  requiredTransitions?: RequiredTransitionConstraint[];
};

export type SelectionScoreBuckets = {
  moodFit: number;
  joinQuality: number;
  keyCoverage: number;
  timeFit: number;
  lookahead: number;
  feedback: number;
};

export type SelectionExplanation = {
  trackId: string;
  title: string;
  artist: string | null;
  order: number;
  score: ScoreBreakdown;
  lookahead?: number;
  requiredProgress?: number;
  buckets?: SelectionScoreBuckets;
};

export type RejectionExplanation = {
  trackId: string;
  title: string;
  reason: string;
};

export type PlanExplanation = {
  openerSearch?: Array<{ openerTrackId: string | null; durationMs: number }>;
  variety?: {
    referencePlanIds: string[];
    strength: number;
    trackIds: string[];
    pairs: Array<{ outgoingTrackId: string; incomingTrackId: string }>;
    repeatedTracks: number;
    repeatedPairs: number;
  };
  chainRetry?: {
    durationMs: number;
    partialReasons: string[];
    missingRequiredTransitions: string[];
    trackIds: string[];
    repairSearch?: PlanExplanation["repairSearch"];
    priorRepairSearch?: PlanExplanation["repairSearch"];
  };
  seed: number;
  selected: SelectionExplanation[];
  rejected: RejectionExplanation[];
  harmonicCoverage?: { knownJoins: number; totalJoins: number };
  originalDescriptors?: DescriptorFilters | null;
  resolvedDescriptors?: DescriptorFilters | null;
  relaxationSteps?: number;
  repairSearch?: {
    rejectionCounts: Record<string, number>;
    evaluations: number;
    invalid: number;
    limit: number;
    status: string;
    missingRequired: number;
    durationDistanceMs: number | null;
    musicalScore?: number | null;
  };
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

export type JoinKeyEvidence = {
  musicalKey: string | null;
  camelotKey: string | null;
  source: string | null;
  confidence: number;
  analyzerName: string | null;
};

export type JoinRecipeStatus = "applied" | "stale" | "none" | "protected-exception" | "adapted";
export type JoinConstraintSatisfaction =
  "satisfied" | "preferred-dropped" | "unsatisfied" | "adapted" | "exception" | "none";

export type JoinQualityReport = {
  order: number;
  outgoingTrackId: string;
  incomingTrackId: string;
  outgoingTitle: string;
  incomingTitle: string;
  outgoingKey: JoinKeyEvidence;
  incomingKey: JoinKeyEvidence;
  harmonicRelation: HarmonicRelation;
  harmonicClass: "compatible" | "risky" | "unknown";
  outgoingSourceStartMs: number;
  outgoingSourceEndMs: number;
  incomingSourceStartMs: number;
  incomingSourceEndMs: number;
  barCount: number | null;
  overlapMs: number;
  continuity?: { evidence: string; energyFloor: number | null; valleyBars: number | null; coexistenceBars: number | null };
  phraseShape: string | null;
  sequentialHandoff: string | null;
  intent: string | null;
  type: TransitionType;
  fallbackReason: string | null;
  nativeOutgoingBpm: number | null;
  nativeIncomingBpm: number | null;
  joinTargetBpm: number | null;
  planTargetBpm: number | null;
  outgoingRate: number;
  incomingRate: number;
  rateRegionsVersion: number | null;
  gridOkOutgoing: boolean;
  gridOkIncoming: boolean;
  gridEngineOutgoing: string | null;
  gridEngineIncoming: string | null;
  recipeStatus: JoinRecipeStatus;
  constraintSatisfaction: JoinConstraintSatisfaction;
  unexplainedQualityIssue: boolean;
};

export type PlanQualityReport = {
  joins: JoinQualityReport[];
  typeCounts: Record<TransitionType, number>;
  harmonicCounts: { compatible: number; risky: number; unknown: number };
  durationMs: number;
  durationDeltaMs: number;
  targetDurationMs: number;
  hourAuditionWindow: { minMs: number; maxMs: number; inWindow: boolean } | null;
  artistRepeatSpacingRequested: number;
  artistGaps: Array<{
    artist: string;
    leftOrder: number;
    rightOrder: number;
    gap: number;
  }>;
  artistSpacingViolations: Array<{
    artist: string;
    leftOrder: number;
    rightOrder: number;
    gap: number;
  }>;
  partial: boolean;
  partialReasons: string[];
  unsatisfiedRequiredTransitions?: string[];
  structurallyValid: boolean;
  qualityChecksPassed: boolean;
  readyForAudition: boolean;
  userAccepted: boolean;
  qualityPolicy: QualityPolicy | null;
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
  quality?: PlanQualityReport;
};

export type CreateSetPlanResult = {
  plan: SetPlanV1;
  explanation: PlanExplanation;
  validation: ValidateSetPlanResult;
  partial: boolean;
  quality: PlanQualityReport;
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
  bpmSource?: BpmSource | "hint" | null;
};

export type SetPlanSummary = {
  id: string;
  name: string;
  targetDurationMs: number;
  entryCount: number;
  createdAt: string;
  updatedAt: string;
};
