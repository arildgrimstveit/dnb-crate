import {
  pickApprovedRecipe,
  recipeApplicability,
  type ApprovedRecipeRecord,
  type PhraseBarCount,
  type RecipeLiveIdentity,
  type SequentialHandoff,
} from "@dnb-crate/domain";

import type { ChosenTransition, TimelineTrack } from "./timeline.ts";

export type RecipeRecallLookup = {
  listForPair(outgoingTrackId: string, incomingTrackId: string): ApprovedRecipeRecord[];
  recipeIdForPair?(outgoingTrackId: string, incomingTrackId: string): string | undefined;
  reuseForPair?(outgoingTrackId: string, incomingTrackId: string): "pair" | "recipe" | undefined;
};

export type RecipeRecallDecision = {
  chosen?: ChosenTransition;
  sequentialHandoff?: SequentialHandoff;
  barCount?: PhraseBarCount;
  phraseShape?: "complementary" | "sequential" | "landing";
  intent?: "sustain" | "lift" | "breather";
  reason: string;
  fallback: boolean;
};

export function recallApprovedHandoff(
  outgoing: TimelineTrack & { fileFingerprint?: string | null; title?: string | null },
  incoming: TimelineTrack & { fileFingerprint?: string | null; title?: string | null },
  live: RecipeLiveIdentity,
  lookup: RecipeRecallLookup | null | undefined,
): RecipeRecallDecision | null {
  const recipes = lookup?.listForPair(outgoing.id, incoming.id) ?? [];
  const pin = lookup?.recipeIdForPair?.(outgoing.id, incoming.id);
  const picked = pickApprovedRecipe(recipes, live, pin ? { recipeId: pin } : undefined);
  if (picked) {
    const payload = picked.recipe.payload;
    return {
      chosen: {
        transition: {
          id: crypto.randomUUID(),
          type:
            payload.type === "bass_swap" ||
            payload.type === "crossfade" ||
            payload.type === "double_drop"
              ? payload.type
              : "phrase_mix",
          durationMs: payload.durationMs,
          outgoingCuePointId: null,
          incomingCuePointId: null,
          parameters: {
            ...payload.parameters,
            appliedRecipeId: picked.recipe.id,
            appliedRecipeFingerprint: picked.recipe.reusableFingerprint,
            recipeReuseMode: "join-window",
            barCount: payload.barCount,
            phraseShape: payload.phraseShape,
            intent: payload.intent,
            sequentialHandoff: payload.sequentialHandoff,
            mixInMs: payload.mixInMs,
            mixOutMs: payload.mixOutMs,
            selectionReason: `approved ${picked.recipe.status} ${picked.feasibility.mode}`,
          },
        },
        outgoingRate: payload.outgoingRate,
        incomingRate: payload.incomingRate,
        targetBpm:
          typeof payload.parameters.targetBpm === "number" ? payload.parameters.targetBpm : null,
        window: {
          mixInMs: payload.mixInMs,
          mixOutMs: payload.mixOutMs,
          mixInBar: null,
          mixOutBar: null,
          barCount: payload.barCount,
          exitKind:
            payload.exitKind === "quietTail" || payload.exitKind === "dropLanding"
              ? payload.exitKind
              : null,
          phraseShape: payload.phraseShape,
          incomingDropMs: payload.incomingDropMs,
          dropAnchored: payload.exitKind === "dropLanding",
          alignmentOffsetMs:
            typeof payload.parameters.downbeatOffsetMs === "number"
              ? payload.parameters.downbeatOffsetMs
              : 0,
          alignmentPeriodMs:
            typeof payload.parameters.alignmentPeriodMs === "number"
              ? payload.parameters.alignmentPeriodMs
              : null,
          alignmentMode:
            payload.parameters.alignmentMode === "bar" ||
            payload.parameters.alignmentMode === "beat" ||
            payload.parameters.alignmentMode === "phrase"
              ? payload.parameters.alignmentMode
              : null,
        },
      },
      reason: `approved ${picked.recipe.status}`,
      fallback: false,
    };
  }
  const stale = recipes.find((row) => row.status !== "unreviewed_candidate");
  if (stale) {
    return { reason: recipeStaleReason(stale, live), fallback: true };
  }
  return null;
}

export function applySequentialDefaults(
  phraseShape: string,
  sequentialHandoff: SequentialHandoff | undefined,
): { sequentialHandoff: SequentialHandoff; rateRegionsVersion: 2; reason?: string } {
  if (phraseShape === "sequential" && sequentialHandoff == null) {
    return {
      sequentialHandoff: "supported",
      rateRegionsVersion: 2,
      reason: "supported sequential default",
    };
  }
  return { sequentialHandoff: sequentialHandoff ?? "supported", rateRegionsVersion: 2 };
}

function recipeStaleReason(recipe: ApprovedRecipeRecord, live: RecipeLiveIdentity): string {
  const result = recipeApplicability(recipe.payload, live);
  return result.ok ? "approved recipe not selected" : result.reason;
}
