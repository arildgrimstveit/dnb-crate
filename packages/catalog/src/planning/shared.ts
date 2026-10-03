import { normalizePersonName, type Track } from "@dnb-crate/domain";

/** Canonical artist identity for spacing/penalties: the published canonical
 * name when present, else the normalized artist. Shared by the planner and
 * the quality report so both agree on who counts as "the same artist". */
export function artistKey(track: Track): string | null {
  if (track.artistCanonical) {
    return track.artistCanonical;
  }
  return track.artist ? normalizePersonName(track.artist) : null;
}
