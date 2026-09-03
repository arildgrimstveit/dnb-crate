import { describe, expect, it } from "vitest";

import {
  buildCueSheet,
  buildFfmetadataFile,
  buildMixTracklist,
  escapeFfmetadataValue,
  formatCueIndex,
  formatMixTimestamp,
  mixTagsFromTracklist,
  trackCredit,
} from "../src/output-tags.ts";

describe("mix output tags", () => {
  it("formats credits, timestamps, and a numbered tracklist", () => {
    expect(trackCredit("Pendulum", "Under The Waves")).toBe("Pendulum — Under The Waves");
    expect(trackCredit(null, "Intro")).toBe("Intro");
    expect(formatMixTimestamp(0)).toBe("0:00");
    expect(formatMixTimestamp(264_832)).toBe("4:25");
    expect(formatMixTimestamp(3_583_076)).toBe("59:43");
    expect(formatMixTimestamp(3_661_000)).toBe("1:01:01");
    expect(formatCueIndex(0)).toBe("00:00:00");
    expect(formatCueIndex(3000)).toBe("00:03:00");
    expect(formatCueIndex(265_000)).toBe("04:25:00");
    expect(
      buildMixTracklist([
        { startMs: 0, title: "Under The Waves", artist: "Pendulum" },
        { startMs: 264_832, title: "Chant", artist: "Logistics" },
      ]),
    ).toBe("1. [0:00] Pendulum — Under The Waves\n2. [4:25] Logistics — Chant");
  });

  it("escapes ffmetadata special characters", () => {
    expect(escapeFfmetadataValue("A=B;C#D\\E")).toBe("A\\=B\\;C\\#D\\\\E");
    expect(escapeFfmetadataValue("line1\nline2")).toBe("line1\\\nline2");
  });

  it("writes mix tags and an embedded CUESHEET, not the first source title", () => {
    const tags = mixTagsFromTracklist({
      title: "Peak hour v3",
      date: "2026",
      encodedBy: "dnb-crate 6.5.0",
      tracks: [
        { artist: "Pendulum", title: "Under The Waves", startMs: 0 },
        { artist: "Logistics", title: "Chant", startMs: 264_832 },
        { artist: "Sub Focus", title: "Let The Story Begin", startMs: 480_000 },
      ],
    });
    expect(tags.title).toBe("Peak hour v3");
    expect(tags.artist).toBe("dnb-crate");
    expect(tags.comment).toContain("1. [0:00] Pendulum — Under The Waves");
    expect(tags.comment).not.toContain("FirstTrackOnly");

    const cue = buildCueSheet(tags, 700_000);
    expect(cue).toContain('TITLE "Peak hour v3"');
    expect(cue).toContain("TRACK 01 AUDIO");
    expect(cue).toContain('TITLE "Under The Waves"');
    expect(cue).toContain('PERFORMER "Pendulum"');
    expect(cue).toContain("INDEX 01 00:00:00");
    expect(cue).toContain("TRACK 02 AUDIO");
    expect(cue).toContain("INDEX 01 04:24:62");

    const text = buildFfmetadataFile(tags, 700_000);
    expect(text.startsWith(";FFMETADATA1\n")).toBe(true);
    expect(text).toContain("title=Peak hour v3");
    expect(text).toContain("artist=dnb-crate");
    expect(text).toContain("CUESHEET=");
    expect(text).toContain("TRACK 01 AUDIO");
    expect(text).not.toContain("FirstTrackOnly");
  });

  it("drops cue tracks that start at or after the mix duration", () => {
    const cue = buildCueSheet(
      {
        title: "Short mix",
        chapters: [
          { startMs: 0, title: "One" },
          { startMs: 8_000, title: "Too late" },
        ],
      },
      5_000,
    );
    expect(cue).toContain('TITLE "One"');
    expect(cue).not.toContain("Too late");
  });
});
