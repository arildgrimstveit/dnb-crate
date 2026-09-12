import { expandPreset, type MixIntent, type PhraseShape } from "./mix-presets.ts";
import { pairKey } from "./recipe.ts";
import { exactRecipeFingerprint } from "./recipe.ts";
import type { AutomationEvent } from "./analysis.ts";
import type { PhraseBarCount } from "./constants.ts";
import type { TransitionPlan } from "./planning.ts";

export const APPROVED_RECIPE_STATUSES = [
  "explicit_pair_preference",
  "sequence_acceptance",
  "protected_reference",
  "unreviewed_candidate",
] as const;

export type ApprovedRecipeStatus = (typeof APPROVED_RECIPE_STATUSES)[number];

export type SequentialHandoff = "legacy" | "early" | "supported";

export type ReusableRecipePayload = {
  kind: "reusable-recipe";
  outgoingTrackId: string;
  incomingTrackId: string;
  outgoingSourceFingerprint: string;
  incomingSourceFingerprint: string;
  outgoingSourceStartMs: number;
  outgoingSourceEndMs: number;
  incomingSourceStartMs: number;
  incomingSourceEndMs: number;
  outgoingRate: number;
  incomingRate: number;
  rateRegionsVersion?: 2;
  outgoingGainDb: number;
  incomingGainDb: number;
  type: string;
  barCount: PhraseBarCount;
  phraseShape: PhraseShape;
  intent: MixIntent;
  sequentialHandoff: SequentialHandoff;
  durationMs: number;
  mixInMs: number;
  mixOutMs: number;
  incomingDropMs: number | null;
  exitKind: string | null;
  automation: AutomationEvent[];
  parameters: Record<string, number | string | boolean>;
  engine: {
    rendererVersion: string;
    tempoEngine?: string | null;
    stretchScope?: string | null;
  };
  selectedEvidence: {
    outgoing: string | null;
    incoming: string | null;
  } | null;
};

export type ApprovedRecipeRecord = {
  id: string;
  status: ApprovedRecipeStatus;
  pairKey: string;
  reusableFingerprint: string;
  payload: ReusableRecipePayload;
  heardRenderFingerprint: string | null;
  renderJobId: string | null;
  transitionId: string | null;
  setPlanId: string | null;
  outgoingTitle: string | null;
  incomingTitle: string | null;
  note: string | null;
  createdAt: string;
};

export type RecipeIdentitySnapshot = {
  outgoingTrackId: string;
  incomingTrackId: string;
  outgoingSourceFingerprint: string;
  incomingSourceFingerprint: string;
  outgoingSourceStartMs: number;
  outgoingSourceEndMs: number;
  incomingSourceStartMs: number;
  incomingSourceEndMs: number;
  outgoingRate: number;
  incomingRate: number;
  outgoingGainDb: number;
  incomingGainDb: number;
  mixInMs: number;
  mixOutMs: number;
  durationMs: number;
  barCount: number;
  phraseShape: string;
  intent: string;
  sequentialHandoff: SequentialHandoff;
  automation: AutomationEvent[];
  engine: ReusableRecipePayload["engine"];
  selectedEvidence: ReusableRecipePayload["selectedEvidence"];
  trackDurationMs?: { outgoing: number; incoming: number };
};

export type RecipeLiveIdentity = {
  outgoingTrackId: string;
  incomingTrackId: string;
  outgoingSourceFingerprint: string;
  incomingSourceFingerprint: string;
  outgoingRate: number;
  incomingRate: number;
  outgoingDurationMs: number;
  incomingDurationMs: number;
  engine: ReusableRecipePayload["engine"];
  selectedEvidence: ReusableRecipePayload["selectedEvidence"];
};

export type RecipeFeasibility =
  | { ok: true; mode: "exact" | "common-gain-offset" | "applicable" }
  | { ok: false; reason: string };

export const APPROVED_STATUS_RANK: Record<ApprovedRecipeStatus, number> = {
  protected_reference: 4,
  explicit_pair_preference: 3,
  sequence_acceptance: 2,
  unreviewed_candidate: 1,
};

export function reusableRecipeFingerprint(payload: ReusableRecipePayload): string {
  return exactRecipeFingerprint(payload);
}

