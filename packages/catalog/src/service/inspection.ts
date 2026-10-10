import {
  DomainError,
  isDomainError,
  type SetPlanV1,
  type Track,
  type TransitionProposal,
} from "@dnb-crate/domain";

import { comparisonContextIdentity } from "../render/coordinator.ts";
import type { FrozenRenderRequest } from "../render-job-repository.ts";
import {
  planTransition,
  type PlanTransitionInput,
  type TrackBundle,
} from "../planning/transition-planner.ts";

/** Everything the join inspector / variant comparison needs from the owning
 * service. Kept as an explicit surface (like PlanEditingService) so the
 * extraction stays behind the same tests and the facade stays thin. */
export type JoinInspectionService = {
  requirePlan(setPlanId: string): { plan: SetPlanV1 };
  requireTrack(trackId: string): Track;
  bundle(trackId: string): TrackBundle;
  planTransition(input: {
    outgoingTrackId: string;
    incomingTrackId: string;
    preferredType?: "phrase_mix" | "bass_swap" | "crossfade" | "any";
    barCount?: 8 | 16 | 32;
    targetBpm?: number;
    allowExcessiveTempo?: boolean;
    allowLowConfidence?: boolean;
    allowDropIn?: boolean;
    savedWindow?: PlanTransitionInput["savedWindow"];
  }): {
    outgoingTrackId: string;
    incomingTrackId: string;
    targetBpm: number | null;
    proposals: TransitionProposal[];
  };
  renders: {
    freezeRequest(
      setPlanId: string,
      options?: { tolerateUnreadableSources?: boolean },
    ): Promise<FrozenRenderRequest>;
    startPreview(input: {
      setPlanId: string;
      transitionId: string;
      windowMs?: number;
      template?: "crossfade" | "phrase_mix" | "bass_swap";
      barCount?: 8 | 16 | 32;
      allowLowConfidence?: boolean;
      request?: FrozenRenderRequest;
    }): Promise<{ job: { id: string }; warnings: string[] }>;
  };
};

export type InspectTransitionResult = {
  setPlanId: string;
  transitionId: string;
  order: number;
  stored: {
    type: string;
    durationMs: number;
    barCount: number | null;
    targetBpm: number | null;
    selectionReason: string | null;
    pairStampTrackId: string | null;
    appliedRecipeId: string | null;
  };
  outgoing: {
    trackId: string;
    title: string;
    sourceStartMs: number;
    sourceEndMs: number;
    playbackRate: number;
    overlapStartSourceMs: number;
  };
  incoming: {
    trackId: string;
    title: string;
    sourceStartMs: number;
    sourceEndMs: number;
    playbackRate: number;
  };
  alignment: {
    offsetMs: number | null;
    periodMs: number | null;
    mode: string | null;
    onsetLockBeats: number | null;
  };
  groove: {
    gap: number | null;
    outgoingMean: number | null;
    incomingMean: number | null;
    outgoingBars: number | null;
    incomingBars: number | null;
    outgoingWindowMs: number | null;
    incomingWindowMs: number | null;
    abstain: string | null;
  };
  freshView: {
    type: string;
    reason: string | null;
    rateInfeasible: boolean;
  } | null;
  alternatives: Array<{
    type: string;
    feasible: boolean;
    blockers: string[];
    score: number;
  }>;
};

/** Join inspector (batch 9 first slice): one structured evidence view for
 *  a saved join — the stored treatment, its placed windows, the alignment
 *  provenance, the groove-gate numbers that selected it, and what the
 *  planner would choose today (with per-template blockers), so a bad join
 *  can be diagnosed without reconstructing source positions by hand. */
