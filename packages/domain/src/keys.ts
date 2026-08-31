const MAJOR_TO_CAMELOT: Record<string, string> = {
  C: "8B",
  G: "9B",
  D: "10B",
  A: "11B",
  E: "12B",
  B: "1B",
  "F#": "2B",
  Db: "3B",
  Ab: "4B",
  Eb: "5B",
  Bb: "6B",
  F: "7B",
};

const MINOR_TO_CAMELOT: Record<string, string> = {
  Am: "8A",
  Em: "9A",
  Bm: "10A",
  "F#m": "11A",
  "C#m": "12A",
  "G#m": "1A",
  "D#m": "2A",
  Bbm: "3A",
  Fm: "4A",
  Cm: "5A",
  Gm: "6A",
  Dm: "7A",
};

const MAJOR_ROOT: Record<string, string> = {
  C: "C",
  "C#": "Db",
  DB: "Db",
  D: "D",
  "D#": "Eb",
  EB: "Eb",
  E: "E",
  F: "F",
  "F#": "F#",
  GB: "F#",
  G: "G",
  "G#": "Ab",
  AB: "Ab",
  A: "A",
  "A#": "Bb",
  BB: "Bb",
  B: "B",
};

const MINOR_ROOT: Record<string, string> = {
  C: "C",
  "C#": "C#",
  DB: "C#",
  D: "D",
  "D#": "D#",
  EB: "D#",
  E: "E",
  F: "F",
  "F#": "F#",
  GB: "F#",
  G: "G",
  "G#": "G#",
  AB: "G#",
  A: "A",
  "A#": "Bb",
  BB: "Bb",
  B: "B",
};

const CAMELOT_TO_KEY: Record<string, string> = {
  ...Object.fromEntries(Object.entries(MAJOR_TO_CAMELOT).map(([key, camelot]) => [camelot, key])),
  ...Object.fromEntries(Object.entries(MINOR_TO_CAMELOT).map(([key, camelot]) => [camelot, key])),
};

export type NormalizedKey = {
  musicalKey: string;
  camelotKey: string;
  isMinor: boolean;
};

function prep(raw: string): string {
  return raw
    .trim()
    .replaceAll("♯", "#")
    .replaceAll("♭", "b")
    .replace(/major/gi, "")
    .replace(/minor/gi, "m")
    .replace(/min$/i, "m")
    .replaceAll(" ", "");
}

function rootLookupKey(letter: string, accidental: string): string {
  return `${letter}${accidental}`.toUpperCase();
}

/**
 * Normalize a key tag or Camelot code to canonical musical key + Camelot.
 * Returns null when the value cannot be interpreted.
 */
export function normalizeKey(raw: string | null | undefined): NormalizedKey | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const camelotMatch = /^([1-9]|1[0-2])([ABab])$/.exec(trimmed);
  if (camelotMatch) {
    const code = `${camelotMatch[1]}${camelotMatch[2]!.toUpperCase()}`;
    const musicalKey = CAMELOT_TO_KEY[code];
    if (!musicalKey) {
      return null;
    }
    return { musicalKey, camelotKey: code, isMinor: code.endsWith("A") };
  }

  const token = prep(trimmed);
  const parsed = /^([A-Ga-g])([#b])?(m)?$/i.exec(token);
  if (!parsed) {
    return null;
  }

  const letter = parsed[1]!.toUpperCase();
  const accidentalRaw = parsed[2]?.toLowerCase() ?? "";
  const accidental = accidentalRaw === "b" || accidentalRaw === "#" ? accidentalRaw : "";
  const isMinor = parsed[3] !== undefined;
  const lookup = rootLookupKey(letter, accidental);
  const canonicalRoot = isMinor ? MINOR_ROOT[lookup] : MAJOR_ROOT[lookup];
  if (!canonicalRoot) {
    return null;
  }

  const musicalKey = isMinor ? `${canonicalRoot}m` : canonicalRoot;
  const camelot = (isMinor ? MINOR_TO_CAMELOT : MAJOR_TO_CAMELOT)[musicalKey];
  if (!camelot) {
    return null;
  }
  return { musicalKey, camelotKey: camelot, isMinor };
}

export type ParsedCamelot = { number: number; letter: "A" | "B" };

export function parseCamelot(code: string): ParsedCamelot | null {
  const match = /^([1-9]|1[0-2])([ABab])$/.exec(code.trim());
  if (!match) {
    return null;
  }
  return { number: Number(match[1]), letter: match[2]!.toUpperCase() as "A" | "B" };
}

/**
 * Wheel distance: 0 = identical, 1 = relative major/minor or ±1 number,
 * then number-steps plus a letter change.
 */
export function camelotDistance(left: string | null, right: string | null): number | null {
  if (left === null || right === null) {
    return null;
  }
  const a = parseCamelot(left);
  const b = parseCamelot(right);
  if (!a || !b) {
    return null;
  }
  const numberDiff = Math.min((a.number - b.number + 12) % 12, (b.number - a.number + 12) % 12);
  const letterDiff = a.letter === b.letter ? 0 : 1;
  return numberDiff + letterDiff;
}
