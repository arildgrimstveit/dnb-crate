export function normalizePersonName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s*&\s*/g, " and ")
    .replace(/\s+/g, " ");
}

export function stripFeaturing(title: string): string {
  return title
    .replace(/\s*[([]\s*(feat\.?|ft\.?|featuring)\b[^)\]]*[)\]]/gi, "")
    .replace(/\s+[([]\s*(feat\.?|ft\.?|featuring)\b[^)\]]*[)\]]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

const REMIX_TOKEN = /\b(remix|rmx|vip|edit|rework|bootleg|flip)\b/i;

export function remixTokens(title: string): Set<string> {
  const tokens = new Set<string>();
  const lower = title.toLowerCase();
  const matches = lower.match(new RegExp(REMIX_TOKEN, "gi")) ?? [];
  for (const match of matches) {
    tokens.add(match.toLowerCase());
  }
  const named = lower.match(/[([]([^)\]]+)[)\]]/g) ?? [];
  for (const group of named) {
    const inner = group.slice(1, -1).trim().toLowerCase();
    if (REMIX_TOKEN.test(inner)) {
      tokens.add(inner.replace(/\s+/g, " "));
    }
  }
  return tokens;
}

export function titleTokens(title: string): Set<string> {
  return new Set(
    stripFeaturing(title)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1),
  );
}

export function artistTokens(artist: string): Set<string> {
  return new Set(
    normalizePersonName(artist)
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1),
  );
}

export function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) {
    return 1;
  }
  let inter = 0;
  for (const token of left) {
    if (right.has(token)) {
      inter += 1;
    }
  }
  const union = left.size + right.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function yearFromDate(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = /^(\d{4})/.exec(value.trim());
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  return year >= 1900 && year <= 2100 ? year : null;
}

export function recordingKeyFrom(input: {
  recordingMbid?: string | null;
  isrc?: string | null;
  artist?: string | null;
  artistCanonical?: string | null;
  title: string;
  durationMs: number;
}): string {
  if (input.recordingMbid && input.recordingMbid.trim().length > 0) {
    return `mbid:${input.recordingMbid.trim()}`;
  }
  if (input.isrc && input.isrc.trim().length > 0) {
    return `isrc:${input.isrc.trim().toUpperCase()}`;
  }
  const artist = normalizePersonName(input.artistCanonical ?? input.artist ?? "");
  const title = stripFeaturing(input.title).toLowerCase();
  const bucket = Math.round(input.durationMs / 2000);
  return `sig:${artist}|${title}|${bucket}`;
}
