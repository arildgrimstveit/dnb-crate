import { expect, it } from "vitest";
import { expandPreset } from "../src/mix-presets.ts";

it("coordinates audition mid/high fades without changing the bass transfer or default", () => {
  const baseline = expandPreset("phrase_mix", { phraseShape: "sequential" }, 16, 1000);
  expect(baseline).toEqual(
    expandPreset(
      "phrase_mix",
      { phraseShape: "sequential", sequentialHandoff: "legacy" },
      16,
      1000,
    ),
  );
  for (const variant of ["early", "supported"] as const) {
    const events = expandPreset(
      "phrase_mix",
      { phraseShape: "sequential", sequentialHandoff: variant },
      16,
      1000,
    );
    expect(events.filter((event) => event.target.endsWith("_low"))).toEqual(
      baseline.filter((event) => event.target.endsWith("_low")),
    );
    const incoming = events.find((event) => event.target === "incoming_mid")!;
    const outgoing = events.find((event) => event.target === "outgoing_mid")!;
    expect(incoming.atMs).toBe(0);
    expect(incoming.durationMs).toBe(outgoing.durationMs);
    expect(incoming.durationMs).toBe(variant === "early" ? 8000 : 16000);
  }
});
