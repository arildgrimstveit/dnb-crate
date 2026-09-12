import { expect, it } from "vitest";
import { resolveRateRegions, sourcePositionToOutputMs, outputPositionToSourceMs } from "../src/rate-regions.ts";

it("maps both 175→174 joins around a native body without accumulating a grid error", () => {
  const overlap = (64 * 60_000) / 174;
  const rate = 174 / 175;
  const regions = resolveRateRegions(60_000, rate, overlap, overlap);
  const [head, body, tail] = regions;
  expect(head!.rate).toBe(rate);
  expect(body!.rate).toBe(1);
  expect(tail!.rate).toBe(rate);
  expect(sourcePositionToOutputMs(regions, head!.sourceEndMs)).toBeCloseTo(overlap, 8);
  expect(sourcePositionToOutputMs(regions, tail!.sourceStartMs)).toBeCloseTo(
    tail!.outputStartMs,
    8,
  );
  expect(sourcePositionToOutputMs(regions, 60_000)).toBeCloseTo(
    60_000 + 2 * overlap * (1 - rate),
    8,
  );
  const back = outputPositionToSourceMs(regions, sourcePositionToOutputMs(regions, tail!.sourceStartMs));
  expect(back).toBeCloseTo(tail!.sourceStartMs, 8);
  expect(() => resolveRateRegions(30_000, rate, overlap, overlap)).toThrow("native body");
});
