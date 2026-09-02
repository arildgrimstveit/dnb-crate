import { describe, expect, it } from "vitest";

import { resolveCanonicalBpm, resolveCanonicalKey } from "../src/analysis.ts";

describe("canonical provenance", () => {
  it("prefers manual over published over analyzed over tag for BPM", () => {
    expect(
      resolveCanonicalBpm(
        { bpm: 170, bpmSource: "manual" },
        { bpm: 174, gridRejected: false },
      ),
    ).toEqual({ bpm: 170, source: "manual" });
    expect(
      resolveCanonicalBpm(
        { bpm: 174, bpmSource: "published" },
        { bpm: 176, gridRejected: false },
      ),
    ).toEqual({ bpm: 174, source: "published" });
    expect(
      resolveCanonicalBpm({ bpm: 140, bpmSource: "tag" }, { bpm: 174, gridRejected: false }),
    ).toEqual({ bpm: 174, source: "analyzed" });
    expect(
      resolveCanonicalBpm({ bpm: 140, bpmSource: "tag" }, { bpm: 174, gridRejected: true }),
    ).toEqual({ bpm: 140, source: "tag" });
  });

  it("prefers published key over analyzed", () => {
    expect(
      resolveCanonicalKey(
        { musicalKey: "Fm", keySource: "published" },
        { musicalKey: "Gm", keyConfidence: 0.9 },
      ),
    ).toEqual({ musicalKey: "Fm", source: "published" });
  });
});