export function inspectTransition(
  service: JoinInspectionService,
  input: { setPlanId: string; transitionId: string },
): InspectTransitionResult {
  const stored = service.requirePlan(input.setPlanId);
  const entries = [...stored.plan.entries].sort((a, b) => a.order - b.order);
  const index = entries.findIndex((item) => item.transitionToNext?.id === input.transitionId);
  if (index < 0 || index >= entries.length - 1) {
    throw new DomainError(
      "INVALID_SET_PLAN",
      `No transition ${input.transitionId} on plan ${input.setPlanId}`,
    );
  }
  const outgoingEntry = entries[index]!;
  const incomingEntry = entries[index + 1]!;
  const transition = outgoingEntry.transitionToNext!;
  const outgoingTrack = service.requireTrack(outgoingEntry.trackId);
  const incomingTrack = service.requireTrack(incomingEntry.trackId);
  const overlapMs = transition.durationMs;
  const outRate = outgoingEntry.playbackRate > 0 ? outgoingEntry.playbackRate : 1;

  // What the planner would choose for this pair today, plus per-template
  // eligibility (F6 parity) as the alternatives view.
  const planned = planTransition(
    service.bundle(outgoingEntry.trackId),
    service.bundle(incomingEntry.trackId),
    {
      outgoingTrackId: outgoingEntry.trackId,
      incomingTrackId: incomingEntry.trackId,
      preferredType: "any",
      targetBpm:
        typeof transition.parameters.targetBpm === "number"
          ? transition.parameters.targetBpm
          : undefined,
    },
  );
  const best = planned.proposals[0] ?? null;
  const params = transition.parameters;
  const number = (key: string): number | null =>
    typeof params[key] === "number" ? params[key] : null;
  const pairStamp = typeof params.incomingTrackId === "string" ? params.incomingTrackId : null;
  return {
    setPlanId: input.setPlanId,
    transitionId: input.transitionId,
    order: index,
    stored: {
      type: transition.type,
      durationMs: transition.durationMs,
      barCount: number("barCount"),
      targetBpm: number("targetBpm"),
      selectionReason: typeof params.selectionReason === "string" ? params.selectionReason : null,
      pairStampTrackId: pairStamp,
      appliedRecipeId: typeof params.appliedRecipeId === "string" ? params.appliedRecipeId : null,
    },
    outgoing: {
      trackId: outgoingEntry.trackId,
      title: outgoingTrack.title,
      sourceStartMs: outgoingEntry.sourceStartMs,
      sourceEndMs: outgoingEntry.sourceEndMs,
      playbackRate: outgoingEntry.playbackRate,
      overlapStartSourceMs: outgoingEntry.sourceEndMs - overlapMs * outRate,
    },
    incoming: {
      trackId: incomingEntry.trackId,
      title: incomingTrack.title,
      sourceStartMs: incomingEntry.sourceStartMs,
      sourceEndMs: incomingEntry.sourceEndMs,
      playbackRate: incomingEntry.playbackRate,
    },
    alignment: {
      offsetMs: number("downbeatOffsetMs"),
      periodMs: number("alignmentPeriodMs"),
      mode: typeof params.alignmentMode === "string" ? params.alignmentMode : null,
      onsetLockBeats: number("onsetLockBeats"),
    },
    groove: {
      gap: number("grooveGap"),
      outgoingMean: number("grooveOutSync"),
      incomingMean: number("grooveInSync"),
      outgoingBars: number("grooveOutBars"),
      incomingBars: number("grooveInBars"),
      outgoingWindowMs: number("grooveOutWindowMs"),
      incomingWindowMs: number("grooveInWindowMs"),
      abstain: typeof params.grooveAbstain === "string" ? params.grooveAbstain : null,
    },
    freshView: best
      ? {
          type: best.type,
          reason: typeof best.reasons[0] === "string" ? best.reasons[0] : null,
          rateInfeasible: planned.targetBpm == null,
        }
      : null,
    alternatives: planned.proposals.map((proposal) => ({
      type: proposal.type,
      feasible: proposal.feasible,
      blockers: proposal.blockers,
      score: proposal.score,
    })),
  };
}

