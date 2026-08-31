import path from "node:path";

import { parseFile } from "music-metadata";

import { normalizeKey } from "@dnb-crate/domain";

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
};

function blankToNull(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function titleFromPath(filePath: string): string {
  return path.parse(filePath).name;
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
  };
}
