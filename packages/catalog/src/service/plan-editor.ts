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
    type: "crossfade" | "phrase_mix" | "bass_swap" | "double_drop";
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

export function applySetPlanUpdate(
  service: PlanEditingService,
  input: UpdateSetPlanInput,
): CreateSetPlanResult {
  const stored = service.requirePlan(input.setPlanId);
  const entries = [...stored.plan.entries].sort((a, b) => a.order - b.order);
  if (input.replaceTrack) {
    const entry = entries.find((item) => item.id === input.replaceTrack!.entryId);
    if (!entry) {
      throw new DomainError("INVALID_SET_PLAN", `No entry ${input.replaceTrack.entryId}`);
    }
    const track = service.requireTrack(input.replaceTrack.trackId);
    const index = entries.indexOf(entry);
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
      playbackRate: 1,
      gainDb: entry.gainDb,
      transitionToNext: null,
    } as (typeof entries)[number];
  }
  if (input.setTrim) {
    const entry = entries.find((item) => item.id === input.setTrim!.entryId);
    if (!entry) {
      throw new DomainError("INVALID_SET_PLAN", `No entry ${input.setTrim.entryId}`);
    }
    entry.sourceStartMs = input.setTrim.sourceStartMs;
    entry.sourceEndMs = input.setTrim.sourceEndMs;
  }
  if (input.setTransition) {
    const entry = entries.find((item) => item.id === input.setTransition!.entryId);
    if (!entry) {
      throw new DomainError("INVALID_SET_PLAN", `No entry ${input.setTransition.entryId}`);
    }
    if (entry.transitionToNext === null) {
      throw new DomainError("INVALID_SET_PLAN", "The last entry has no transition to next");
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
    entry.playbackRate = input.setPlaybackRate.playbackRate;
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