export type CompareTransitionVariantsResult = {
  setPlanId: string;
  transitionId: string;
  order: number;
  outgoing: { trackId: string; title: string };
  incoming: { trackId: string; title: string };
  storedTemplate: string;
  /** Which join coordinates the feasibility verdicts describe (R14):
   * saved-join windows/rates when the stored transition carries them,
   * fresh proposals otherwise. Preview artifacts always render the
   * saved join. */
  context: {
    source: "saved-join" | "fresh-proposal";
    outgoingMixOutMs: number | null;
    incomingMixInMs: number | null;
    barCount: number | null;
    durationMs: number;
    targetBpm: number | null;
    rates: { outgoing: number; incoming: number };
    /** ONE frozen comparison context spans every variant preview: the
     * shared request (evidence, source content hashes, settings), the
     * join, and the listening window — treatment-independent. Every
     * artifact and blocker from this comparison refers to this identity. */
    identity: string;
    /** Comparable loudness means IDENTICAL gain staging: every variant
     * renders with the plan's stored gainDb values; no per-variant
     * loudness matching is applied. Measured loudness per finished
     * variant comes from each job's manifest. */
    loudness: "identical-gain-staging";
  };
  variants: Array<{
    template: string;
    isStored: boolean;
    feasible: boolean;
    blockers: string[];
    jobId: string | null;
    outputRootRelativePath: string | null;
    /** Lifecycle at response time (R2): queued/failed at enqueue, or
     * not-started for infeasible variants. Waiting callers overwrite
     * with the terminal job state. */
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
    /** Measured loudness of the finished preview (R14 acceptance:
     * report measured loudness/headroom when meaningful). Filled by
     * waiting callers from the job's manifest; null until then. */
    integratedLufs?: number | null;
    truePeakDb?: number | null;
  }>;
};

/** Variant comparison (batch 9): render the stored treatment plus every
 *  other feasible aligned template for one saved join, on the same frozen
 *  windows with comparable loudness, so the owner can A/B by ear and
 *  rate each variant. The review's highest-value remaining feature. */
