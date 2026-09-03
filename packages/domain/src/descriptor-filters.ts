import { normalizeGenre } from "./genres.ts";
import { moodPresetFor, type DescriptorFilters, type DescriptorRange } from "./mood-presets.ts";
import type { Track } from "./track.ts";

export type DescriptorValues = {
  energy?: number | null;
  danceability?: number | null;
  valence?: number | null;
  acousticness?: number | null;
  melodicness?: number | null;
  subBassRatio?: number | null;
  brightness?: number | null;
  suggestedEnergy?: number | null;
};

export function effectiveEnergy(
  track: Pick<Track, "energy">,
  descriptors?: DescriptorValues | null,
): number | null {
  if (track.energy != null) {
    return track.energy;
  }
  if (descriptors?.energy != null) {
    return Math.round(1 + 9 * descriptors.energy);
  }
  return descriptors?.suggestedEnergy ?? null;
}

export function continuousEnergy(
  track: Pick<Track, "energy">,
  descriptors?: DescriptorValues | null,
): number | null {
  if (descriptors?.energy != null) {
    return descriptors.energy;
  }
  if (track.energy != null) {
    return (track.energy - 1) / 9;
  }
  return null;
}

export function descriptorValue(
  key: keyof DescriptorFilters,
  track: Pick<Track, "energy">,
  descriptors?: DescriptorValues | null,
): number | null {
  switch (key) {
    case "energy":
      return continuousEnergy(track, descriptors);
    case "danceability":
      return descriptors?.danceability ?? null;
    case "valence":
      return descriptors?.valence ?? null;
    case "acousticness":
      return descriptors?.acousticness ?? null;
    case "melodicness":
      return descriptors?.melodicness ?? null;
    case "subBass":
      return descriptors?.subBassRatio ?? null;
    case "brightness":
      return descriptors?.brightness ?? null;
  }
}

export function rangeActive(range?: DescriptorRange): boolean {
  return range?.min != null || range?.max != null;
}

export function hasDescriptorFilters(filters?: DescriptorFilters): boolean {
  if (!filters) {
    return false;
  }
  return (Object.keys(filters) as Array<keyof DescriptorFilters>).some((key) =>
    rangeActive(filters[key]),
  );
}

export function valueInRange(value: number | null, range?: DescriptorRange): boolean {
  if (!rangeActive(range)) {
    return true;
  }
  if (value == null) {
    return false;
  }
  if (range?.min != null && value < range.min) {
    return false;
  }
  if (range?.max != null && value > range.max) {
    return false;
  }
  return true;
}

function rangeSatisfaction(value: number | null, range?: DescriptorRange): number {
  if (!rangeActive(range)) {
    return 1;
  }
  if (value == null) {
    return 0;
  }
  if (valueInRange(value, range)) {
    return 1;
  }
  const target = range?.min != null && value < range.min ? range.min : (range?.max ?? value);
  return Math.max(0, 1 - Math.abs(value - target) / 0.35);
}

export function matchesDescriptorFilters(
  track: Pick<Track, "energy">,
  descriptors: DescriptorValues | null | undefined,
  filters?: DescriptorFilters,
): { ok: boolean; reason: "NO_ANALYSIS" | "DESCRIPTOR_OUT_OF_RANGE" | null } {
  if (!hasDescriptorFilters(filters)) {
    return { ok: true, reason: null };
  }
  const needsAnalysis = (Object.keys(filters ?? {}) as Array<keyof DescriptorFilters>).some(
    (key) => key !== "energy" && rangeActive(filters?.[key]),
  );
  if (needsAnalysis && !descriptors) {
    return { ok: false, reason: "NO_ANALYSIS" };
  }
  for (const key of Object.keys(filters ?? {}) as Array<keyof DescriptorFilters>) {
    if (!rangeActive(filters?.[key])) {
      continue;
    }
    if (!valueInRange(descriptorValue(key, track, descriptors), filters?.[key])) {
      return { ok: false, reason: descriptors ? "DESCRIPTOR_OUT_OF_RANGE" : "NO_ANALYSIS" };
    }
  }
  return { ok: true, reason: null };
}

export function moodPresetScore(
  preferredMoods: string[],
  trackMoods: string[],
  track: Pick<Track, "energy">,
  descriptors?: DescriptorValues | null,
): { score: number; route: "manual" | "preset" | "none" } {
  if (preferredMoods.length === 0) {
    return { score: 0, route: "none" };
  }
  if (trackMoods.length > 0) {
    const set = new Set(trackMoods.map((item) => item.toLowerCase()));
    let hits = 0;
    for (const mood of preferredMoods) {
      if (set.has(mood.toLowerCase())) {
        hits += 1;
      }
    }
    return { score: hits / preferredMoods.length, route: "manual" };
  }
  let total = 0;
  for (const mood of preferredMoods) {
    const preset = moodPresetFor(mood);
    if (!preset) {
      continue;
    }
    const keys = (Object.keys(preset) as Array<keyof DescriptorFilters>).filter((key) =>
      rangeActive(preset[key]),
    );
    if (keys.length === 0) {
      continue;
    }
    total +=
      keys.reduce(
        (sum, key) => sum + rangeSatisfaction(descriptorValue(key, track, descriptors), preset[key]),
        0,
      ) / keys.length;
  }
  return { score: total / preferredMoods.length, route: "preset" };
}

export function genresMatchFilter(
  genres: string[] | undefined,
  filter?: { include?: string[]; exclude?: string[] },
): { ok: boolean; reason: "GENRE_MISMATCH" | "GENRE_EXCLUDED" | null } {
  if (!filter) {
    return { ok: true, reason: null };
  }
  const normalized = (genres ?? []).map(normalizeGenre);
  if (filter.include && filter.include.length > 0) {
    const wanted = new Set(filter.include.map(normalizeGenre));
    if (!normalized.some((genre) => wanted.has(genre))) {
      return { ok: false, reason: "GENRE_MISMATCH" };
    }
  }
  if (filter.exclude && filter.exclude.length > 0) {
    const banned = new Set(filter.exclude.map(normalizeGenre));
    if (normalized.some((genre) => banned.has(genre))) {
      return { ok: false, reason: "GENRE_EXCLUDED" };
    }
  }
  return { ok: true, reason: null };
}
