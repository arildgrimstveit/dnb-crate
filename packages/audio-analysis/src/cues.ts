import { barIndexForBeat, snapToNearestBeat } from "@dnb-crate/domain";

import type { AnalyzerCue } from "./types.ts";

export function attachBarIndices(
  cues: AnalyzerCue[],
  beatTimesMs: number[],
): Array<AnalyzerCue & { beatIndex: number | null; barIndex: number | null }> {
  return cues.map((cue) => {
    const snapped = snapToNearestBeat(cue.positionMs, beatTimesMs);
    return {
      ...cue,
      beatIndex: snapped?.beatIndex ?? null,
      barIndex: snapped ? barIndexForBeat(snapped.beatIndex) : null,
    };
  });
}