export async function compareTransitionVariants(
  service: JoinInspectionService,
  input: {
    setPlanId: string;
    transitionId: string;
    windowMs?: number;
    allowLowConfidence?: boolean;
  },
): Promise<CompareTransitionVariantsResult> {
  const stored = service.requirePlan(input.setPlanId);
  const entries = [...stored.plan.entries].sort((a, b) => a.order - b.order);
  const index = entries.findIndex((item) => item.transitionToNext?.id === input.transitionId);
  if (index < 0 || index >= entries.length - 1) {
    throw new DomainError(
      "INVALID_SET_PLAN",
      `No transition ${input.transitionId} on plan ${input.setPlanId}`,
    );
  }
  const outgoingEntry = entries[index]!;
  const incomingEntry = entries[index + 1]!;
  const transition = outgoingEntry.transitionToNext!;
  const outgoingTrack = service.requireTrack(outgoingEntry.trackId);
  const incomingTrack = service.requireTrack(incomingEntry.trackId);

  // R14 (review 2026-10-10): eligibility is evaluated on the SAVED join's
  // coordinates — the windows, rates, and bar count the previews actually
  // render. Fresh proposals would test a different interval than the one
  // being compared, accepting/rejecting the wrong treatment. Legacy
  // transitions without stored barCount (crossfade-only plans) fall back
  // to fresh proposals, labeled as such below instead of mixing window
  // identities silently.
  const params = transition.parameters;
  const paramNumber = (key: string): number | null =>
    typeof params[key] === "number" ? params[key] : null;
  const savedBarCountRaw = paramNumber("barCount");
  const savedBarCount =
    savedBarCountRaw === 8 || savedBarCountRaw === 16 || savedBarCountRaw === 32
      ? savedBarCountRaw
      : null;
  const outRate = outgoingEntry.playbackRate > 0 ? outgoingEntry.playbackRate : 1;
  const inRate = incomingEntry.playbackRate > 0 ? incomingEntry.playbackRate : 1;
  const savedTargetBpm = paramNumber("targetBpm");
  const savedWindow: PlanTransitionInput["savedWindow"] =
    savedBarCount != null
      ? {
          outgoingMixOutMs: paramNumber("mixOutMs") ?? outgoingEntry.sourceEndMs,
          incomingMixInMs: paramNumber("mixInMs") ?? incomingEntry.sourceStartMs,
          barCount: savedBarCount,
          outgoingRate: outRate,
          incomingRate: inRate,
        }
      : undefined;

  // Feasibility per template against the saved-join context (F6 parity).
  const planned = service.planTransition({
    outgoingTrackId: outgoingEntry.trackId,
    incomingTrackId: incomingEntry.trackId,
    preferredType: "any",
    targetBpm: savedTargetBpm ?? undefined,
    allowLowConfidence: input.allowLowConfidence,
    ...(savedWindow ? { savedWindow } : {}),
  });

  const templates: Array<"crossfade" | "phrase_mix" | "bass_swap"> = [
    "phrase_mix",
    "bass_swap",
    "crossfade",
  ];
  const variants: Array<{
    template: string;
    isStored: boolean;
    feasible: boolean;
    blockers: string[];
    jobId: string | null;
    outputRootRelativePath: string | null;
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
  }> = [];
  // R14: freeze ONE comparison context — evidence, source content hashes,
  // settings — and share it across every variant preview, instead of
  // freezing (and re-hashing every source file) per variant. All artifacts
  // and blockers from this comparison refer to the same identity.
  // Unreadable sources skip their hash here so the per-variant readiness
  // failures (R2) still surface instead of failing the whole comparison.
  const sharedRequest = await service.renders.freezeRequest(input.setPlanId, {
    tolerateUnreadableSources: true,
  });
  const contextIdentity = comparisonContextIdentity(sharedRequest, {
    transitionId: input.transitionId,
    windowMs: input.windowMs ?? null,
  });
  for (const template of templates) {
    const proposal = planned.proposals.find((item) => item.type === template);
    const isStored = transition.type === template;
    const feasible = proposal?.feasible ?? false;
    const blockers = proposal?.blockers ?? [];
    let jobId: string | null = null;
    const outputPath: string | null = null;
    let enqueueError: { code: string; message: string } | null = null;
    if (feasible || isStored) {
      try {
        const started = await service.renders.startPreview({
          setPlanId: input.setPlanId,
          transitionId: input.transitionId,
          windowMs: input.windowMs,
          template,
          allowLowConfidence: input.allowLowConfidence,
          request: sharedRequest,
        });
        jobId = started.job.id;
      } catch (error) {
        // Preview enqueue failed; report it without blocking the others.
        // Preserve the actionable domain error (R2) — a bare "preview
        // render failed" hides the real precondition (missing worker,
        // unreadable source, invalid plan state).
        enqueueError = isDomainError(error)
          ? { code: error.code, message: error.message }
          : {
              code: "RENDER_FAILED",
              message: error instanceof Error ? error.message : "Preview render failed",
            };
        blockers.push(`preview render failed: ${enqueueError.message}`);
      }
    }
    variants.push({
      template,
      isStored,
      feasible,
      blockers,
      jobId,
      outputRootRelativePath: outputPath,
      // Lifecycle at enqueue time (R2): callers that wait overwrite
      // these with the terminal state from waitForRenderJob.
      status: jobId != null ? "queued" : enqueueError ? "failed" : "not-started",
      errorCode: enqueueError?.code ?? null,
      errorMessage: enqueueError?.message ?? null,
    });
  }
  return {
    setPlanId: input.setPlanId,
    transitionId: input.transitionId,
    order: index,
    outgoing: { trackId: outgoingEntry.trackId, title: outgoingTrack.title },
    incoming: { trackId: incomingEntry.trackId, title: incomingTrack.title },
    storedTemplate: transition.type,
    context: {
      source: savedWindow ? "saved-join" : "fresh-proposal",
      outgoingMixOutMs: savedWindow ? savedWindow.outgoingMixOutMs : null,
      incomingMixInMs: savedWindow ? savedWindow.incomingMixInMs : null,
      barCount: savedBarCount,
      durationMs: transition.durationMs,
      targetBpm: savedTargetBpm,
      rates: { outgoing: outRate, incoming: inRate },
      identity: contextIdentity,
      loudness: "identical-gain-staging" as const,
    },
    variants,
  };
}
