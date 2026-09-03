import { describe, expect, it } from "vitest";

import {
  alignmentResidualMs,
  firstDropMs,
  joinCamelotDistance,
  plannedLevelStepLu,
} from "../src/render/check-metrics.ts";

describe("render:check v2 metrics", () => {
  it("reports a one-beat applied nudge as residual", () => {
    const beats = Array.from({ length: 32 }, (_, i) => i * 345);
    const residual = alignmentResidualMs(343, beats, beats, 200_000, 343, 1, 1, 345);
    expect(residual).toBe(343);
  });

  it("uses grid cross-correlation when the applied nudge is small", () => {
    const outgoing = Array.from({ length: 32 }, (_, i) => 10_000 + i * 345);
    const incoming = Array.from({ length: 32 }, (_, i) => i * 345);
    const residual = alignmentResidualMs(0, outgoing, incoming, 10_000, 0, 1, 1, 345);
    expect(residual).not.toBeNull();
    expect(Math.abs(residual ?? 99)).toBeLessThan(20);
  });

  it("uses gain-corrected LUFS for the level-match gate", () => {
    expect(plannedLevelStepLu(-8, -12, -4, 0)).toBe(0);
    expect(plannedLevelStepLu(-7.7, -8.4, 0, 0.7)).toBe(0);
    expect(plannedLevelStepLu(null, -8, 0, 0)).toBeNull();
  });

  it("computes camelot distance and first drop", () => {
    expect(joinCamelotDistance("5A", "5B")).toBe(1);
    expect(joinCamelotDistance("5A", "6A")).toBe(1);
    expect(firstDropMs([{ type: "intro", startMs: 0 }, { type: "drop", startMs: 64_000 }])).toBe(
      64_000,
    );
  });
});