import * as z from "zod/v4";

import { transitionTypeSchema } from "../transition-type.ts";
import { resolveRateRegions } from "../rate-regions.ts";
import type { PhraseBarCount } from "../constants.ts";

/**
 * Q03 (12 October roadmap): ONE versioned contract for a fully resolved
 * join — the immutable geometry, alignment decision, evidence identities,
 * treatment and gain that planning froze and rendering executes.
 *
 * A context is RESOLVED only after bounds, local evidence and geometry
 * validation; `resolveJoinInputs` returns an explicit unresolved outcome
 * with a stable machine-readable reason instead of ever silently moving
 * bounds or clamping geometry. `recipeVersion` must not remain the
 * generic alignment-validity flag: this contract, once adopted by
 * timeline/freeze/render, is the alignment-validity statement.
 *
 * Policy version gates the RESOLUTION RULES (which validations run, how
 * geometry is interpreted), not the shape — bump it when the rules
 * change so stored contexts record which rules produced them.
 */

export const JOIN_RESOLUTION_POLICY_VERSION = 1;

export const phraseBarCountSchema = z.union([
  z.literal(8),
  z.literal(16),
  z.literal(32),
]) satisfies z.ZodType<PhraseBarCount>;

export const joinUnresolvedReasonSchema = z.enum([
  "invalid-geometry",
  "bounds-exceed-source",
  "overlap-exceeds-window",
  "no-native-body",
  "invalid-rate",
  "invalid-alignment",
  "missing-evidence",
  "invalid-gain",
]);

export type JoinUnresolvedReason = z.infer<typeof joinUnresolvedReasonSchema>;

export const joinUnresolvedOutcomeSchema = z.object({
  status: z.literal("unresolved"),
  reason: joinUnresolvedReasonSchema,
  detail: z.string(),
});

export type JoinUnresolvedOutcome = z.infer<typeof joinUnresolvedOutcomeSchema>;

export const resolvedJoinGeometrySchema = z.object({
  outgoingSourceStartMs: z.number().int().nonnegative(),
  outgoingSourceEndMs: z.number().int().positive(),
  incomingSourceStartMs: z.number().int().nonnegative(),
  incomingSourceEndMs: z.number().int().positive(),
  /** The planned position of the join on the OUTPUT timeline. Rendering
   * anchors the incoming deck here (not at a spliced file boundary). */
  joinOutputAnchorMs: z.number().nonnegative(),
  /** Overlap in OUTPUT milliseconds. */
  overlapMs: z.number().int().positive(),
  outgoingRate: z.number().positive(),
  incomingRate: z.number().positive(),
  /** null for treatments without phrase semantics (crossfade). */
  phraseBarCount: phraseBarCountSchema.nullable(),
});

export const resolvedJoinAlignmentSchema = z.object({
  mode: z.enum(["bar", "beat", "phrase"]),
  periodMs: z.number().positive(),
  downbeatOffsetMs: z.number(),
  onsetLockBeats: z.number().int().nullable(),
  /** Local grid confidence/coverage over the joined intervals when
   * measured; null stays null (unknown is unknown). */
  confidence: z.number().min(0).max(1).nullable(),
  coverage: z.number().min(0).max(1).nullable(),
});

export const resolvedJoinEvidenceSchema = z.object({
  outgoingFingerprint: z.string().min(1),
  incomingFingerprint: z.string().min(1),
  analyzerVersion: z.string().nullable(),
  gridSource: z.enum(["analyzed", "reference", "manual", "anchor", "sidecar"]).nullable(),
});

export const resolvedJoinTreatmentSchema = z.object({
  type: transitionTypeSchema,
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
});

export const resolvedJoinGainSchema = z.object({
  /** A PINNED gain always has a value; a derived gain may still be null
   * (not yet decided) — unknown stays unknown. */
  gainDb: z.number().nullable(),
  source: z.enum(["derived", "pinned"]),
});

