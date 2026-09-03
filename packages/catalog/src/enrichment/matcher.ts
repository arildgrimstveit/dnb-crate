import {
  artistTokens,
  jaccard,
  remixTokens,
  stripFeaturing,
  titleTokens,
} from "@dnb-crate/domain";

export type MatchCandidate = {
  title: string;
  artist: string;
  durationMs: number | null;
  status?: string | null;
};

export type MatchScore = {
  score: number;
  title: number;
  artist: number;
  duration: number;
  accept: boolean;
  needsReview: boolean;
};

export function scoreMatch(
  query: { title: string; artist: string | null; durationMs: number },
  candidate: MatchCandidate,
): MatchScore {
  const queryRemix = remixTokens(query.title);
  const candRemix = remixTokens(candidate.title);
  if (queryRemix.size !== candRemix.size || [...queryRemix].some((token) => !candRemix.has(token))) {
    return { score: 0, title: 0, artist: 0, duration: 0, accept: false, needsReview: false };
  }
  const title = jaccard(titleTokens(stripFeaturing(query.title)), titleTokens(stripFeaturing(candidate.title)));
  const artist = jaccard(artistTokens(query.artist ?? ""), artistTokens(candidate.artist));
  let duration = 0.5;
  if (candidate.durationMs != null) {
    const delta = Math.abs(candidate.durationMs - query.durationMs);
    duration = delta <= 3000 ? 1 : delta <= 6000 ? 0.4 : 0;
  }
  const score = 0.5 * title + 0.3 * artist + 0.2 * duration;
  const officialBoost = candidate.status?.toLowerCase() === "official" ? 0.02 : 0;
  const finalScore = Math.min(1, score + officialBoost);
  return {
    score: Number(finalScore.toFixed(4)),
    title: Number(title.toFixed(4)),
    artist: Number(artist.toFixed(4)),
    duration: Number(duration.toFixed(4)),
    accept: finalScore >= 0.85 && artist >= 0.6 && duration > 0,
    needsReview: finalScore >= 0.6 && finalScore < 0.85,
  };
}

export function pickBestMatch<T extends MatchCandidate>(
  query: { title: string; artist: string | null; durationMs: number },
  candidates: T[],
): { candidate: T; match: MatchScore } | null {
  let best: { candidate: T; match: MatchScore } | null = null;
  for (const candidate of candidates) {
    const match = scoreMatch(query, candidate);
    if (!best || match.score > best.match.score) {
      best = { candidate, match };
    }
  }
  return best;
}
