import { writeFile } from "node:fs/promises";

function infoChunk(id: string, value: string): Buffer {
  const payload = Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);
  const padded = payload.length % 2 === 1 ? Buffer.concat([payload, Buffer.from([0])]) : payload;
  const header = Buffer.alloc(8);
  header.write(id, 0, 4, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, padded]);
}

export type WavFixtureOptions = {
  sampleRate?: number;
  durationMs?: number;
  frequencyHz?: number;
  title?: string;
  artist?: string;
  album?: string;
};

/** Small non-copyrighted sine WAV used in tests and local inspection fixtures. */
export function buildSineWav(options: WavFixtureOptions = {}): Buffer {
  const sampleRate = options.sampleRate ?? 44100;
  const durationMs = options.durationMs ?? 250;
  const frequencyHz = options.frequencyHz ?? 440;
  const frameCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const data = Buffer.alloc(frameCount * 2);
  for (let i = 0; i < frameCount; i += 1) {
    const sample = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate);
    data.writeInt16LE(Math.round(sample * 16000), i * 2);
  }

  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, 4, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);

  const dataChunk = Buffer.alloc(8 + data.length);
  dataChunk.write("data", 0, 4, "ascii");
  dataChunk.writeUInt32LE(data.length, 4);
  data.copy(dataChunk, 8);

  const infoParts: Buffer[] = [];
  if (options.title) {
    infoParts.push(infoChunk("INAM", options.title));
  }
  if (options.artist) {
    infoParts.push(infoChunk("IART", options.artist));
  }
  if (options.album) {
    infoParts.push(infoChunk("IPRD", options.album));
  }

  let list = Buffer.alloc(0);
  if (infoParts.length > 0) {
    const infoBody = Buffer.concat([Buffer.from("INFO", "ascii"), ...infoParts]);
    list = Buffer.alloc(8 + infoBody.length);
    list.write("LIST", 0, 4, "ascii");
    list.writeUInt32LE(infoBody.length, 4);
    infoBody.copy(list, 8);
  }

  const inner = Buffer.concat([Buffer.from("WAVE", "ascii"), fmt, dataChunk, list]);
  const riff = Buffer.alloc(8 + inner.length);
  riff.write("RIFF", 0, 4, "ascii");
  riff.writeUInt32LE(inner.length, 4);
  inner.copy(riff, 8);
  return riff;
}

export async function writeSineWav(
  filePath: string,
  options: WavFixtureOptions = {},
): Promise<void> {
  await writeFile(filePath, buildSineWav(options));
}
