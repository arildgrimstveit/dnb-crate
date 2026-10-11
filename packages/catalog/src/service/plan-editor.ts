import type { CreateSetPlanResult, PlanQualityReport, SetPlanV1, Track } from "@dnb-crate/domain";
import { DomainError, assertPlaybackRate } from "@dnb-crate/domain";
import type { SetPlanRepository, StoredSetPlan } from "../set-plan-repository.ts";
import type { TrackRepository } from "../repository.ts";
import { buildEntries, type TimelineAnalysis } from "../planning/timeline.ts";
import { validateSetPlan } from "../planning/validate.ts";
import type { RecipeRecallLookup } from "../planning/recall.ts";

/** What the plan editor needs from the owning service. CatalogService
 * satisfies this structurally (the members are internal-public). */
export type PlanEditingService = {
  requirePlan(setPlanId: string): StoredSetPlan;
  requireTrack(trackId: string): Track;
  toTimeline(track: Track): TimelineAnalysis | null;
  recipeLookupFor(plan: SetPlanV1): RecipeRecallLookup;
  audioEndMsByTrackId(): Map<string, number>;
  effectiveEnergyByTrackId(): Map<string, number>;
  keyConfidenceByTrackId(): Map<string, number>;
  firstDropStartMsByTrackId(): Map<string, number>;
  qualityFor(
    plan: SetPlanV1,
    options: {
      validation: ReturnType<typeof validateSetPlan>;
      partial?: boolean;
      partialReasons?: string[];
    },
  ): PlanQualityReport;
  repository: TrackRepository;
  setPlans: SetPlanRepository;
};

export type UpdateSetPlanInput = {
  setPlanId: string;
  name?: string;
  replaceTrack?: { entryId: string; trackId: string };
  setTrim?: { entryId: string; sourceStartMs: number; sourceEndMs: number };
  setTransition?: {
    entryId: string;
    type: "crossfade" | "phrase_mix" | "bass_swap";
    durationMs: number;
    outgoingCuePointId?: string | null;
    incomingCuePointId?: string | null;
    parameters?: Record<string, number | string | boolean>;
  };
  setPlaybackRate?: { entryId: string; playbackRate: number };
  applyTransition?: {
    entryId: string;
    type: "crossfade" | "phrase_mix" | "bass_swap";
    durationMs: number;
    outgoingCuePointId?: string | null;
    incomingCuePointId?: string | null;
    outgoingPlaybackRate: number;
    incomingPlaybackRate: number;
    outgoingSourceStartMs: number;
    outgoingSourceEndMs: number;
    incomingSourceStartMs: number;
    incomingSourceEndMs: number;
    parameters?: Record<string, number | string | boolean>;
  };
  moveEntry?: { entryId: string; toOrder: number };
};

/**
 * Recorded grid alignment is provenance for the windows it was measured on.
 * When join geometry moves (window trim, transition type/duration, playback
 * rate), these pins go stale but the renderer still applies them verbatim
 * for stored recipe joins (2026-10 listening sessions: stale offsets
 * surfaced as audible flams). Dropping the keys lets render time re-derive
 * the alignment for the new geometry; the reason records which edit kind
 * invalidated it.
 */
const ALIGNMENT_PIN_KEYS = [
  "downbeatOffsetMs",
  "alignmentPeriodMs",
  "alignmentMode",
  "onsetLockBeats",
] as const;

type PlanEntryTransition = StoredSetPlan["plan"]["entries"][number]["transitionToNext"];

function stripAlignmentPins(transition: PlanEntryTransition, reason = "window-edited"): void {
  if (!transition) {
    return;
  }
  let touched = false;
  for (const key of ALIGNMENT_PIN_KEYS) {
    if (key in transition.parameters) {
      const { [key]: _removed, ...rest } = transition.parameters as Record<string, unknown>;
      transition.parameters = rest as typeof transition.parameters;
      touched = true;
    }
  }
  if (touched) {
    transition.parameters.alignmentInvalidated = reason;
  }
}