export const resolvedJoinContextSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.number().int().positive(),
  outgoingEntryId: z.string().min(1),
  incomingEntryId: z.string().min(1),
  transitionId: z.string().min(1),
  geometry: resolvedJoinGeometrySchema,
  alignment: resolvedJoinAlignmentSchema,
  evidence: resolvedJoinEvidenceSchema,
  treatment: resolvedJoinTreatmentSchema,
  gain: resolvedJoinGainSchema,
});

export type ResolvedJoinContext = z.infer<typeof resolvedJoinContextSchema>;

/** Builder input: raw planning values before validation. Durations are
 * optional context — when present, bounds are checked against them. */
export type JoinInputs = {
  policyVersion?: number;
  outgoingEntryId: string;
  incomingEntryId: string;
  transitionId: string;
  geometry: {
    outgoingSourceStartMs: number;
    outgoingSourceEndMs: number;
    incomingSourceStartMs: number;
    incomingSourceEndMs: number;
    joinOutputAnchorMs: number;
    overlapMs: number;
    outgoingRate: number;
    incomingRate: number;
    phraseBarCount: PhraseBarCount | null;
  };
  /** Track durations when known: bounds are validated against them. */
  outgoingDurationMs?: number | null;
  incomingDurationMs?: number | null;
  alignment: {
    mode: "bar" | "beat" | "phrase";
    periodMs: number;
    downbeatOffsetMs: number;
    onsetLockBeats: number | null;
    confidence: number | null;
    coverage: number | null;
  };
  evidence: {
    outgoingFingerprint: string;
    incomingFingerprint: string;
    analyzerVersion: string | null;
    gridSource: "analyzed" | "reference" | "manual" | "anchor" | "sidecar" | null;
  };
  treatment: {
    type: "crossfade" | "phrase_mix" | "bass_swap";
    params: Record<string, number | string | boolean>;
  };
  gain: { gainDb: number | null; source: "derived" | "pinned" };
};

export type JoinResolution =
  | { status: "resolved"; context: ResolvedJoinContext }
  | {
      status: "unresolved";
      reason: JoinUnresolvedReason;
      detail: string;
    };

/**
 * Q03 slice 3: does a stamped contract still describe the CURRENT plan
 * entries? Comparison/freeze feasibility for a saved join is evaluated
 * against its frozen coordinates — if the entries (or the transition's
 * overlap) have drifted from the contract, the saved variant is reported
 * infeasible with this reason instead of enqueueing a preview that would
 * silently clamp or re-derive different geometry.
 */
export function resolvedJoinStillFits(
  context: ResolvedJoinContext,
  current: {
    outgoingSourceStartMs: number;
    outgoingSourceEndMs: number;
    incomingSourceStartMs: number;
    incomingSourceEndMs: number;
    outgoingRate: number;
    incomingRate: number;
    overlapMs: number;
  },
): { fits: boolean; reason: string | null } {
  const g = context.geometry;
  if (
    current.outgoingSourceStartMs !== g.outgoingSourceStartMs ||
    current.outgoingSourceEndMs !== g.outgoingSourceEndMs ||
    current.incomingSourceStartMs !== g.incomingSourceStartMs ||
    current.incomingSourceEndMs !== g.incomingSourceEndMs ||
    current.outgoingRate !== g.outgoingRate ||
    current.incomingRate !== g.incomingRate ||
    current.overlapMs !== g.overlapMs
  ) {
    return {
      fits: false,
      reason: "entries-drifted-from-contract",
    };
  }
  return { fits: true, reason: null };
}

function unresolved(
  reason: JoinUnresolvedReason,
  detail: string,
): { status: "unresolved"; reason: JoinUnresolvedReason; detail: string } {
  return { status: "unresolved", reason, detail };
}

/**
 * Construct a resolved join context, or an explicit unresolved outcome.
 * Never clamps, moves or guesses: a bound that cannot be honored is an
 * unresolved reason, not a silently adjusted interval.
 */
