export type ProbeResult = {
  durationMs: number;
  sampleRateHz: number;
  channels: number;
  codecName: string | null;
  isAudio: boolean;
};

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
};

type FfprobeJson = {
  streams?: FfprobeStream[];
  format?: { duration?: string };
};

export function parseFfprobeJson(stdout: string): ProbeResult {
  const parsed = JSON.parse(stdout) as FfprobeJson;
  const stream = parsed.streams?.find((item) => item.codec_type === "audio");
  const durationSec = Number(stream?.duration ?? parsed.format?.duration ?? 0);
  const sampleRateHz = Number(stream?.sample_rate ?? 0);
  const channels = stream?.channels ?? 0;
  return {
    durationMs: Math.round(durationSec * 1000),
    sampleRateHz: Number.isFinite(sampleRateHz) ? sampleRateHz : 0,
    channels,
    codecName: stream?.codec_name ?? null,
    isAudio: stream !== undefined,
  };
}

export function parseEbur128(text: string): {
  integratedLufs: number | null;
  truePeakDb: number | null;
} {
  const integratedMatches = [...text.matchAll(/I:\s+([+-]?\d+(?:\.\d+)?)\s+LUFS/gi)];
  const peakMatches = [...text.matchAll(/Peak:\s+([+-]?\d+(?:\.\d+)?)\s+dB/gi)];
  const lastIntegrated = integratedMatches.at(-1);
  const lastPeak = peakMatches.at(-1);
  return {
    integratedLufs: lastIntegrated ? Number(lastIntegrated[1]) : null,
    truePeakDb: lastPeak ? Number(lastPeak[1]) : null,
  };
}

export type Ebur128SeriesFrame = {
  timeMs: number;
  /** Momentary loudness (LUFS); null when the filter reported silence
   * (-inf / below the meter's floor). */
  momentaryLufs: number | null;
  /** Short-term loudness (LUFS); null for silence. */
  shortTermLufs: number | null;
};

export type Ebur128Series = {
  hopMs: number;
  frames: Ebur128SeriesFrame[];
  integratedLufs: number | null;
  truePeakDb: number | null;
};

/**
 * Q04 (12 October roadmap): parse the per-frame momentary/short-term
 * loudness series FFmpeg's ebur128 filter logs every ~100 ms. The lines
 * look like:
 *   t: 1.00431 TARGET:-23 LUFS M: -18.5 S: -19.2 I: ...
 * M/S are `-inf` (or below-floor) during silence; those frames keep their
 * time with null values so validity/coverage stays measurable.
 */
export function parseEbur128Series(text: string): Ebur128Series {
  const frames: Ebur128SeriesFrame[] = [];
  const frameRe =
    /t:\s*([0-9]+(?:\.[0-9]+)?)\s+TARGET:.*?\s+M:\s*(-?\d+(?:\.\d+)?|-inf)\s+S:\s*(-?\d+(?:\.\d+)?|-inf)/g;
  for (const match of text.matchAll(frameRe)) {
    const timeMs = Math.round(Number(match[1]) * 1000);
    const momentary = match[2] === "-inf" ? null : Number(match[2]);
    const shortTerm = match[3] === "-inf" ? null : Number(match[3]);
    frames.push({ timeMs, momentaryLufs: momentary, shortTermLufs: shortTerm });
  }
  const summary = parseEbur128(text);
  // Hop is the observed frame cadence (FFmpeg logs every 100 ms); derive
  // it from consecutive frames rather than hardcoding, so odd builds
  // surface as a different hop instead of misaligned times.
  const hopMs = frames.length >= 2 ? Math.round(frames[1]!.timeMs - frames[0]!.timeMs) || 100 : 100;
  return { hopMs, frames, ...summary };
}

export function parseOutTimeMs(chunk: string): number | null {
  const us = /out_time_us=(\d+)/.exec(chunk);
  if (us) {
    return Math.round(Number(us[1]) / 1000);
  }
  const namedMs = /out_time_ms=(\d+)/.exec(chunk);
  if (namedMs) {
    const value = Number(namedMs[1]);
    return value > 10_000_000 ? Math.round(value / 1000) : value;
  }
  const clock = /out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(chunk);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    const seconds = Number(clock[3]);
    return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
  }
  return null;
}

export type SilenceSpan = { startMs: number; endMs: number | null };

export function parseSilenceSpans(text: string): SilenceSpan[] {
  const starts: SilenceSpan[] = [];
  const startRe = /silence_start:\s+([-\d.]+)/g;
  const endRe = /silence_end:\s+([-\d.]+)/g;
  const startMatches = [...text.matchAll(startRe)];
  const endMatches = [...text.matchAll(endRe)];
  for (let i = 0; i < startMatches.length; i += 1) {
    const startSec = Number(startMatches[i]![1]);
    const endSec = endMatches[i] ? Number(endMatches[i]![1]) : null;
    starts.push({
      startMs: Math.round(startSec * 1000),
      endMs: endSec === null ? null : Math.round(endSec * 1000),
    });
  }
  return starts;
}