export function applySetPlanUpdate(
  service: PlanEditingService,
  input: UpdateSetPlanInput,
): CreateSetPlanResult {
  const stored = service.requirePlan(input.setPlanId);
  const entries = [...stored.plan.entries].sort((a, b) => a.order - b.order);
  // Original adjacencies, captured before any mutation applies (F7).
  const originalSorted = [...stored.plan.entries].sort((a, b) => a.order - b.order);
  const originalNextByEntryId = new Map<string, string | null>();
  for (let i = 0; i < originalSorted.length; i += 1) {
    originalNextByEntryId.set(
      originalSorted[i]!.id,
      i + 1 < originalSorted.length ? originalSorted[i + 1]!.trackId : null,
    );
  }
  // S3: pairs changed by replacement, recorded before transitions clear.
  const replacedPairs: string[] = [];
  if (input.replaceTrack) {
    const entry = entries.find((item) => item.id === input.replaceTrack!.entryId);
    if (!entry) {
      throw new DomainError("INVALID_SET_PLAN", `No entry ${input.replaceTrack.entryId}`);
    }
    const track = service.requireTrack(input.replaceTrack.trackId);
    // Same-track replacement is a no-op: nothing is invalidated, no edited
    // marker, no diff churn (S3).
    if (entry.trackId !== track.id) {
      const index = entries.indexOf(entry);
      // S3: record the replaced adjacency BEFORE the transitions are
      // cleared, so the persisted explanation carries an honest edited
      // marker with the changed pairs (the changed-joins loop below skips
      // nulled transitions and previously lost the replacement entirely).
      replacedPairs.push(
        `${index > 0 ? `${entries[index - 1]!.trackId}->${entry.trackId}` : entry.trackId}=>${
          index + 1 < entries.length ? `${track.id}->${entries[index + 1]!.trackId}` : track.id
        }`,
      );
      if (index > 0) {
        entries[index - 1] = { ...entries[index - 1]!, transitionToNext: null };
      }
      if (index + 1 < entries.length) {
        const next = { ...entries[index + 1]! };
        delete (next as { sourceStartMs?: number }).sourceStartMs;
        entries[index + 1] = next;
      }
      entries[index] = {
        id: entry.id,
        trackId: track.id,
        order: entry.order,
        timelineStartMs: entry.timelineStartMs,
        // S3: rate 1 is a PLACEHOLDER, not authority — buildEntries
        // re-derives it from the new pair's targets (and propagates the
        // chain) because this entry carries no pin and its adjacency
        // stamps are gone.
        playbackRate: 1,
        gainDb: entry.gainDb,
        transitionToNext: null,
      } as (typeof entries)[number];
    }
  }
  if (input.setTrim) {
    const entry = entries.find((item) => item.id === input.setTrim!.entryId);
    if (!entry) {
      throw new DomainError("INVALID_SET_PLAN", `No entry ${input.setTrim.entryId}`);
    }
    const startChanged = entry.sourceStartMs !== input.setTrim.sourceStartMs;
    const endChanged = entry.sourceEndMs !== input.setTrim.sourceEndMs;
    entry.sourceStartMs = input.setTrim.sourceStartMs;
    entry.sourceEndMs = input.setTrim.sourceEndMs;
    if (startChanged || endChanged) {
      // A moved window invalidates the recorded grid alignment on both sides
      // of the entry. The renderer honors pinned offsets verbatim for stored
      // recipe joins, so a stale pin becomes an audible flam (2026-10
      // listening sessions); dropping the pins lets render time re-derive.
      stripAlignmentPins(entry.transitionToNext);
      const index = entries.indexOf(entry);
      if (index > 0) {
        stripAlignmentPins(entries[index - 1]!.transitionToNext);
      }
    }
  }
  if (input.setTransition) {
    const entry = entries.find((item) => item.id === input.setTransition!.entryId);
    if (!entry) {
      throw new DomainError("INVALID_SET_PLAN", `No entry ${input.setTransition.entryId}`);
    }
    if (entry.transitionToNext === null) {
      throw new DomainError("INVALID_SET_PLAN", "The last entry has no transition to next");
    }
    // S1: a type or duration change moves the join's geometry — the recorded
    // grid alignment is provenance for the OLD overlap and must not survive
    // verbatim (stale pins become audible flams). No-op edits keep the
    // resolved state.
    const geometryChanged =
      entry.transitionToNext.type !== input.setTransition.type ||
      entry.transitionToNext.durationMs !== input.setTransition.durationMs;
    if (geometryChanged) {
      stripAlignmentPins(entry.transitionToNext, "transition-edited");
    }
    entry.transitionToNext = {
      ...entry.transitionToNext,
      type: input.setTransition.type,
      durationMs: input.setTransition.durationMs,
      outgoingCuePointId:
        input.setTransition.outgoingCuePointId !== undefined
          ? input.setTransition.outgoingCuePointId
          : entry.transitionToNext.outgoingCuePointId,
      incomingCuePointId:
        input.setTransition.incomingCuePointId !== undefined
          ? input.setTransition.incomingCuePointId
          : entry.transitionToNext.incomingCuePointId,
      parameters: input.setTransition.parameters ?? entry.transitionToNext.parameters,
    };
  }
  if (input.setPlaybackRate) {
    const entry = entries.find((item) => item.id === input.setPlaybackRate!.entryId);
    if (!entry) {
      throw new DomainError("INVALID_SET_PLAN", `No entry ${input.setPlaybackRate.entryId}`);
    }
    assertPlaybackRate(input.setPlaybackRate.playbackRate, { allowExcessive: true });
    if (entry.playbackRate !== input.setPlaybackRate.playbackRate) {
      stripAlignmentPins(entry.transitionToNext, "rate-edited");
      const index = entries.indexOf(entry);
      if (index > 0) {
        stripAlignmentPins(entries[index - 1]!.transitionToNext, "rate-edited");
      }
    }
    // S3: an explicit rate edit is an intentional PIN — it survives every
    // later rebuild verbatim, unlike derived chain rates.
    entry.playbackRate = input.setPlaybackRate.playbackRate;
    entry.rateSource = "pinned";
  }
  if (input.applyTransition) {
    const index = entries.findIndex((item) => item.id === input.applyTransition!.entryId);
    if (index < 0 || index >= entries.length - 1) {
      throw new DomainError(
        "INVALID_SET_PLAN",
        `No transition from entry ${input.applyTransition.entryId}`,
      );
    }
    const outgoing = entries[index]!;
    const incoming = entries[index + 1]!;
    if (outgoing.transitionToNext === null) {
      throw new DomainError("INVALID_SET_PLAN", "The last entry has no transition to next");
    }
    assertPlaybackRate(input.applyTransition.outgoingPlaybackRate, { allowExcessive: true });
    assertPlaybackRate(input.applyTransition.incomingPlaybackRate, { allowExcessive: true });
    outgoing.sourceStartMs = Math.min(
      outgoing.sourceStartMs,
      input.applyTransition.outgoingSourceStartMs,
    );
    outgoing.sourceEndMs = input.applyTransition.outgoingSourceEndMs;
    outgoing.playbackRate = input.applyTransition.outgoingPlaybackRate;
    incoming.sourceStartMs = input.applyTransition.incomingSourceStartMs;
    if (incoming.transitionToNext === null) {
      incoming.sourceEndMs = input.applyTransition.incomingSourceEndMs;
    }
    incoming.playbackRate = input.applyTransition.incomingPlaybackRate;
    outgoing.transitionToNext = {
      ...outgoing.transitionToNext,
      type: input.applyTransition.type,
      durationMs: input.applyTransition.durationMs,
      outgoingCuePointId:
        input.applyTransition.outgoingCuePointId !== undefined
          ? input.applyTransition.outgoingCuePointId
          : outgoing.transitionToNext.outgoingCuePointId,
      incomingCuePointId:
        input.applyTransition.incomingCuePointId !== undefined
          ? input.applyTransition.incomingCuePointId
          : outgoing.transitionToNext.incomingCuePointId,
      parameters: input.applyTransition.parameters ?? outgoing.transitionToNext.parameters,
    };
    if (input.applyTransition.parameters === undefined) {
      // Caller moved windows without specifying alignment; carried-over pins
      // describe the OLD windows and the renderer applies them verbatim.
      stripAlignmentPins(outgoing.transitionToNext);
    }
  }
  if (input.moveEntry) {
    const from = entries.findIndex((item) => item.id === input.moveEntry!.entryId);
    if (from < 0) {
      throw new DomainError("INVALID_SET_PLAN", `No entry ${input.moveEntry.entryId}`);
    }
    const [moved] = entries.splice(from, 1);
    const to = Math.min(input.moveEntry.toOrder, entries.length);
    entries.splice(to, 0, moved!);
  }
  // F7 (repository review 2026-10-08): a transition belongs to an ordered
  // PAIR, not just its outgoing track. After any structural edit, drop
  // transitions whose incoming side changed so buildEntries replans them
  // for the new neighbor with fresh cues/automation — carrying A→B's
  // parameters onto A→C keeps B-specific settings on the wrong pair.
  // Adjacencies whose pair is unchanged keep their (possibly approved)
  // treatments. Chain-tempo rates stay as stored; downstream re-derivation
  // on early-pair changes remains deliberate follow-up work.
  const changedJoins: string[] = [...replacedPairs];
  for (let i = 0; i < entries.length - 1; i += 1) {
    const entry = entries[i]!;
    const next = entries[i + 1]!;
    if (!entry.transitionToNext) {
      continue;
    }
    const originalNext = originalNextByEntryId.get(entry.id) ?? null;
    const recorded = entry.transitionToNext.parameters.incomingTrackId;
    const pairChanged = originalNext !== next.trackId;
    if (typeof recorded === "string" && recorded === next.trackId) {
      // The transition was explicitly created for exactly this pair.
      continue;
    }
    if (pairChanged || (typeof recorded === "string" && recorded !== next.trackId)) {
      const previousLabel =
        typeof originalNext === "string" ? `${entry.trackId}->${originalNext}` : entry.trackId;
      changedJoins.push(`${previousLabel}=>${next.trackId}`);
      entry.transitionToNext = null;
    }
  }
  const tracksById = new Map(service.repository.listAll().map((track) => [track.id, track]));
  const orderedTracks = entries.map((entry) => {
    const track = tracksById.get(entry.trackId);
    if (!track) {
      throw new DomainError("TRACK_NOT_FOUND", `Track ${entry.trackId} is missing`);
    }
    return track;
  });
  const rebuilt = buildEntries(
    orderedTracks.map((track) => ({ ...track, analysis: service.toTimeline(track) })),
    undefined,
    new Map(entries.map((entry) => [entry.trackId, entry])),
    { targetBpm: stored.plan.targetBpm, recall: service.recipeLookupFor(stored.plan) },
  );
  const plan: SetPlanV1 = {
    ...stored.plan,
    name: input.name ?? stored.plan.name,
    entries: rebuilt,
    updatedAt: new Date().toISOString(),
  };
  const validation = validateSetPlan(plan, tracksById, {
    audioEndMsByTrackId: service.audioEndMsByTrackId(),
    effectiveEnergyByTrackId: service.effectiveEnergyByTrackId(),
    keyConfidenceByTrackId: service.keyConfidenceByTrackId(),
    firstDropStartMsByTrackId: service.firstDropStartMsByTrackId(),
  });
  if (!validation.valid) {
    throw new DomainError(
      "INVALID_SET_PLAN",
      validation.errors.map((issue) => issue.message).join("; "),
      {
        details: { errors: validation.errors },
      },
    );
  }
  const saved = service.setPlans.save(
    plan,
    stored.seed,
    changedJoins.length > 0
      ? {
          ...stored.explanation,
          // F7: the rankings below describe the pre-edit selection. Changed
          // adjacencies were replanned, so the stored rationale may no
          // longer match the rebuilt plan.
          edited: { at: new Date().toISOString(), changedJoins },
        }
      : stored.explanation,
  );
  const quality = service.qualityFor(saved.plan, { validation, partial: false });
  return {
    plan: saved.plan,
    explanation: saved.explanation,
    validation: { ...validation, quality },
    partial: quality.partial,
    quality,
  };
}

