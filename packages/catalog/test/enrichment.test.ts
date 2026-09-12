import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DSP_ANALYZER_NAME, type AppConfig } from "@dnb-crate/domain";

import {
  createCatalogRuntime,
  createFakeHttpClient,
  RateLimiter,
  scoreMatch,
  writeSineWav,
} from "../src/index.ts";
import { fingerprintFile } from "../src/enrichment/acoustid.ts";

const MBID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const RELEASE = "ffffffff-1111-2222-3333-444444444444";
const ISRC = "GBUM71505078";

function testConfig(root: string, extras: Partial<AppConfig> = {}): AppConfig {
  return {
    databasePath: path.join(root, "catalog.sqlite"),
    libraryRoots: [path.join(root, "library")],
    outputRoot: path.join(root, "output"),
    logLevel: "error",
    supportedExtensions: [".wav", ".flac", ".mp3", ".m4a", ".aiff", ".aif"],
    enrichment: {
      enabled: true,
      contact: "test@example.com",
      musicbrainz: { enabled: true },
      deezer: { enabled: true },
      writePublishedBpm: true,
    },
    ...extras,
  };
}

function mbRecording(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MBID,
    title: "Tidal Wave",
    length: 2000,
    isrcs: [ISRC],
    "artist-credit": [{ name: "Sub Focus", artist: { id: "artist-1", name: "Sub Focus" } }],
    "release-group": { id: "rg-1", "first-release-date": "2013-05-12" },
    releases: [{ id: RELEASE, status: "Official", date: "2013-05-13" }],
    genres: [{ name: "drum & bass" }],
    tags: [{ name: "electronic", count: 3 }],
    ...overrides,
  };
}

function mbRelease(): Record<string, unknown> {
  return {
    id: RELEASE,
    date: "2013-05-13",
    "release-group": { "first-release-date": "2013-05-12" },
    "label-info": [{ "catalog-number": "RAMM123", label: { name: "RAM Records" } }],
  };
}

