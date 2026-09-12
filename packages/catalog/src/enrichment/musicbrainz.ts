import { APP_NAME, APP_VERSION, normalizeGenres } from "@dnb-crate/domain";

import type { HttpClient } from "./http-client.ts";
import { redactUrl } from "./http-client.ts";
import type { RateLimiter } from "./rate-limiter.ts";
import type { ResponseCache } from "./response-cache.ts";

export type MbRecording = {
  id: string;
  title: string;
  length: number | null;
  status: string | null;
  artist: string;
  artistMbids: string[];
  isrcs: string[];
  releaseMbid: string | null;
  releaseGroupMbid: string | null;
  firstReleaseDate: string | null;
  genres: string[];
};

export type MbRelease = {
  id: string;
  date: string | null;
  label: string | null;
  catalogNumber: string | null;
  firstReleaseDate: string | null;
};

function userAgent(contact?: string): string {
  const extra = contact && contact.trim().length > 0 ? ` ( ${contact.trim()} )` : "";
  return `${APP_NAME}/${APP_VERSION}${extra}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function artistCreditName(raw: unknown): { name: string; ids: string[] } {
  const credits = asArray(raw);
  const names: string[] = [];
  const ids: string[] = [];
  for (const item of credits) {
    const row = asRecord(item);
    const artist = asRecord(row.artist);
    if (typeof row.name === "string") {
      names.push(row.name);
    } else if (typeof artist.name === "string") {
      names.push(artist.name);
    }
    if (typeof artist.id === "string") {
      ids.push(artist.id);
    }
  }
  return { name: names.join(" & "), ids };
}

function mapRecording(raw: unknown): MbRecording | null {
  const row = asRecord(raw);
  if (typeof row.id !== "string" || typeof row.title !== "string") {
    return null;
  }
  const credit = artistCreditName(row["artist-credit"]);
  const releases = asArray(row.releases).map(asRecord);
  const official =
    releases.find(
      (item) => (typeof item.status === "string" ? item.status : "").toLowerCase() === "official",
    ) ?? releases[0];
  const group = asRecord(row["release-group"] ?? official?.["release-group"]);
  const genres = [
    ...asArray(row.genres).map((item) => asRecord(item).name),
    ...asArray(row.tags)
      .filter((item) => Number(asRecord(item).count ?? 0) >= 2)
      .map((item) => asRecord(item).name),
  ].filter((name): name is string => typeof name === "string");
  return {
    id: row.id,
    title: row.title,
    length: typeof row.length === "number" ? row.length : null,
    status: typeof official?.status === "string" ? official.status : null,
    artist: credit.name,
    artistMbids: credit.ids,
    isrcs: asArray(row.isrcs).filter((item): item is string => typeof item === "string"),
    releaseMbid: typeof official?.id === "string" ? official.id : null,
    releaseGroupMbid: typeof group.id === "string" ? group.id : null,
    firstReleaseDate:
      typeof group["first-release-date"] === "string"
        ? group["first-release-date"]
        : typeof official?.date === "string"
          ? official.date
          : null,
    genres: normalizeGenres(genres),
  };
}

export class MusicBrainzClient {
  constructor(
    private readonly http: HttpClient,
    private readonly limiter: RateLimiter,
    private readonly cache: ResponseCache,
    private readonly contact?: string,
  ) {}

  async lookupRecording(mbid: string): Promise<MbRecording | null> {
    const url = `https://musicbrainz.org/ws/2/recording/${encodeURIComponent(mbid)}?inc=artist-credits+isrcs+releases+release-groups+genres+tags&fmt=json`;
    const json = await this.getJson(url);
    return mapRecording(json);
  }

  async lookupIsrc(isrc: string): Promise<MbRecording[]> {
    const encoded = encodeURIComponent(isrc);
    const urls = [
      `https://musicbrainz.org/ws/2/isrc/${encoded}?inc=artist-credits+releases&fmt=json`,
      `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(`isrc:${isrc}`)}&fmt=json&limit=10`,
    ];
    for (const url of urls) {
      const json = await this.getJson(url, { ignoreClientErrors: true });
      if (json == null) {
        continue;
      }
      const mapped = asArray(asRecord(json).recordings)
        .map(mapRecording)
        .filter((row): row is MbRecording => row !== null);
      if (mapped.length > 0) {
        return mapped;
      }
    }
    return [];
  }

  async searchRecordings(
    title: string,
    artist: string,
    durationMs: number,
  ): Promise<MbRecording[]> {
    const window = 4000;
    const query = `recording:"${title.replaceAll('"', "")}" AND artist:"${artist.replaceAll('"', "")}" AND dur:[${Math.max(0, durationMs - window)} TO ${durationMs + window}]`;
    const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=10`;
    const json = asRecord(await this.getJson(url));
    return asArray(json.recordings)
      .map(mapRecording)
      .filter((row): row is MbRecording => row !== null);
  }

  async lookupRelease(mbid: string): Promise<MbRelease | null> {
    const url = `https://musicbrainz.org/ws/2/release/${encodeURIComponent(mbid)}?inc=labels+release-groups&fmt=json`;
    const json = asRecord(await this.getJson(url));
    if (typeof json.id !== "string") {
      return null;
    }
    const labels = asArray(json["label-info"]).map(asRecord);
    const first = labels[0] ?? {};
    const group = asRecord(json["release-group"]);
    return {
      id: json.id,
      date: typeof json.date === "string" ? json.date : null,
      label:
        typeof asRecord(first.label).name === "string" ? String(asRecord(first.label).name) : null,
      catalogNumber:
        typeof first["catalog-number"] === "string" ? String(first["catalog-number"]) : null,
      firstReleaseDate:
        typeof group["first-release-date"] === "string" ? group["first-release-date"] : null,
    };
  }

  private async getJson(
    url: string,
    options: { ignoreClientErrors?: boolean } = {},
  ): Promise<unknown> {
    const cached = this.cache.get(url);
    if (cached) {
      return JSON.parse(cached);
    }
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.limiter.wait();
      const response = await this.http.get(url, {
        Accept: "application/json",
        "User-Agent": userAgent(this.contact),
      });
      if (response.status === 429 || response.status === 503) {
        const retryAfter = Number(response.headers["retry-after"]);
        const waitMs = Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1000) : 1000;
        await this.limiter.sleep(Math.min(30_000, waitMs));
        lastError = new Error(`MusicBrainz ${response.status}`);
        continue;
      }
      if (response.status >= 400) {
        if (options.ignoreClientErrors && response.status < 500) {
          return null;
        }
        throw new Error(`MusicBrainz HTTP ${response.status} for ${redactUrl(url)}`);
      }
      this.cache.set(url, response.body);
      return JSON.parse(response.body);
    }
    throw lastError ?? new Error("MusicBrainz request failed");
  }
}
