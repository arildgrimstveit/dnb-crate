import path from "node:path";

import { parseFile } from "music-metadata";

export { parseFile as readAudioTags } from "music-metadata";

import { normalizeGenres, normalizeKey } from "@dnb-crate/domain";

export type ExtractedAudioMetadata = {
  artist: string | null;
  title: string;
  album: string | null;
  durationMs: number;
  sampleRateHz: number | null;
  channels: number | null;
  bpm: number | null;
  bpmSource: "tag" | null;
  musicalKey: string | null;
  camelotKey: string | null;
  keySource: "tag" | null;
  label: string | null;
  releaseDate: string | null;
  isrc: string | null;
  recordingMbid: string | null;
  genres: string[];
  catalogNumber: string | null;
  albumArtist: string | null;
};

function blankToNull(value: string | undefined | null): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function firstString(value: unknown): string | null {
  if (typeof value === "string") {
    return blankToNull(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found) {
        return found;
      }
    }
  }
  if (value && typeof value === "object" && "text" in (value as { text?: unknown })) {
    return firstString((value as { text?: unknown }).text);
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[;,/|]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    const text = firstString(item);
    if (text) {
      out.push(text);
    }
  }
  return out;
}

function titleFromPath(filePath: string): string {
  return path.parse(filePath).name;
}

function nativeValue(native: Record<string, unknown[] | undefined>, names: string[]): unknown {
  for (const name of names) {
    const hit = native[name] ?? native[name.toUpperCase()] ?? native[name.toLowerCase()];
    if (hit && hit.length > 0) {
      return hit[0];
    }
  }
  return undefined;
}

export async function extractAudioMetadata(filePath: string): Promise<ExtractedAudioMetadata> {
  const parsed = await parseFile(filePath, { duration: true });
  const durationSec = parsed.format.duration;
  if (durationSec === undefined || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("duration is missing or invalid");
  }

  const bpmRaw = parsed.common.bpm;
  const bpm = typeof bpmRaw === "number" && Number.isFinite(bpmRaw) && bpmRaw > 0 ? bpmRaw : null;
  const keyRaw = blankToNull(parsed.common.key);
  const normalized = normalizeKey(keyRaw);
  const native: Record<string, unknown[] | undefined> = {};
  for (const [ns, tags] of Object.entries(parsed.native ?? {})) {
    void ns;
    for (const tag of tags ?? []) {
      const id = String((tag as { id?: string }).id ?? "");
      if (!id) {
        continue;
      }
      native[id] = native[id] ?? [];
      native[id].push((tag as { value?: unknown }).value);
    }
  }

  const common = parsed.common as unknown as Record<string, unknown>;
  const recordingMbid =
    firstString(common.musicbrainz_recordingid) ??
    firstString(
      nativeValue(native, ["MUSICBRAINZ_TRACKID", "UFID:http://musicbrainz.org", "UFID"]),
    );
  const isrc = firstString(common.isrc) ?? firstString(nativeValue(native, ["TSRC", "ISRC"]));
  const label =
    firstString(common.label) ?? firstString(nativeValue(native, ["LABEL", "PUBLISHER", "TPUB"]));
  const releaseDate =
    firstString(common.originaldate) ??
    firstString(common.date) ??
    firstString(nativeValue(native, ["TDOR", "TDRC", "TYER", "IDATE", "DATE", "ORIGINALDATE"]));
  const catalogNumber =
    firstString(common.catalognumber) ??
    firstString(nativeValue(native, ["CATALOGNUMBER", "CATALOG"]));
  const genres = normalizeGenres([
    ...stringList(common.genre),
    ...stringList(nativeValue(native, ["TCON", "GENRE", "IGNR"])),
  ]);

  return {
    artist: blankToNull(parsed.common.artist),
    title: blankToNull(parsed.common.title) ?? titleFromPath(filePath),
    album: blankToNull(parsed.common.album),
    durationMs: Math.round(durationSec * 1000),
    sampleRateHz: parsed.format.sampleRate ?? null,
    channels: parsed.format.numberOfChannels ?? null,
    bpm,
    bpmSource: bpm === null ? null : "tag",
    musicalKey: normalized?.musicalKey ?? keyRaw,
    camelotKey: normalized?.camelotKey ?? null,
    keySource: keyRaw === null ? null : "tag",
    label,
    releaseDate,
    isrc,
    recordingMbid,
    genres,
    catalogNumber,
    albumArtist: blankToNull(parsed.common.albumartist),
  };
}