function deezerTrack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 99,
    title: "Tidal Wave",
    artist: { name: "Sub Focus" },
    duration: 2,
    bpm: 173.7,
    gain: -8.1,
    isrc: ISRC,
    release_date: "2013-05-12",
    ...overrides,
  };
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function workspace(
  http: ReturnType<typeof createFakeHttpClient>,
  extras: Partial<AppConfig> = {},
) {
  const root = path.join(
    os.tmpdir(),
    `dnb-enrich-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const library = path.join(root, "library");
  await mkdir(library, { recursive: true });
  const catalog = createCatalogRuntime(testConfig(root, extras), undefined, {
    useFakeFfmpeg: true,
    http,
    enrichmentIntervals: { musicbrainz: 0, deezer: 0, acoustid: 0 },
  });
  cleanups.push(() => catalog.close());
  return { root, library, catalog, http };
}

async function seedTrack(
  catalog: ReturnType<typeof createCatalogRuntime>,
  library: string,
  options: { title?: string; artist?: string; durationMs?: number } = {},
) {
  const title = options.title ?? "Tidal Wave";
  const file = path.join(library, `${title.replaceAll(" ", "-").toLowerCase()}.wav`);
  await writeSineWav(file, {
    title,
    artist: options.artist ?? "Sub Focus",
    durationMs: options.durationMs ?? 2000,
  });
  await catalog.service.scanLibrary();
  const track = catalog.service.searchTracks({ query: title, limit: 5 }).tracks[0];
  if (!track) {
    throw new Error(`seed failed for ${title}`);
  }
  return track;
}

describe("enrichment matcher", () => {
  it("rejects a remix against an original", () => {
    const original = scoreMatch(
      { title: "Tidal Wave", artist: "Sub Focus", durationMs: 180_000 },
      { title: "Tidal Wave (Remix)", artist: "Sub Focus", durationMs: 180_000 },
    );
    expect(original.accept).toBe(false);
    expect(original.score).toBe(0);
  });
});

describe("chromaprint fingerprint", () => {
  it("parses bare base64 stdout from FFmpeg", async () => {
    const fp = await fingerprintFile(
      {
        run: () =>
          Promise.resolve({
            exitCode: 0,
            signal: null,
            stdout: "AQAAC0mUaEkSZSoAAAAA\n",
            stderr: "",
          }),
      },
      "ffmpeg",
      "clip.wav",
    );
    expect(fp?.fingerprint).toBe("AQAAC0mUaEkSZSoAAAAA");
  });

  it("parses URL-safe base64 chromaprint stdout", async () => {
    const fp = await fingerprintFile(
      {
        run: () =>
          Promise.resolve({
            exitCode: 0,
            signal: null,
            stdout: "AQAAC0mU_EkS-SoAAAAA\n",
            stderr: "",
          }),
      },
      "ffmpeg",
      "clip.wav",
    );
    expect(fp?.fingerprint).toBe("AQAAC0mU_EkS-SoAAAAA");
  });
});

describe("rate limiter", () => {
  it("spaces calls with an injectable clock", async () => {
    let now = 0;
    const clock = {
      now: () => now,
      sleep: (ms: number) => {
        now += ms;
        return Promise.resolve();
      },
    };
    const limiter = new RateLimiter(1000, clock);
    await limiter.wait();
    await limiter.wait();
    expect(now).toBe(1000);
  });
});

describe("metadata enrichment", () => {
  it("writes published fields from a file MBID and leaves manual album/label alone", async () => {
    const http = createFakeHttpClient([
      { match: `/recording/${MBID}`, body: mbRecording() },
      { match: `/release/${RELEASE}`, body: mbRelease() },
      { match: "/track/isrc:", body: deezerTrack() },
    ]);
    const { catalog, library } = await workspace(http);
    const seeded = await seedTrack(catalog, library);
    catalog.repository.updateMetadata(seeded.id, {
      album: "Keep Me",
      label: "Manual Label",
    });
    catalog.db.prepare("UPDATE tracks SET recording_mbid = ? WHERE id = ?").run(MBID, seeded.id);

    const started = catalog.service.startMetadataEnrichment({
      scope: "ids",
      trackIds: [seeded.id],
    });
    const job = await catalog.service.waitForEnrichmentJob(started.job.id, 15_000);
    expect(job.status).toBe("succeeded");

    const track = catalog.service.getTrack(seeded.id);
    expect(track.album).toBe("Keep Me");
    expect(track.label).toBe("Manual Label");
    expect(track.fieldSources?.album).toBe("manual");
    expect(track.fieldSources?.label).toBe("manual");
    expect(track.releaseDate).toBe("2013-05-12");
    expect(track.isrc).toBe(ISRC);
    expect(track.recordingMbid).toBe(MBID);
    expect(track.genres).toEqual(["drum and bass", "electronic"]);
    expect(track.fieldSources?.releaseDate).toBe("published");
    expect(track.fieldSources?.isrc).toBe("published");
    expect(track.bpm).toBe(174);
    expect(track.bpmSource).toBe("published");
  });

  it("picks the ISRC recording whose duration matches", async () => {
    const http = createFakeHttpClient([
      {
        match: `/isrc/${ISRC}`,
        body: {
          recordings: [
            mbRecording({ id: "wrong-id", title: "Tidal Wave", length: 12_000 }),
            mbRecording({ id: MBID, length: 2000 }),
          ],
        },
      },
      { match: `/release/${RELEASE}`, body: mbRelease() },
      { match: "/track/isrc:", body: deezerTrack({ bpm: 0 }) },
    ]);
    const { catalog, library } = await workspace(http);
    const seeded = await seedTrack(catalog, library);
    catalog.db.prepare("UPDATE tracks SET isrc = ? WHERE id = ?").run(ISRC, seeded.id);
    const started = catalog.service.startMetadataEnrichment({
      scope: "ids",
      trackIds: [seeded.id],
    });
    await catalog.service.waitForEnrichmentJob(started.job.id, 15_000);
    expect(catalog.service.getTrack(seeded.id).recordingMbid).toBe(MBID);
  });

  it("falls through to search when the ISRC endpoint returns 400", async () => {
    const http = createFakeHttpClient([
      { match: `/isrc/${ISRC}`, status: 400, body: { error: "bad request" } },
      {
        match: "isrc%3A",
        body: { recordings: [mbRecording()] },
      },
      { match: `/recording/${MBID}`, body: mbRecording() },
      { match: `/release/${RELEASE}`, body: mbRelease() },
      { match: "/track/isrc:", body: deezerTrack({ bpm: 0 }) },
    ]);
    const { catalog, library } = await workspace(http);
    const seeded = await seedTrack(catalog, library);
    catalog.db.prepare("UPDATE tracks SET isrc = ? WHERE id = ?").run(ISRC, seeded.id);
    const started = catalog.service.startMetadataEnrichment({
      scope: "ids",
      trackIds: [seeded.id],
    });
    await catalog.service.waitForEnrichmentJob(started.job.id, 15_000);
    expect(catalog.service.getTrack(seeded.id).recordingMbid).toBe(MBID);
  });

  it("ranks the original above a remix decoy and leaves needsReview unwritten", async () => {
    const remixId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const http = createFakeHttpClient([
      {
        match: "/ws/2/recording?query=",
        body: {
          recordings: [
            mbRecording({
              id: remixId,
              title: "Tidal Wave (Remix)",
              length: 2000,
            }),
            mbRecording({ id: MBID, title: "Tidal Wave", length: 2000 }),
          ],
        },
      },
      { match: `/recording/${MBID}`, body: mbRecording() },
      { match: `/release/${RELEASE}`, body: mbRelease() },
      { match: "/search/track", body: { data: [deezerTrack({ bpm: 0 })] } },
      { match: "/track/", body: deezerTrack({ bpm: 0 }) },
    ]);
    const { catalog, library } = await workspace(http);
    const seeded = await seedTrack(catalog, library);
    const started = catalog.service.startMetadataEnrichment({
      scope: "ids",
      trackIds: [seeded.id],
    });
    await catalog.service.waitForEnrichmentJob(started.job.id, 15_000);
    expect(catalog.service.getTrack(seeded.id).recordingMbid).toBe(MBID);

    const reviewHttp = createFakeHttpClient([
      {
        match: "/ws/2/recording?query=",
        body: {
          recordings: [
            mbRecording({
              id: "cccccccc-dddd-eeee-ffff-000000000000",
              title: "Tidal Wave",
              length: 12_000,
              "artist-credit": [{ name: "Sub Focus", artist: { id: "a", name: "Sub Focus" } }],
            }),
          ],
        },
      },
      { match: "/search/track", body: { data: [] } },
    ]);
    const second = await workspace(reviewHttp);
    const other = await seedTrack(second.catalog, second.library);
    const reviewJob = second.catalog.service.startMetadataEnrichment({
      scope: "ids",
      trackIds: [other.id],
    });
    await second.catalog.service.waitForEnrichmentJob(reviewJob.job.id, 15_000);
    const report = second.catalog.service.getEnrichmentReport();
    expect(report.needsReview).toBeGreaterThanOrEqual(1);
    expect(second.catalog.service.getTrack(other.id).recordingMbid ?? null).toBeNull();
    expect(second.catalog.service.getTrack(other.id).label ?? null).toBeNull();
  });

  it("folds and rounds Deezer BPM and reports DSP disagreement", async () => {
    const http = createFakeHttpClient([
      { match: `/recording/${MBID}`, body: mbRecording() },
      { match: `/release/${RELEASE}`, body: mbRelease() },
      { match: "/track/isrc:", body: deezerTrack({ bpm: 87 }) },
    ]);
    const { catalog, library } = await workspace(http);
    const seeded = await seedTrack(catalog, library);
    catalog.db.prepare("UPDATE tracks SET recording_mbid = ? WHERE id = ?").run(MBID, seeded.id);
    catalog.repository.updateMetadata(seeded.id, { genres: ["drum and bass"] });
    const started = catalog.service.startMetadataEnrichment({
      scope: "ids",
      trackIds: [seeded.id],
    });
    await catalog.service.waitForEnrichmentJob(started.job.id, 15_000);
    expect(catalog.service.getTrack(seeded.id).bpm).toBe(174);

    const disagree = createFakeHttpClient([
      { match: `/recording/${MBID}`, body: mbRecording() },
      { match: `/release/${RELEASE}`, body: mbRelease() },
      { match: "/track/isrc:", body: deezerTrack({ bpm: 176.4 }) },
    ]);
    const other = await workspace(disagree);
    const track = await seedTrack(other.catalog, other.library, { title: "Disagree" });
    other.catalog.db
      .prepare("UPDATE tracks SET recording_mbid = ? WHERE id = ?")
      .run(MBID, track.id);
    other.catalog.analyses.upsert({
      trackId: track.id,
      analyzerName: DSP_ANALYZER_NAME,
      analyzerVersion: "3.0.0",
      bpm: 174,
      bpmConfidence: 0.9,
      bpmRaw: 174,
      referenceBpm: null,
      beatTimesMs: [],
      downbeatTimesMs: [],
      gridRejected: false,
      gridRejectionReason: null,
      gridSource: "analyzed",
      musicalKey: null,
      keyConfidence: null,
      keyMode: null,
      camelotKey: null,
      tempoStability: null,
      downbeatConfidence: null,
      integratedLufs: null,
      truePeakDb: null,
      lowBandEnergy: null,
      midBandEnergy: null,
      highBandEnergy: null,
      waveformSummary: null,
      beatAnchorMs: null,
      descriptors: null,
      engineRuntimeMs: 1,
      analyzedAt: new Date().toISOString(),
      suggestedCues: [],
      sections: [],
    });
    const job = other.catalog.service.startMetadataEnrichment({
      scope: "ids",
      trackIds: [track.id],
    });
    await other.catalog.service.waitForEnrichmentJob(job.job.id, 15_000);
    expect(other.catalog.service.getTrack(track.id).bpm).toBeNull();
    expect(other.catalog.service.getEnrichmentReport().bpmDisagreements).toBe(1);
  });

  it("never overwrites a manual BPM", async () => {
    const http = createFakeHttpClient([
      { match: `/recording/${MBID}`, body: mbRecording() },
      { match: `/release/${RELEASE}`, body: mbRelease() },
      { match: "/track/isrc:", body: deezerTrack({ bpm: 174 }) },
    ]);
    const { catalog, library } = await workspace(http);
    const seeded = await seedTrack(catalog, library);
    catalog.repository.updateMetadata(seeded.id, { bpm: 170, bpmSource: "manual" });
    catalog.db.prepare("UPDATE tracks SET recording_mbid = ? WHERE id = ?").run(MBID, seeded.id);
    const started = catalog.service.startMetadataEnrichment({
      scope: "ids",
      trackIds: [seeded.id],
    });
    await catalog.service.waitForEnrichmentJob(started.job.id, 15_000);
    const track = catalog.service.getTrack(seeded.id);
    expect(track.bpm).toBe(170);
    expect(track.bpmSource).toBe("manual");
  });

  it("honours Retry-After and serves the second run from cache", async () => {
    const http = createFakeHttpClient([
      {
        match: `/recording/${MBID}`,
        responses: [
          { status: 503, body: { error: "busy" }, headers: { "retry-after": "0" } },
          { status: 200, body: mbRecording() },
        ],
      },
      { match: `/release/${RELEASE}`, body: mbRelease() },
      { match: "/track/isrc:", body: deezerTrack({ bpm: 0 }) },
    ]);
    const { catalog, library } = await workspace(http);
    const seeded = await seedTrack(catalog, library);
    catalog.db.prepare("UPDATE tracks SET recording_mbid = ? WHERE id = ?").run(MBID, seeded.id);
    const first = catalog.service.startMetadataEnrichment({
      scope: "ids",
      trackIds: [seeded.id],
    });
    await catalog.service.waitForEnrichmentJob(first.job.id, 15_000);
    expect(catalog.service.getTrack(seeded.id).recordingMbid).toBe(MBID);
    const afterFirst = http.calls.length;
    const second = catalog.service.startMetadataEnrichment({
      scope: "all",
      trackIds: [seeded.id],
    });
    await catalog.service.waitForEnrichmentJob(second.job.id, 15_000);
    expect(http.calls.length).toBe(afterFirst);
  });

  it("skips AcoustID without a key and uses it when configured", async () => {
    const noKey = createFakeHttpClient([
      { match: "/ws/2/recording?query=", body: { recordings: [] } },
      { match: "/search/track", body: { data: [] } },
    ]);
    const first = await workspace(noKey);
    const a = await seedTrack(first.catalog, first.library, { title: "No Key" });
    const jobA = first.catalog.service.startMetadataEnrichment({
      scope: "ids",
      trackIds: [a.id],
    });
    await first.catalog.service.waitForEnrichmentJob(jobA.job.id, 15_000);
    expect(noKey.calls.some((url) => url.includes("acoustid.org"))).toBe(false);

    const withKey = createFakeHttpClient([
      { match: "/ws/2/recording?query=", body: { recordings: [] } },
      {
        match: "acoustid.org",
        body: { results: [{ id: "acoust-1", score: 0.91, recordings: [{ id: MBID }] }] },
      },
      { match: `/recording/${MBID}`, body: mbRecording() },
      { match: `/release/${RELEASE}`, body: mbRelease() },
      { match: "/track/isrc:", body: deezerTrack({ bpm: 0 }) },
    ]);
    const second = await workspace(withKey, {
      enrichment: {
        enabled: true,
        musicbrainz: { enabled: true },
        deezer: { enabled: true },
        acoustid: { apiKey: "test-key" },
        writePublishedBpm: true,
      },
    });
    const b = await seedTrack(second.catalog, second.library, { title: "Tidal Wave" });
    const jobB = second.catalog.service.startMetadataEnrichment({
      scope: "ids",
      trackIds: [b.id],
    });
    await second.catalog.service.waitForEnrichmentJob(jobB.job.id, 15_000);
    expect(withKey.calls.some((url) => url.includes("acoustid.org"))).toBe(true);
    expect(withKey.calls.some((url) => url.includes("test-key"))).toBe(true);
    expect(second.catalog.service.getTrack(b.id).recordingMbid).toBe(MBID);
    const report = JSON.stringify(second.catalog.service.getEnrichmentReport());
    expect(report).not.toContain("test-key");
  });

  it("does not downgrade published fields on rescan and shares recording_key", async () => {
    const http = createFakeHttpClient([
      { match: `/recording/${MBID}`, body: mbRecording() },
      { match: `/release/${RELEASE}`, body: mbRelease() },
      { match: "/track/isrc:", body: deezerTrack({ bpm: 0 }) },
    ]);
    const { catalog, library } = await workspace(http);
    const first = await seedTrack(catalog, library, { title: "Copy A" });
    await writeSineWav(path.join(library, "copy-b.wav"), {
      title: "Copy B",
      artist: "Sub Focus",
      durationMs: 2000,
    });
    await catalog.service.scanLibrary();
    const second = catalog.service.searchTracks({ query: "Copy B", limit: 5 }).tracks[0]!;
    catalog.db
      .prepare("UPDATE tracks SET recording_mbid = ? WHERE id IN (?, ?)")
      .run(MBID, first.id, second.id);
    const started = catalog.service.startMetadataEnrichment({
      scope: "ids",
      trackIds: [first.id, second.id],
    });
    await catalog.service.waitForEnrichmentJob(started.job.id, 15_000);
    const before = catalog.service.getTrack(first.id);
    expect(before.label).toBe("RAM Records");
    expect(before.fieldSources?.label).toBe("published");
    await catalog.service.scanLibrary();
    const after = catalog.service.getTrack(first.id);
    expect(after.label).toBe("RAM Records");
    expect(after.fieldSources?.label).toBe("published");
    expect(catalog.service.getTrack(first.id).recordingKey).toBe(
      catalog.service.getTrack(second.id).recordingKey,
    );
  });

  it("reports enrichment flags without secrets on server status", async () => {
    const http = createFakeHttpClient([]);
    const { catalog } = await workspace(http, {
      enrichment: {
        enabled: true,
        contact: "secret@example.com",
        acoustid: { apiKey: "super-secret" },
        musicbrainz: { enabled: true },
        deezer: { enabled: true },
        writePublishedBpm: true,
      },
    });
    const status = await catalog.service.getServerStatus();
    expect(status.enrichment).toEqual({
      enabled: true,
      musicbrainz: true,
      deezer: true,
      acoustidConfigured: true,
    });
    expect(JSON.stringify(status)).not.toContain("super-secret");
    expect(JSON.stringify(status)).not.toContain("secret@example.com");
  });
});
