import type { PcmAudio } from "./types.ts";

export function decodeWavPcm(buffer: Buffer): PcmAudio {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Not a RIFF WAV file");
  }
  let offset = 12;
  let channels = 1;
  let sampleRateHz = 44100;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      channels = buffer.readUInt16LE(start + 2);
      sampleRateHz = buffer.readUInt32LE(start + 4);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    } else if (id === "data") {
      dataOffset = start;
      dataLength = size;
      break;
    }
    offset = start + size + (size % 2);
  }
  if (dataOffset < 0) {
    throw new Error("WAV has no data chunk");
  }
  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV bit depth ${bitsPerSample}`);
  }
  const frameCount = Math.floor(dataLength / (channels * 2));
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    let mix = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      mix += buffer.readInt16LE(dataOffset + (i * channels + ch) * 2) / 32768;
    }
    samples[i] = mix / channels;
  }
  return {
    samples,
    sampleRateHz,
    durationMs: (frameCount / sampleRateHz) * 1000,
    channels,
  };
}

export function mixToMono(samples: Float32Array, channels: number): Float32Array {
  if (channels <= 1) {
    return samples;
  }
  const frames = Math.floor(samples.length / channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      sum += samples[i * channels + ch] ?? 0;
    }
    mono[i] = sum / channels;
  }
  return mono;
}
