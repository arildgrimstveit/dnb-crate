import type { HttpClient } from "./http-client.ts";
import { redactUrl } from "./http-client.ts";
import type { RateLimiter } from "./rate-limiter.ts";
import type { ResponseCache } from "./response-cache.ts";

export type DeezerTrack = {
  id: string;
  title: string;
  artist: string;
  durationMs: number | null;
  bpm: number | null;
  gain: number | null;
  isrc: string | null;
  releaseDate: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mapTrack(raw: unknown): DeezerTrack | null {
  const row = asRecord(raw);
  if ((typeof row.id !== "number" && typeof row.id !== "string") || typeof row.title !== "string") {
    return null;
  }
  const artist = asRecord(row.artist);
  return {
    id: String(row.id),
    title: row.title,
    artist: typeof artist.name === "string" ? artist.name : "",
    durationMs: typeof row.duration === "number" ? row.duration * 1000 : null,
    bpm: typeof row.bpm === "number" && row.bpm > 0 ? row.bpm : null,
    gain: typeof row.gain === "number" ? row.gain : null,
    isrc: typeof row.isrc === "string" ? row.isrc : null,
    releaseDate: typeof row.release_date === "string" ? row.release_date : null,
  };
}

export class DeezerClient {
  constructor(
    private readonly http: HttpClient,
    private readonly limiter: RateLimiter,
    private readonly cache: ResponseCache,
  ) {}

  async byIsrc(isrc: string): Promise<DeezerTrack | null> {
    const url = `https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`;
    return mapTrack(await this.getJson(url));
  }

  async search(artist: string, title: string): Promise<DeezerTrack[]> {
    const q = `artist:"${artist.replaceAll('"', "")}" track:"${title.replaceAll('"', "")}"`;
    const url = `https://api.deezer.com/search/track?q=${encodeURIComponent(q)}`;
    const json = asRecord(await this.getJson(url));
    const data = Array.isArray(json.data) ? json.data : [];
    return data.map(mapTrack).filter((row): row is DeezerTrack => row !== null);
  }

  async byId(id: string): Promise<DeezerTrack | null> {
    const url = `https://api.deezer.com/track/${encodeURIComponent(id)}`;
    return mapTrack(await this.getJson(url));
  }

  private async getJson(url: string): Promise<unknown> {
    const cached = this.cache.get(url);
    if (cached) {
      return JSON.parse(cached);
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.limiter.wait();
      const response = await this.http.get(url, { Accept: "application/json" });
      if (response.status === 429 || response.status === 503) {
        const retryAfter = Number(response.headers["retry-after"] ?? 1);
        await this.limiter.sleep(Math.min(30_000, (retryAfter || 1) * 1000));
        continue;
      }
      if (response.status >= 400) {
        throw new Error(`Deezer HTTP ${response.status} for ${redactUrl(url)}`);
      }
      this.cache.set(url, response.body);
      return JSON.parse(response.body);
    }
    throw new Error("Deezer request failed");
  }
}
