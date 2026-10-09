import { describe, expect, it } from "vitest";

import { recordingFamilyKeyFrom, stripVariantLabels } from "../src/identity.ts";

describe("edition variant families", () => {
  it("strips edition labels so variants share a family", () => {
    expect(stripVariantLabels("Heartbeat Loud")).toBe("heartbeat loud");
    expect(stripVariantLabels("Heartbeat Loud - Extended Version")).toBe("heartbeat loud");
    expect(stripVariantLabels("Heartbeat Loud (Extended Mix)")).toBe("heartbeat loud");
    expect(stripVariantLabels("Come Back Home (Radio Edit)")).toBe("come back home");
    expect(stripVariantLabels("Fine Day (VIP)")).toBe("fine day");
  });

  it("keeps remix labels, which are distinct productions", () => {
    expect(stripVariantLabels("Turn Back Time - Wilkinson Remix")).not.toBe("turn back time");
    expect(stripVariantLabels("Hometown Glory - High Contrast Remix")).not.toBe("hometown glory");
  });

  it("keeps featuring credit stripping and ignores punctuation variants", () => {
    expect(stripVariantLabels("One More Chance (feat. Ruth Royall) [Extended Version]")).toBe(
      "one more chance",
    );
    expect(recordingFamilyKeyFrom({ artist: "Andy C", title: "Heartbeat Loud" })).toBe(
      recordingFamilyKeyFrom({
        artist: "Andy C",
        title: "Heartbeat Loud - Extended Version",
      }),
    );
  });

  it("prefers the canonical artist for the family key", () => {
    expect(
      recordingFamilyKeyFrom({ artist: "Shown", artistCanonical: "real name", title: "Song" }),
    ).toBe(
      recordingFamilyKeyFrom({ artist: "Other", artistCanonical: "real name", title: "Song" }),
    );
  });

  it("collapses a named remix into the original's family for plan dedup", () => {
    // Owner verdict, 9 October 2026: two Rock Its in one hour is the same
    // tune twice. The remixer credit ("Sub Focus, Wilkinson") must not
    // split the family — the primary artist carries it.
    expect(recordingFamilyKeyFrom({ artist: "Sub Focus", title: "Rock It" })).toBe(
      recordingFamilyKeyFrom({
        artist: "Sub Focus, Wilkinson",
        title: "Rock It - Wilkinson Remix",
      }),
    );
    expect(recordingFamilyKeyFrom({ artist: "Nero", title: "Holdin' On" })).toBe(
      recordingFamilyKeyFrom({
        artist: "Nero, Skrillex",
        title: "Holdin' On - Skrillex & Nero Remix",
      }),
    );
    expect(recordingFamilyKeyFrom({ artist: "Wilkinson", title: "Turn Back Time (Remix)" })).toBe(
      recordingFamilyKeyFrom({ artist: "Wilkinson", title: "Turn Back Time" }),
    );
  });

  it("keeps genuinely different songs in different families", () => {
    expect(recordingFamilyKeyFrom({ artist: "Sub Focus", title: "Rock It" })).not.toBe(
      recordingFamilyKeyFrom({ artist: "Sub Focus", title: "Tidal Wave" }),
    );
    expect(recordingFamilyKeyFrom({ artist: "Sub Focus", title: "Rock It" })).not.toBe(
      recordingFamilyKeyFrom({ artist: "Wilkinson", title: "Rock It" }),
    );
  });
});
