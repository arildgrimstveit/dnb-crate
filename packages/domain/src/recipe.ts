import { createHash } from "node:crypto";
import type { RenderManifestV1 } from "./render.ts";

/** Canonical JSON retains arrays' event order and ignores object insertion order. */
export function canonicalRecipeJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, normalize(v)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

/** Complete supplied recipe identity. Keep the historical 32-bit API for legacy rows. */
export function exactRecipeFingerprint(recipe: unknown): string {
  return `v2:${createHash("sha256").update(canonicalRecipeJson(recipe)).digest("hex")}`;
}

/** Identity of a heard sequence, including output checksum. Not a reusable recipe. */
export function renderSequenceFingerprint(manifest: RenderManifestV1): string {
  return exactRecipeFingerprint({
    kind: "render-sequence",
    outputChecksum: manifest.outputChecksumSha256,
    rendererVersion: manifest.rendererVersion,
    sampleRate: manifest.outputSampleRateHz,
    setPlanId: manifest.setPlanId,
    tracks: manifest.tracks.map((track) => ({
      trackId: track.trackId,
      sourceFingerprint: track.sourceFingerprint,
      sourceStartMs: track.sourceStartMs,
      sourceEndMs: track.sourceEndMs,
      playbackRate: track.playbackRate,
      gainDb: track.gainDb,
      overlapToNextMs: track.overlapToNextMs,
      transitionId: track.transitionId,
    })),
    invocation: manifest.invocation,
  });
}

export function renderJoinFingerprint(manifest: RenderManifestV1, transitionId: string): string {
  const index = manifest.tracks.findIndex((track) => track.transitionId === transitionId);
  if (index < 0 || !manifest.tracks[index + 1])
    throw new Error("Transition is not a join in the stored render");
  return exactRecipeFingerprint({
    kind: "render-join",
    outputChecksum: manifest.outputChecksumSha256,
    rendererVersion: manifest.rendererVersion,
    sampleRate: manifest.outputSampleRateHz,
    outgoing: manifest.tracks[index],
    incoming: manifest.tracks[index + 1],
    evidence: manifest.joinEvidence?.[index],
    automation: manifest.automation,
    invocation: manifest.invocation,
  });
}

export type RecipeFingerprintInput = {
  type: string;
  barCount?: number | null;
  intent?: string | null;
  phraseShape?: string | null;
  outgoingRate?: number | null;
  incomingRate?: number | null;
  mixInMs?: number | null;
  mixOutMs?: number | null;
  recipeVersion?: number | null;
  outgoingTrackId?: string | null;
  incomingTrackId?: string | null;
};

function stableNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "";
  }
  return value.toFixed(6);
}

/** Deterministic fingerprint of the musical recipe, independent of JSON key order. */
export function recipeFingerprint(input: RecipeFingerprintInput): string {
  const parts = [
    input.type,
    input.barCount ?? "",
    input.intent ?? "",
    input.phraseShape ?? "",
    stableNumber(input.outgoingRate),
    stableNumber(input.incomingRate),
    input.mixInMs ?? "",
    input.mixOutMs ?? "",
    input.recipeVersion ?? "",
    input.outgoingTrackId ?? "",
    input.incomingTrackId ?? "",
  ];
  const raw = parts.join("|");
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function pairKey(outgoingTrackId: string, incomingTrackId: string): string {
  return `${outgoingTrackId}:${incomingTrackId}`;
}
