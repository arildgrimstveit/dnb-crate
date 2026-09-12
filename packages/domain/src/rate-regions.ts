import { effectivePlaybackRate } from "./tempo.ts";

export type RateRegion = {
  role: "head" | "body" | "tail";
  sourceStartMs: number;
  sourceEndMs: number;
  outputStartMs: number;
  outputEndMs: number;
  rate: number;
};

/** Piecewise mapping for join-only source preparation; coordinates are relative to the trim. */
export function resolveRateRegions(
  sourceMs: number,
  requestedRate: number,
  headMs = 0,
  tailMs = 0,
): RateRegion[] {
  if (
    ![sourceMs, requestedRate, headMs, tailMs].every(Number.isFinite) ||
    sourceMs <= 0 ||
    requestedRate <= 0 ||
    headMs < 0 ||
    tailMs < 0
  )
    throw new Error("Invalid rate-region input");
  const headRate = effectivePlaybackRate(requestedRate, headMs);
  const tailRate = effectivePlaybackRate(requestedRate, tailMs);
  const headSource = headMs * headRate;
  const tailSource = tailMs * tailRate;
  if (headSource + tailSource >= sourceMs)
    throw new Error("Head and tail regions leave no native body");
  const bodySource = sourceMs - headSource - tailSource;
  return [
    {
      role: "head",
      sourceStartMs: 0,
      sourceEndMs: headSource,
      outputStartMs: 0,
      outputEndMs: headMs,
      rate: headRate,
    },
    {
      role: "body",
      sourceStartMs: headSource,
      sourceEndMs: sourceMs - tailSource,
      outputStartMs: headMs,
      outputEndMs: headMs + bodySource,
      rate: 1,
    },
    {
      role: "tail",
      sourceStartMs: sourceMs - tailSource,
      sourceEndMs: sourceMs,
      outputStartMs: headMs + bodySource,
      outputEndMs: headMs + bodySource + tailMs,
      rate: tailRate,
    },
  ];
}

export function sourcePositionToOutputMs(regions: RateRegion[], positionMs: number): number {
  const region =
    regions.find((r) => positionMs >= r.sourceStartMs && positionMs < r.sourceEndMs) ??
    (positionMs === regions.at(-1)?.sourceEndMs ? regions.at(-1) : undefined);
  if (!region) throw new Error("Source position outside prepared regions");
  return region.outputStartMs + (positionMs - region.sourceStartMs) / region.rate;
}

export function outputPositionToSourceMs(regions: RateRegion[], positionMs: number): number {
  const region =
    regions.find((r) => positionMs >= r.outputStartMs && positionMs < r.outputEndMs) ??
    (positionMs === regions.at(-1)?.outputEndMs ? regions.at(-1) : undefined);
  if (!region) throw new Error("Output position outside prepared regions");
  return region.sourceStartMs + (positionMs - region.outputStartMs) * region.rate;
}

export type RateRegionsResolution = {
  version: 1 | 2;
  source: "plan" | "uniform-transitions" | "legacy-any-marker" | "default";
  unknownVersions: number[];
};

type VersionedTransition = {
  parameters?: Record<string, number | string | boolean> | null;
} | null;

/** Plan-level timing version. Existing mixed markers keep the previous any-2 opt-in. */
export function resolvePlanRateRegionsVersion(plan: {
  rateRegionsVersion?: unknown;
  entries: Array<{ transitionToNext?: VersionedTransition }>;
}): RateRegionsResolution {
  const unknownVersions: number[] = [];
  const planLevel = plan.rateRegionsVersion;
  if (planLevel === 2) return { version: 2, source: "plan", unknownVersions };
  if (planLevel === 1) return { version: 1, source: "plan", unknownVersions };
  if (planLevel != null && planLevel !== undefined) {
    const numeric = typeof planLevel === "number" ? planLevel : Number(planLevel);
    if (Number.isFinite(numeric) && numeric !== 1 && numeric !== 2) unknownVersions.push(numeric);
  }
  const joins = plan.entries.filter((entry) => entry.transitionToNext != null);
  const marked = joins.map((entry) => entry.transitionToNext?.parameters?.rateRegionsVersion);
  for (const value of marked) {
    if (value == null) continue;
    const numeric = typeof value === "number" ? value : Number(value);
    if (numeric !== 1 && numeric !== 2 && Number.isFinite(numeric)) unknownVersions.push(numeric);
  }
  const v2 = marked.filter((value) => value === 2).length;
  if (v2 === 0) return { version: 1, source: "default", unknownVersions };
  if (v2 === joins.length) return { version: 2, source: "uniform-transitions", unknownVersions };
  return { version: 2, source: "legacy-any-marker", unknownVersions };
}
