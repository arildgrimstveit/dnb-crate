export type DescriptorRange = {
  min?: number;
  max?: number;
};

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
  liquid: { melodicness: { min: 0.55 }, energy: { min: 0.35, max: 0.7 } },
  soulful: { melodicness: { min: 0.55 }, energy: { min: 0.35, max: 0.7 } },
  "peak-time": { energy: { min: 0.7 }, subBass: { min: 0.5 } },
  heavy: { energy: { min: 0.7 }, subBass: { min: 0.5 } },
  rolling: { danceability: { min: 0.6 }, brightness: { max: 0.12 } },
  deep: { danceability: { min: 0.6 }, brightness: { max: 0.12 } },
  neuro: { energy: { min: 0.75 }, brightness: { min: 0.12 } },
};

export function moodPresetFor(word: string): DescriptorFilters | null {
  return MOOD_PRESETS[word.trim().toLowerCase()] ?? null;
}
