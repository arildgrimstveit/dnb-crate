import { describe, expect, it } from "vitest";

import { buildCohortCompareReport, titleMatchesCohort } from "../src/analysis/cohort-compare.ts";
import { parseKeyStdout } from "../src/analysis/key-engine.ts";

describe("cohort compare report", () => {
  it("splits held-out before promotion and leaves key accuracy unmeasured without labels", () => {
    const report = buildCohortCompareReport(
      [
        {
          trackId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          title: "Alpha",
          publishedBpm: 174,
          canonicalKey: null,
          canonicalKeySource: null,
          engines: [
            {
              analyzerName: "dnb-crate-dsp",
              bpm: 174,
              gridRejected: false,
              downbeatTimesMs: [0, 1379, 2758],
              beatTimesMs: [0, 345, 689],
              musicalKey: "Fm",
              keyConfidence: 0.2,
              engineRuntimeMs: 10,
            },
            {
              analyzerName: "beat-this",
              bpm: 176,
              gridRejected: false,
              downbeatTimesMs: [20, 1399, 2778],
              beatTimesMs: [0, 341, 682],
              musicalKey: null,
              keyConfidence: null,
              engineRuntimeMs: 40,
            },
          ],
        },
        {
          trackId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          title: "Zulu",
          publishedBpm: 174,
          canonicalKey: "Fm",
          canonicalKeySource: "manual",
          engines: [
            {
              analyzerName: "dnb-crate-dsp",
              bpm: 174,
              gridRejected: false,
              downbeatTimesMs: [0, 1379],
              beatTimesMs: [0, 345],
              musicalKey: "Fm",
              keyConfidence: 0.8,
              engineRuntimeMs: 10,
            },
          ],
        },
      ],
      { beatThis: true, keyEngine: null },
    );
    expect(report.promoted).toBe(false);
    expect(report.tracks[0]?.split).toBe("calibration");
    expect(report.tracks[1]?.split).toBe("held-out");
    expect(report.tracks[0]?.bpmDisagree).toBe(true);
    expect(report.tracks[0]?.keyAccuracy).toBe("unmeasured");
    expect(report.tracks[1]?.keyAccuracy).toBe("exact");
    expect(report.counts.bpmDisagree).toBe(1);
    expect(report.legacyBpmPromotionRule.cannotAlonePromote).toBe(true);
    expect(report.legacyBpmPromotionRule.wouldHaveTriggered).toBe(false);
    expect(titleMatchesCohort("Chant", "Chant")).toBe(true);
    expect(titleMatchesCohort("Hayling (Feat. Emer Dineen)", "Hayling")).toBe(true);
    expect(
      titleMatchesCohort("Everybody Loves The Sunshine (feat. Daddy Waku & Chantal Kashala)", "Chant"),
    ).toBe(false);
  });
});

describe("key engine parse", () => {
  it("reads Essentia JSON and KeyFinder tokens", () => {
    expect(parseKeyStdout(JSON.stringify({ musicalKey: "Fm", keyConfidence: 0.81 }), "essentia-key")).toEqual({
      musicalKey: "Fm",
      camelotKey: "4A",
      keyConfidence: 0.81,
    });
    expect(parseKeyStdout("5A", "keyfinder").camelotKey).toBe("5A");
    expect(parseKeyStdout("Am", "keyfinder")).toEqual({
      musicalKey: "Am",
      camelotKey: "8A",
      keyConfidence: 0.7,
    });
  });
});