export function cloneSetPlanInto(
  service: PlanEditingService,
  input: { setPlanId: string; name: string; replan?: boolean },
): CreateSetPlanResult {
  const stored = service.requirePlan(input.setPlanId);
  const tracksById = new Map(service.repository.listAll().map((track) => [track.id, track]));
  const ordered = [...stored.plan.entries].sort((a, b) => a.order - b.order);
  const orderedTracks = ordered.map((entry) => {
    const track = tracksById.get(entry.trackId);
    if (!track) {
      throw new DomainError("TRACK_NOT_FOUND", `Track ${entry.trackId} is missing`);
    }
    return track;
  });
  const now = new Date().toISOString();
  const entries = input.replan
    ? buildEntries(
        orderedTracks.map((track) => ({ ...track, analysis: service.toTimeline(track) })),
        undefined,
        new Map(
          ordered
            .filter((entry) => entry.gainDb !== 0)
            .map((entry) => [entry.trackId, { gainDb: entry.gainDb }]),
        ),
        {
          dropAnchored: true,
          targetBpm: stored.plan.targetBpm,
          recall: service.recipeLookupFor(stored.plan),
        },
      )
    : ordered.map((entry) => ({
        ...entry,
        id: crypto.randomUUID(),
        transitionToNext: entry.transitionToNext
          ? { ...entry.transitionToNext, id: crypto.randomUUID() }
          : null,
      }));
  const plan: SetPlanV1 = {
    ...stored.plan,
    id: crypto.randomUUID(),
    name: input.name,
    entries,
    createdAt: now,
    updatedAt: now,
  };
  const validation = validateSetPlan(plan, tracksById, {
    audioEndMsByTrackId: service.audioEndMsByTrackId(),
    effectiveEnergyByTrackId: service.effectiveEnergyByTrackId(),
    keyConfidenceByTrackId: service.keyConfidenceByTrackId(),
    firstDropStartMsByTrackId: service.firstDropStartMsByTrackId(),
  });
  const saved = service.setPlans.save(plan, stored.seed, stored.explanation);
  const quality = service.qualityFor(saved.plan, { validation, partial: false });
  return {
    plan: saved.plan,
    explanation: saved.explanation,
    validation: { ...validation, quality },
    partial: quality.partial,
    quality,
  };
}
