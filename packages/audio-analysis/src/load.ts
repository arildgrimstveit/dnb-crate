import { readFile } from "node:fs/promises";
import path from "node:path";

import { decodeWavPcm } from "./wav.ts";
import type { PcmAudio } from "./types.ts";

export async function loadPcmFromWavFile(filePath: string): Promise<PcmAudio> {
  const buffer = await readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".wav") {
    throw new Error("In-process PCM loader only supports WAV. Use FFmpeg for other formats.");
  }
  return decodeWavPcm(buffer);
}
