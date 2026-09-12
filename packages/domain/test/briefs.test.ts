import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createSetPlanInputSchema } from "../src/contracts.ts";
import { resolveTargetDurationMs } from "../src/constants.ts";

describe("hour briefs", () => {
  it("parses the liquid example as a floating-tempo drop-anchored hour", () => {
    const raw = JSON.parse(
      readFileSync(path.join(process.cwd(), "docs/examples/liquid-hour.example.brief.json"), "utf8"),
    ) as unknown;
    const parsed = createSetPlanInputSchema.parse(raw);
    expect(parsed.dropAnchored).toBe(true);
    expect(parsed.name).toBe("Liquid hour");
    expect(parsed.preferredSubgenres).toContain("liquid funk");
    expect(parsed.targetBpm).toBeUndefined();
  });

  it("parses the peak example without an hour tempo lock", () => {
    const raw = JSON.parse(
      readFileSync(path.join(process.cwd(), "docs/examples/peak-hour.example.brief.json"), "utf8"),
    ) as unknown;
    const parsed = createSetPlanInputSchema.parse(raw);
    expect(parsed.dropAnchored).toBe(true);
    expect(parsed.targetBpm).toBeUndefined();
    expect(parsed.name).toBe("Peak hour");
  });

  it("accepts a minutes duration request", () => {
    const parsed = createSetPlanInputSchema.parse({
      name: "Twenty minutes",
      targetDurationMinutes: 20,
    });
    expect(parsed.targetDurationMinutes).toBe(20);
    expect(resolveTargetDurationMs(parsed)).toBe(1_200_000);
  });

  it("defaults omitted duration to one hour", () => {
    expect(resolveTargetDurationMs({})).toBe(3_600_000);
    expect(resolveTargetDurationMs({ targetDurationMinutes: 90 })).toBe(5_400_000);
    expect(resolveTargetDurationMs({ targetDurationMs: 1_200_000, targetDurationMinutes: 25 })).toBe(
      1_500_000,
    );
  });
});
