import { expect, it } from "vitest";
import { repairSequence } from "../src/planning/repair-search.ts";

it("places a complete required chain by replacing optional material and preserves boundaries", () => {
  const result = repairSequence({
    initial: ["start", "bad1", "bad2", "end"],
    units: [["start"], ["bad1"], ["bad2"], ["a", "b"], ["end"]],
    required: new Set(["a", "b"]),
    start: "start",
    end: "end",
    minDurationMs: 390,
    maxDurationMs: 410,
    evaluate: (ids) =>
      ids.includes("a") && (ids.includes("bad1") || ids.includes("bad2"))
        ? "HARMONY"
        : ids.length * 100,
  });
  expect(result.ids).toEqual(["start", "a", "b", "end"]);
  expect(result.diagnostics.status).toBe("ready");
});

it("repairs a short duration without splitting an existing required chain", () => {
  const result = repairSequence({
    initial: ["a", "b", "end"],
    units: [["a", "b"], ["extra"], ["end"]],
    required: new Set(["a", "b"]),
    start: "a",
    end: "end",
    minDurationMs: 390,
    maxDurationMs: 410,
    evaluate: (ids) => ids.length * 100,
  });
  expect(result.ids).toEqual(["a", "b", "extra", "end"]);
  expect(result.diagnostics.status).toBe("ready");
});

it("keeps a ready sequence unchanged and does not explore alternatives", () => {
  const result = repairSequence({
    initial: ["a", "b"],
    units: [["a"], ["b"], ["extra"]],
    required: new Set(),
    minDurationMs: 190,
    maxDurationMs: 210,
    evaluate: (ids) => ids.length * 100,
  });
  expect(result.ids).toEqual(["a", "b"]);
  expect(result.diagnostics.evaluations).toBe(1);
});

it("ranks optional units by the caller instead of first-twelve pool order", () => {
  const result = repairSequence({
    initial: ["start", "end"],
    units: [
      ["start"],
      ["end"],
      ...Array.from({ length: 12 }, (_, i) => [`noise${i}`]),
      ["bridge"],
    ],
    required: new Set(),
    start: "start",
    end: "end",
    minDurationMs: 290,
    maxDurationMs: 310,
    evaluate: (ids) => (ids.includes("bridge") ? 300 : 200),
    rankOptional: (unit) => (unit[0] === "bridge" ? 10 : 0),
  });
  expect(result.ids).toEqual(["start", "bridge", "end"]);
  expect(result.diagnostics.status).toBe("ready");
});

it("prefers the ready sequence with the higher musical score", () => {
  const result = repairSequence({
    initial: ["a", "end"],
    units: [["a"], ["end"], ["good"], ["bad"]],
    required: new Set(),
    start: "a",
    end: "end",
    minDurationMs: 290,
    maxDurationMs: 310,
    evaluate: (ids) => (ids.length === 3 ? 300 : 200),
    musicalScore: (ids) => (ids.includes("good") ? 20 : ids.includes("bad") ? 1 : 0),
  });
  expect(result.ids).toEqual(["a", "good", "end"]);
  expect(result.diagnostics.musicalScore).toBe(20);
});

it("stops as a harmonic gap when no required unit can attach or be bridged", () => {
  const result = repairSequence({
    initial: ["start", "end"],
    units: [["start"], ["end"], ["far", "pair"], ["unrelated"]],
    required: new Set(["far", "pair"]),
    start: "start",
    end: "end",
    minDurationMs: 390,
    maxDurationMs: 410,
    evaluate: (ids) =>
      ids.includes("far") ? "HARMONY" : ids.length * 100,
    compatible: (left, right) =>
      (left === "start" && right === "end") ||
      (left === "far" && right === "pair"),
  });
  expect(result.diagnostics.status).toBe("harmonic-gap");
  expect(result.ids).toEqual(["start", "end"]);
  expect(result.diagnostics.evaluations).toBeLessThan(20);
});

it("reports deterministic budget exhaustion without treating a rejected chain as feasible", () => {
  const input = {
    initial: ["start", "end"],
    units: [["start"], ["end"], ["a", "b"], ["extra"]],
    required: new Set(["a", "b"]),
    start: "start",
    end: "end",
    minDurationMs: 390,
    maxDurationMs: 410,
    maxEvaluations: 2,
    evaluate: (ids: string[]) => (ids.includes("a") ? "EXACT_RECIPE" : ids.length * 100),
  };
  const result = repairSequence(input);
  expect(repairSequence(input)).toEqual(result);
  expect(result.diagnostics.status).toBe("budget-exhausted");
  expect(result.diagnostics.evaluations).toBeLessThanOrEqual(2);
  expect(result.diagnostics.rejectionCounts.EXACT_RECIPE).toBeGreaterThan(0);
  expect(result.ids).not.toContain("a");
});
