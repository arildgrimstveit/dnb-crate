export type DescriptorRange = {
  min?: number;
  max?: number;
  minPct?: number;
  maxPct?: number;
};

export type DescriptorPercentileTriple = { p10: number; p50: number; p90: number } | null;

export type DescriptorPercentiles = {
  energy: DescriptorPercentileTriple;
  danceability: DescriptorPercentileTriple;
  valence: DescriptorPercentileTriple;
  acousticness: DescriptorPercentileTriple;
  melodicness: DescriptorPercentileTriple;
  subBass: DescriptorPercentileTriple;
  brightness: DescriptorPercentileTriple;
};

export function percentileToValue(
  pct: number,
  triple: DescriptorPercentileTriple,
): number | undefined {
  if (!triple) {
    return undefined;
  }
  if (pct <= 10) {
    return triple.p10;
  }
  if (pct >= 90) {
    return triple.p90;
  }
  if (pct <= 50) {
    const t = (pct - 10) / 40;
    return triple.p10 + t * (triple.p50 - triple.p10);
  }
  const t = (pct - 50) / 40;
  return triple.p50 + t * (triple.p90 - triple.p50);
}

export function resolveDescriptorFilters(
  filters: DescriptorFilters | undefined,
  percentiles: DescriptorPercentiles | null | undefined,
): DescriptorFilters | undefined {
  if (!filters) {
    return filters;
  }
  const resolved: DescriptorFilters = {};
  for (const key of Object.keys(filters) as Array<keyof DescriptorFilters>) {
    const range = filters[key];
    if (!range) {
      continue;
    }
    const triple = percentiles?.[key] ?? null;
    const min = range.minPct != null ? percentileToValue(range.minPct, triple) : range.min;
    const max = range.maxPct != null ? percentileToValue(range.maxPct, triple) : range.max;
    resolved[key] = {
      min: min ?? range.min,
      max: max ?? range.max,
    };
  }
  return resolved;
}

export type DescriptorFilters = {
  energy?: DescriptorRange;
  danceability?: DescriptorRange;
  valence?: DescriptorRange;
  acousticness?: DescriptorRange;
  melodicness?: DescriptorRange;
  subBass?: DescriptorRange;
  brightness?: DescriptorRange;
};

export const MOOD_PRESETS: Record<string, DescriptorFilters> = {
  uplifting: { valence: { min: 0.6 }, danceability: { min: 0.6 } },
  dark: { valence: { max: 0.4 }, brightness: { max: 0.1 } },
  liquid: {
    melodicness: { min: 0.55, minPct: 80 },
    energy: { min: 0.35, max: 0.7, minPct: 20, maxPct: 70 },
  },
  soulful: {
    melodicness: { min: 0.55, minPct: 80 },
    energy: { min: 0.35, max: 0.7, minPct: 20, maxPct: 70 },
  },
  "peak-time": { energy: { min: 0.7, minPct: 70 }, subBass: { min: 0.5, minPct: 50 } },
  heavy: { energy: { min: 0.7, minPct: 70 }, subBass: { min: 0.5, minPct: 50 } },
  rolling: { danceability: { min: 0.6 }, brightness: { max: 0.12 } },
  deep: { danceability: { min: 0.6 }, brightness: { max: 0.12 } },
  neuro: { energy: { min: 0.75 }, brightness: { min: 0.12 } },
};

export function moodPresetFor(word: string): DescriptorFilters | null {
  return MOOD_PRESETS[word.trim().toLowerCase()] ?? null;
}
