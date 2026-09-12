export type FeedbackRatingValue = number | "not_assessed";

export type TransitionFeedback = {
  id: string;
  recipeFingerprint: string;
  outgoingTrackId: string | null;
  incomingTrackId: string | null;
  setPlanId: string | null;
  renderJobId: string | null;
  transitionId: string | null;
  rendererVersion: string | null;
  overall: FeedbackRatingValue;
  timing: FeedbackRatingValue;
  phrasing: FeedbackRatingValue;
  bassClarity: FeedbackRatingValue;
  harmonicFit: FeedbackRatingValue;
  energyContinuity: FeedbackRatingValue;
  vocalClash: FeedbackRatingValue;
  note: string | null;
  createdAt: string;
};

export type RateTransitionInput = {
  recipeFingerprint?: string;
  outgoingTrackId?: string;
  incomingTrackId?: string;
  setPlanId?: string;
  renderJobId?: string;
  transitionId?: string;
  rendererVersion?: string;
  type?: string;
  barCount?: number | null;
  intent?: string | null;
  phraseShape?: string | null;
  outgoingRate?: number | null;
  incomingRate?: number | null;
  mixInMs?: number | null;
  mixOutMs?: number | null;
  recipeVersion?: number | null;
  overall?: FeedbackRatingValue;
  timing?: FeedbackRatingValue;
  phrasing?: FeedbackRatingValue;
  bassClarity?: FeedbackRatingValue;
  harmonicFit?: FeedbackRatingValue;
  energyContinuity?: FeedbackRatingValue;
  vocalClash?: FeedbackRatingValue;
  note?: string | null;
};

export type TransitionPreference = {
  recipeFingerprint: string | null;
  pairKey: string | null;
  likeCount: number;
  dislikeCount: number;
  noteCount: number;
  bonus: number;
};

export type FeedbackIndex = {
  byFingerprint: Map<string, TransitionPreference>;
  byPair: Map<string, TransitionPreference>;
};

export const FEEDBACK_LIKE_THRESHOLD = 0.6;
export const FEEDBACK_DISLIKE_THRESHOLD = 0.4;

export function preferenceBonus(likeCount: number, dislikeCount: number): number {
  if (dislikeCount >= 1) {
    return -1;
  }
  if (likeCount >= 2) {
    return 1;
  }
  return 0;
}

export function isLike(value: FeedbackRatingValue): boolean {
  return value !== "not_assessed" && value >= FEEDBACK_LIKE_THRESHOLD;
}

export function isDislike(value: FeedbackRatingValue): boolean {
  return value !== "not_assessed" && value <= FEEDBACK_DISLIKE_THRESHOLD;
}