export function reusableRecipeFromJoin(input: {
  outgoingTrackId: string;
  incomingTrackId: string;
  outgoingSourceFingerprint: string;
  incomingSourceFingerprint: string;
  outgoingSourceStartMs: number;
  outgoingSourceEndMs: number;
  incomingSourceStartMs: number;
  incomingSourceEndMs: number;
  outgoingRate: number;
  incomingRate: number;
  outgoingGainDb: number;
  incomingGainDb: number;
  transition: TransitionPlan;
  automation?: AutomationEvent[];
  engine: ReusableRecipePayload["engine"];
  selectedEvidence?: ReusableRecipePayload["selectedEvidence"];
}): ReusableRecipePayload {
  const parameters = input.transition.parameters;
  const barCount: PhraseBarCount =
    parameters.barCount === 32 ? 32 : parameters.barCount === 8 ? 8 : 16;
  const phraseShape: PhraseShape =
    parameters.phraseShape === "sequential" || parameters.phraseShape === "landing"
      ? parameters.phraseShape
      : "complementary";
  const intent: MixIntent =
    parameters.intent === "sustain" || parameters.intent === "breather" ? parameters.intent : "lift";
  const sequentialHandoff: SequentialHandoff =
    parameters.sequentialHandoff === "early" || parameters.sequentialHandoff === "supported"
      ? parameters.sequentialHandoff
      : "legacy";
  const mixInMs = num(parameters.mixInMs) ?? input.incomingSourceStartMs;
  const mixOutMs = num(parameters.mixOutMs) ?? input.outgoingSourceEndMs - input.transition.durationMs;
  const automation =
    input.automation ??
    expandPreset(input.transition.type === "crossfade" ? "crossfade" : "phrase_mix", {
      barCount,
      phraseShape,
      intent,
      sequentialHandoff,
      targetBpm: num(parameters.targetBpm) ?? null,
      lowHandoverBar: num(parameters.lowHandoverBar) ?? undefined,
    }, barCount, input.transition.durationMs / barCount);
  return {
    kind: "reusable-recipe",
    outgoingTrackId: input.outgoingTrackId,
    incomingTrackId: input.incomingTrackId,
    outgoingSourceFingerprint: input.outgoingSourceFingerprint,
    incomingSourceFingerprint: input.incomingSourceFingerprint,
    outgoingSourceStartMs: input.outgoingSourceStartMs,
    outgoingSourceEndMs: input.outgoingSourceEndMs,
    incomingSourceStartMs: input.incomingSourceStartMs,
    incomingSourceEndMs: input.incomingSourceEndMs,
    outgoingRate: input.outgoingRate,
    incomingRate: input.incomingRate,
    rateRegionsVersion: parameters.rateRegionsVersion === 2 ? 2 : undefined,
    outgoingGainDb: input.outgoingGainDb,
    incomingGainDb: input.incomingGainDb,
    type: input.transition.type,
    barCount,
    phraseShape,
    intent,
    sequentialHandoff,
    durationMs: input.transition.durationMs,
    mixInMs,
    mixOutMs,
    incomingDropMs: num(parameters.incomingDropMs),
    exitKind: typeof parameters.exitKind === "string" ? parameters.exitKind : null,
    automation,
    parameters,
    engine: input.engine,
    selectedEvidence: input.selectedEvidence ?? null,
  };
}

export function recipeApplicability(
  approved: ReusableRecipePayload,
  live: RecipeLiveIdentity,
): RecipeFeasibility {
  if (
    live.outgoingTrackId !== approved.outgoingTrackId ||
    live.incomingTrackId !== approved.incomingTrackId
  ) {
    return { ok: false, reason: "PAIR_MISMATCH" };
  }
  if (
    live.outgoingSourceFingerprint !== approved.outgoingSourceFingerprint ||
    live.incomingSourceFingerprint !== approved.incomingSourceFingerprint
  ) {
    return { ok: false, reason: "SOURCE_FINGERPRINT_CHANGED" };
  }
  if (
    !near(live.outgoingRate, approved.outgoingRate) ||
    !near(live.incomingRate, approved.incomingRate)
  ) {
    return { ok: false, reason: "RATES_CHANGED" };
  }
  if (
    approved.outgoingSourceEndMs > live.outgoingDurationMs ||
    approved.incomingSourceEndMs > live.incomingDurationMs ||
    approved.outgoingSourceStartMs < 0 ||
    approved.incomingSourceStartMs < 0
  ) {
    return { ok: false, reason: "INFEASIBLE_BOUNDS" };
  }
  if (
    live.engine.tempoEngine &&
    approved.engine.tempoEngine &&
    live.engine.tempoEngine !== approved.engine.tempoEngine
  ) {
    return { ok: false, reason: "ENGINE_CHANGED" };
  }
  if (
    live.engine.stretchScope &&
    approved.engine.stretchScope &&
    live.engine.stretchScope !== approved.engine.stretchScope
  ) {
    return { ok: false, reason: "ENGINE_CHANGED" };
  }
  if (
    approved.selectedEvidence != null &&
    JSON.stringify(live.selectedEvidence ?? null) !== JSON.stringify(approved.selectedEvidence)
  ) {
    return { ok: false, reason: "EVIDENCE_CHANGED" };
  }
  return { ok: true, mode: "applicable" };
}