export function resolveJoinInputs(inputs: JoinInputs): JoinResolution {
  const g = inputs.geometry;
  if (
    !Number.isFinite(g.outgoingRate) ||
    g.outgoingRate <= 0 ||
    !Number.isFinite(g.incomingRate) ||
    g.incomingRate <= 0
  ) {
    return unresolved("invalid-rate", "Playback rates must be finite and positive");
  }
  if (
    g.outgoingSourceStartMs >= g.outgoingSourceEndMs ||
    g.incomingSourceStartMs >= g.incomingSourceEndMs
  ) {
    return unresolved("invalid-geometry", "Source windows must have positive length");
  }
  if (inputs.outgoingDurationMs != null && g.outgoingSourceEndMs > inputs.outgoingDurationMs) {
    return unresolved(
      "bounds-exceed-source",
      `Outgoing window ends at ${g.outgoingSourceEndMs} ms beyond the ${inputs.outgoingDurationMs} ms source`,
    );
  }
  if (inputs.incomingDurationMs != null && g.incomingSourceEndMs > inputs.incomingDurationMs) {
    return unresolved(
      "bounds-exceed-source",
      `Incoming window ends at ${g.incomingSourceEndMs} ms beyond the ${inputs.incomingDurationMs} ms source`,
    );
  }
  if (inputs.alignment.periodMs <= 0 || !Number.isFinite(inputs.alignment.downbeatOffsetMs)) {
    return unresolved("invalid-alignment", "Alignment period must be positive and offset finite");
  }
  if (inputs.gain.source === "pinned" && inputs.gain.gainDb == null) {
    return unresolved("invalid-gain", "A pinned gain requires a gain value");
  }
  if (
    inputs.evidence.outgoingFingerprint.length === 0 ||
    inputs.evidence.incomingFingerprint.length === 0
  ) {
    return unresolved("missing-evidence", "Both decks require source fingerprints");
  }
  // Piecewise geometry: each sliced window must produce at least the
  // overlap's OUTPUT length through the same rate map the renderer uses
  // (native body, stretched overlap regions), and must leave a native
  // body. The overlap is the outgoing deck's TAIL and the incoming
  // deck's HEAD.
  try {
    const outgoingRegions = resolveRateRegions(
      g.outgoingSourceEndMs - g.outgoingSourceStartMs,
      g.outgoingRate,
      0,
      g.overlapMs,
    );
    if (outgoingRegions.at(-1)!.outputEndMs < g.overlapMs) {
      return unresolved("overlap-exceeds-window", "Outgoing window cannot cover the overlap");
    }
  } catch {
    return unresolved("no-native-body", "Outgoing overlap leaves no native body");
  }
  try {
    const incomingRegions = resolveRateRegions(
      g.incomingSourceEndMs - g.incomingSourceStartMs,
      g.incomingRate,
      g.overlapMs,
      0,
    );
    if (incomingRegions.at(-1)!.outputEndMs < g.overlapMs) {
      return unresolved("overlap-exceeds-window", "Incoming window cannot cover the overlap");
    }
  } catch {
    return unresolved("no-native-body", "Incoming overlap leaves no native body");
  }
  const parsed = resolvedJoinContextSchema.safeParse({
    schemaVersion: 1,
    policyVersion: inputs.policyVersion ?? JOIN_RESOLUTION_POLICY_VERSION,
    outgoingEntryId: inputs.outgoingEntryId,
    incomingEntryId: inputs.incomingEntryId,
    transitionId: inputs.transitionId,
    geometry: g,
    alignment: inputs.alignment,
    evidence: inputs.evidence,
    treatment: inputs.treatment,
    gain: inputs.gain,
  });
  if (!parsed.success) {
    return unresolved("invalid-geometry", parsed.error.issues.map((i) => i.message).join("; "));
  }
  return { status: "resolved", context: parsed.data };
}
