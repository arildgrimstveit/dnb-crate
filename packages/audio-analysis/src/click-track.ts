import type { PcmAudio } from "./types.ts";

export type ClickTrackOptions = {
  bpm: number;
  durationMs: number;
  sampleRateHz?: number;
  offsetMs?: number;
  clickMs?: number;
};

/** Deterministic 16-bit-ish float click track: a short burst on every beat. */
export function buildClickTrackPcm(options: ClickTrackOptions): PcmAudio {
  const sampleRateHz = options.sampleRateHz ?? 44_100;
  const offsetMs = options.offsetMs ?? 0;
  const clickMs = options.clickMs ?? 6;
  const frameCount = Math.max(1, Math.round((sampleRateHz * options.durationMs) / 1000));
  const samples = new Float32Array(frameCount);
  const periodMs = 60_000 / options.bpm;
  const clickFrames = Math.max(2, Math.round((sampleRateHz * clickMs) / 1000));
  for (let beat = 0; ; beat += 1) {
    const tMs = offsetMs + beat * periodMs;
    const start = Math.round((tMs / 1000) * sampleRateHz);
    if (start >= frameCount) {
      break;
    }
    for (let i = 0; i < clickFrames && start + i < frameCount; i += 1) {
      const env = 1 - i / clickFrames;
      samples[start + i] = Math.sin((2 * Math.PI * 2000 * i) / sampleRateHz) * env;
    }
  }
  return {
    samples,
    sampleRateHz,
    durationMs: (frameCount / sampleRateHz) * 1000,
    channels: 1,
  };
}

export function encodeMonoWav(pcm: PcmAudio): Buffer {
  const data = Buffer.alloc(pcm.samples.length * 2);
  for (let i = 0; i < pcm.samples.length; i += 1) {
    const clipped = Math.max(-1, Math.min(1, pcm.samples[i] ?? 0));
    data.writeInt16LE(Math.round(clipped * 16000), i * 2);
  }
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, 4, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(pcm.sampleRateHz, 12);
  fmt.writeUInt32LE(pcm.sampleRateHz * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const dataChunk = Buffer.alloc(8 + data.length);
  dataChunk.write("data", 0, 4, "ascii");
  dataChunk.writeUInt32LE(data.length, 4);
  data.copy(dataChunk, 8);
  const inner = Buffer.concat([Buffer.from("WAVE", "ascii"), fmt, dataChunk]);
  const riff = Buffer.alloc(8 + inner.length);
  riff.write("RIFF", 0, 4, "ascii");
  riff.writeUInt32LE(inner.length, 4);
  inner.copy(riff, 8);
  return riff;
}
