import type {
  CreateSetPlanInput,
  PlanExplanation,
  RejectionExplanation,
  SetPlanEntry,
  SetPlanV1,
  Track,
} from "@dnb-crate/domain";
import { DJ_HANDOFF_POLICY, pairKey } from "@dnb-crate/domain";

import { scoreBuckets } from "./selection.ts";
import type { CompiledPlanningConstraints } from "./constraints.ts";
import type { repairSequence } from "./repair-search.ts";

export type FinalizeInput = {
  input: CreateSetPlanInput;
  selected: Track[];
  entries: SetPlanEntry[];
  explanationInput: {
    seed: number;
    scoreFor: (
      candidate: Track,
      source: Track | null,
      fraction: number,
    ) => PlanExplanation["selected"][number]["score"];
    lookaheadById: Map<string, number>;
    requiredProgressById: Map<string, number>;
    rejected: RejectionExplanation[];
    varietyStrength: number;
    historyIds: Set<string>;
    historyRecordings: Set<string>;
    historyPairs: Set<string>;
    originalDescriptorFilters: CreateSetPlanInput["descriptors"];
    descriptorFilters: CreateSetPlanInput["descriptors"];
    relaxationSteps: number;
    repairSearch: ReturnType<typeof repairSequence>["diagnostics"] | undefined;
    chainRetry: PlanExplanation["chainRetry"];
    varietyPairs: Array<{ outgoingTrackId: string; incomingTrackId: string }>;
  };
  targetDurationMs: number;
  requestedArc: NonNullable<CreateSetPlanInput["requestedArc"]>;
  qualityPolicy: "strict" | "off";
  spacing: number;
  compiled: CompiledPlanningConstraints;
  createdAt: string;
};

/** Assemble the persisted plan object and its deterministic explanation. */
export function buildFinalPlan(input: FinalizeInput): {
  plan: SetPlanV1;
  explanation: PlanExplanation;
} {
  const { input: brief, selected, entries } = input;
  const exp = input.explanationInput;

  const plan: SetPlanV1 = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: brief.name,
    targetDurationMs: input.targetDurationMs,
    targetBpm: brief.targetBpm ?? null,
    requestedArc: input.requestedArc,
    entries,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    handoffPolicy: DJ_HANDOFF_POLICY,
    rateRegionsVersion: 2,
    qualityPolicy: input.qualityPolicy,
    planningConstraints: {
      startTrackId: brief.startTrackId,
      endTrackId: brief.endTrackId,
      requiredTrackIds: brief.requiredTrackIds,
      excludedTrackIds: brief.excludedTrackIds,
      excludedArtists: brief.excludedArtists,
      requiredTransitions: input.compiled.requiredTransitions,
      artistRepeatSpacing: input.spacing,
    },
  };

  const totalJoins = Math.max(selected.length - 1, 0);
  let knownJoins = 0;
  for (let i = 0; i < totalJoins; i += 1) {
    if (selected[i]?.camelotKey && selected[i + 1]?.camelotKey) {
      knownJoins += 1;
    }
  }
  const explanation: PlanExplanation = {
    ...(brief.variety
      ? {
          variety: {
            referencePlanIds: brief.variety.referencePlanIds,
            strength: exp.varietyStrength,
            trackIds: [...exp.historyIds],
            pairs: exp.varietyPairs,
            repeatedTracks: selected.filter((track) =>
              exp.historyRecordings.has(track.recordingKey ?? track.id),
            ).length,
            repeatedPairs: selected
              .slice(1)
              .filter((track, i) =>
                exp.historyPairs.has(
                  pairKey(
                    selected[i]!.recordingKey ?? selected[i]!.id,
                    track.recordingKey ?? track.id,
                  ),
                ),
              ).length,
          },
        }
      : {}),
    seed: exp.seed,
    selected: selected.map((track, order) => {
      const score = exp.scoreFor(
        track,
        selected[order - 1] ?? null,
        selected.length <= 1 ? 0 : order / (selected.length - 1),
      );
      const lookahead = exp.lookaheadById.get(track.id) ?? 0;
      return {
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        order,
        score,
        lookahead,
        requiredProgress: exp.requiredProgressById.get(track.id) ?? 0,
        buckets: scoreBuckets(score, lookahead),
      };
    }),
    rejected: exp.rejected.slice(0, 50),
    harmonicCoverage: { knownJoins, totalJoins },
    originalDescriptors: exp.originalDescriptorFilters ?? null,
    resolvedDescriptors: exp.descriptorFilters ?? null,
    relaxationSteps: exp.relaxationSteps,
    repairSearch: exp.repairSearch,
    chainRetry: exp.chainRetry,
  };

  return { plan, explanation };
}
