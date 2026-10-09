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
});
