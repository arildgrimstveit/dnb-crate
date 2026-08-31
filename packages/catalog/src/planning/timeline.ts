import {
  DEFAULT_TRANSITION_OVERLAP_MS,
  MIN_PLAYABLE_DURATION_MS,
  type SetPlanEntry,
  type Track,
  type TransitionPlan,
} from "@dnb-crate/domain";

export type TimelineTrack = Pick<Track, "id" | "durationMs">;

export function defaultPlayableWindow(track: TimelineTrack): {
  sourceStartMs: number;
  sourceEndMs: number;
} {
  return { sourceStartMs: 0, sourceEndMs: track.durationMs };
}

export function playableMs(entry: Pick<SetPlanEntry, "sourceStartMs" | "sourceEndMs">): number {
  return Math.max(0, entry.sourceEndMs - entry.sourceStartMs);
}

export function playableOutputMs(
  entry: Pick<SetPlanEntry, "sourceStartMs" | "sourceEndMs" | "playbackRate">,
): number {
  const rate = entry.playbackRate > 0 ? entry.playbackRate : 1;
  return playableMs(entry) / rate;
}

export function overlapFor(transition: TransitionPlan | null): number {
  return transition?.durationMs ?? DEFAULT_TRANSITION_OVERLAP_MS;
}

export function buildEntries(
  tracks: TimelineTrack[],
  overlapMs = DEFAULT_TRANSITION_OVERLAP_MS,
  existing?: Map<string, Partial<SetPlanEntry>>,
): SetPlanEntry[] {
  const entries: SetPlanEntry[] = [];
  let timeline = 0;
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]!;
    const prior = existing?.get(track.id);
    const window = defaultPlayableWindow(track);
    const sourceStartMs = prior?.sourceStartMs ?? window.sourceStartMs;
    const sourceEndMs = prior?.sourceEndMs ?? window.sourceEndMs;
    const isLast = index === tracks.length - 1;
    const transitionToNext: TransitionPlan | null = isLast
      ? null
      : (prior?.transitionToNext ?? {
          id: crypto.randomUUID(),
          type: "crossfade",
          durationMs: overlapMs,
          outgoingCuePointId: null,
          incomingCuePointId: null,
          parameters: { purpose: "stage2-timing-only" },
        });
    const playbackRate = prior?.playbackRate && prior.playbackRate > 0 ? prior.playbackRate : 1;
    entries.push({
      id: prior?.id ?? crypto.randomUUID(),
      trackId: track.id,
      order: index,
      sourceStartMs,
      sourceEndMs,
      timelineStartMs: timeline,
      playbackRate,
      gainDb: prior?.gainDb ?? 0,
      transitionToNext,
    });
    const playable = playableOutputMs({ sourceStartMs, sourceEndMs, playbackRate });
    const overlap = isLast ? 0 : Math.min(overlapFor(transitionToNext), Math.max(0, playable - 1));
    timeline += playable - overlap;
  }
  return entries;
}

export function planDurationMs(entries: SetPlanEntry[]): number {
  const last = entries[entries.length - 1];
  if (!last) {
    return 0;
  }
  return last.timelineStartMs + playableOutputMs(last);
}

export function assertPlayableWindow(
  track: TimelineTrack,
  sourceStartMs: number,
  sourceEndMs: number,
): void {
  if (sourceStartMs < 0 || sourceEndMs <= sourceStartMs) {
    throw new Error("invalid source window");
  }
  if (sourceEndMs > track.durationMs) {
    throw new Error("source window exceeds track duration");
  }
  if (
    sourceEndMs - sourceStartMs < MIN_PLAYABLE_DURATION_MS &&
    track.durationMs >= MIN_PLAYABLE_DURATION_MS
  ) {
    throw new Error("playable duration below minimum");
  }
}