export function recipeFeasibility(
  approved: ReusableRecipePayload,
  current: RecipeIdentitySnapshot,
): RecipeFeasibility {
  if (
    current.outgoingTrackId !== approved.outgoingTrackId ||
    current.incomingTrackId !== approved.incomingTrackId
  ) {
    return { ok: false, reason: "PAIR_MISMATCH" };
  }
  if (
    current.outgoingSourceFingerprint !== approved.outgoingSourceFingerprint ||
    current.incomingSourceFingerprint !== approved.incomingSourceFingerprint
  ) {
    return { ok: false, reason: "SOURCE_FINGERPRINT_CHANGED" };
  }
  if (
    current.outgoingSourceStartMs !== approved.outgoingSourceStartMs ||
    current.outgoingSourceEndMs !== approved.outgoingSourceEndMs ||
    current.incomingSourceStartMs !== approved.incomingSourceStartMs ||
    current.incomingSourceEndMs !== approved.incomingSourceEndMs ||
    current.mixInMs !== approved.mixInMs ||
    current.mixOutMs !== approved.mixOutMs ||
    current.durationMs !== approved.durationMs
  ) {
    return { ok: false, reason: "WINDOWS_CHANGED" };
  }
  if (
    !near(current.outgoingRate, approved.outgoingRate) ||
    !near(current.incomingRate, approved.incomingRate)
  ) {
    return { ok: false, reason: "RATES_CHANGED" };
  }
  if (
    current.barCount !== approved.barCount ||
    current.phraseShape !== approved.phraseShape ||
    current.intent !== approved.intent ||
    current.sequentialHandoff !== approved.sequentialHandoff
  ) {
    return { ok: false, reason: "SHAPE_CHANGED" };
  }
  if (exactRecipeFingerprint(current.automation) !== exactRecipeFingerprint(approved.automation)) {
    return { ok: false, reason: "AUTOMATION_CHANGED" };
  }
  if (
    (current.engine.rendererVersion ?? "") !== (approved.engine.rendererVersion ?? "") ||
    (current.engine.tempoEngine ?? null) !== (approved.engine.tempoEngine ?? null) ||
    (current.engine.stretchScope ?? null) !== (approved.engine.stretchScope ?? null)
  ) {
    return { ok: false, reason: "ENGINE_CHANGED" };
  }
  if (
    JSON.stringify(current.selectedEvidence ?? null) !== JSON.stringify(approved.selectedEvidence ?? null)
  ) {
    return { ok: false, reason: "EVIDENCE_CHANGED" };
  }
  if (current.trackDurationMs) {
    if (
      approved.outgoingSourceEndMs > current.trackDurationMs.outgoing ||
      approved.incomingSourceEndMs > current.trackDurationMs.incoming ||
      approved.outgoingSourceStartMs < 0 ||
      approved.incomingSourceStartMs < 0
    ) {
      return { ok: false, reason: "INFEASIBLE_BOUNDS" };
    }
  }
  const outDelta = current.outgoingGainDb - approved.outgoingGainDb;
  const inDelta = current.incomingGainDb - approved.incomingGainDb;
  if (Math.abs(outDelta) < 0.051 && Math.abs(inDelta) < 0.051) {
    return { ok: true, mode: "exact" };
  }
  if (Math.abs(outDelta - inDelta) < 0.051) {
    return { ok: true, mode: "common-gain-offset" };
  }
  return { ok: false, reason: "GAINS_CHANGED" };
}

export function pickApprovedRecipe(
  recipes: ApprovedRecipeRecord[],
  live: RecipeLiveIdentity,
  options?: { recipeId?: string },
): { recipe: ApprovedRecipeRecord; feasibility: Extract<RecipeFeasibility, { ok: true }> } | null {
  const ranked = [...recipes]
    .filter((row) => row.status !== "unreviewed_candidate")
    .filter((row) => (options?.recipeId ? row.id === options.recipeId : true))
    .sort(
      (a, b) =>
        APPROVED_STATUS_RANK[b.status] - APPROVED_STATUS_RANK[a.status] ||
        b.createdAt.localeCompare(a.createdAt) ||
        b.id.localeCompare(a.id),
    );
  for (const recipe of ranked) {
    const feasibility = recipeApplicability(recipe.payload, live);
    if (feasibility.ok) {
      return { recipe, feasibility };
    }
  }
  return null;
}

export function approvedPairKey(outgoingTrackId: string, incomingTrackId: string): string {
  return pairKey(outgoingTrackId, incomingTrackId);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function near(left: number, right: number, epsilon = 1e-9): boolean {
  return Math.abs(left - right) <= epsilon;
}
