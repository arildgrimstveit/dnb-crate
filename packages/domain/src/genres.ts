const ALIASES: Record<string, string> = {
  "drum & bass": "drum and bass",
  "drum n bass": "drum and bass",
  "drum'n'bass": "drum and bass",
  dnb: "drum and bass",
  "d&b": "drum and bass",
  "liquid drum and bass": "liquid funk",
  liquid: "liquid funk",
  jungle: "jungle",
  neurofunk: "neurofunk",
  "jump up": "jump up",
  techstep: "techstep",
  idm: "idm",
  ambient: "ambient",
  rock: "rock",
  house: "house",
  techno: "techno",
  breakbeat: "breakbeat",
  electronic: "electronic",
};

const DNB_LABELS = new Set([
  "drum and bass",
  "liquid funk",
  "jungle",
  "neurofunk",
  "jump up",
  "techstep",
]);

export function normalizeGenre(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    return trimmed;
  }
  return ALIASES[trimmed] ?? trimmed;
}

export function normalizeGenres(values: string[]): string[] {
  return [...new Set(values.map(normalizeGenre).filter((item) => item.length > 0))].sort();
}

export function isDrumAndBassGenre(value: string): boolean {
  return DNB_LABELS.has(normalizeGenre(value));
}

export function hasDrumAndBassGenre(values: string[]): boolean {
  return values.some((item) => isDrumAndBassGenre(item));
}
