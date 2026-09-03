import type { ProcessRunner } from "@dnb-crate/audio-renderer";

import type { HttpClient } from "./http-client.ts";
import { redactUrl } from "./http-client.ts";
import type { RateLimiter } from "./rate-limiter.ts";
import type { ResponseCache } from "./response-cache.ts";

export type AcoustidHit = {
  acoustidId: string;
  score: number;
  recordingMbids: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function fingerprintFile(
  runner: ProcessRunner,
  ffmpegPath: string,
  filePath: string,
): Promise<{ durationSec: number; fingerprint: string } | null> {
  const result = await runner.run({
    executable: ffmpegPath,
    args: ["-nostdin", "-hide_banner", "-i", filePath, "-f", "chromaprint", "-fp_format", "2", "-"],
  });
  const text = `${result.stdout}\n${result.stderr}`;
  try {
    const json = JSON.parse(result.stdout.trim() || text) as {
      duration?: number;
      fingerprint?: string;
    };
    if (typeof json.fingerprint === "string" && json.fingerprint.length > 0) {
      return {
        durationSec: typeof json.duration === "number" ? json.duration : 0,
        fingerprint: json.fingerprint,
      };
    }
  } catch {
    // FFmpeg may emit DURATION=/FINGERPRINT= text instead of JSON.
  }
  const duration = /DURATION=([0-9.]+)/i.exec(text);
  const fp =
    /FINGERPRINT=([A-Za-z0-9+/=]+)/i.exec(text) ?? /fingerprint=([A-Za-z0-9+/=]+)/i.exec(text);
  if (!fp) {
    return null;
  }
  return {
    durationSec: duration ? Number(duration[1]) : 0,
    fingerprint: fp[1]!,
  };
}

export class AcoustidClient {
  constructor(
    private readonly http: HttpClient,
    private readonly limiter: RateLimiter,
    private readonly cache: ResponseCache,
    private readonly apiKey: string,
  ) {}

  async lookup(durationSec: number, fingerprint: string): Promise<AcoustidHit[]> {
    const url = `https://api.acoustid.org/v2/lookup?client=${encodeURIComponent(this.apiKey)}&meta=recordings+releasegroups+compress&duration=${Math.round(durationSec)}&fingerprint=${encodeURIComponent(fingerprint)}`;
    const cached = this.cache.get(url);
    const body = cached ?? (await this.fetch(url));
    const json = asRecord(JSON.parse(body));
    const results = Array.isArray(json.results) ? json.results : [];
    return results.map((item) => {
      const row = asRecord(item);
      const recordings = Array.isArray(row.recordings) ? row.recordings : [];
      return {
        acoustidId: String(row.id ?? ""),
        score: Number(row.score ?? 0),
        recordingMbids: recordings
          .map((rec) => String(asRecord(rec).id ?? ""))
          .filter((id) => id.length > 0),
      };
    });
  }

  private async fetch(url: string): Promise<string> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.limiter.wait();
      const response = await this.http.get(url, { Accept: "application/json" });
      if (response.status === 429 || response.status === 503) {
        await this.limiter.sleep(1000);
        continue;
      }
      if (response.status >= 400) {
        throw new Error(`AcoustID HTTP ${response.status} for ${redactUrl(url)}`);
      }
      this.cache.set(url, response.body);
      return response.body;
    }
    throw new Error("AcoustID request failed");
  }
}
