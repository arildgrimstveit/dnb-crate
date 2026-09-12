import { describe, expect, it } from "vitest";

import { buildClickTrackPcm, encodeMonoWav } from "../src/click-track.ts";
import { decodeWavPcm } from "../src/wav.ts";

describe("click-track WAV fixtures", () => {
  it("round-trips click WAV decode", () => {
    const pcm = buildClickTrackPcm({ bpm: 174, durationMs: 500 });
    const decoded = decodeWavPcm(encodeMonoWav(pcm));
    expect(decoded.sampleRateHz).toBe(pcm.sampleRateHz);
    expect(decoded.samples.length).toBe(pcm.samples.length);
  });
});
