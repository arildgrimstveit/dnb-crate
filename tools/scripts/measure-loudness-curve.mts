import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";

import {
  createNodeProcessRunner,
  detectFfmpeg,
  measureLoudnessSeries,
} from "../../packages/audio-renderer/src/index.ts";

/**
 * Q04 measurement validation (12 October 2026): run the time-indexed
 * loudness measurement against a real library track and print the curve's
 * shape - frame count, coverage, and the short-term loudness at a few
 * sample points - to confirm the parser handles real ebur128 output
 * (formatting variants, silence floors, long files).
 *
 * Usage: pnpm tsx tools/scripts/measure-loudness-curve.mts <audio-file>
 */

const target = process.argv[2];
if (!target) {
  console.error("usage: measure-loudness-curve.mts <audio-file>");
  process.exit(1);
}
const runner = createNodeProcessRunner();
const binaries = await detectFfmpeg(runner, {
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
});
if (!binaries) {
  console.error("ffmpeg unavailable");
  process.exit(1);
}
const series = await measureLoudnessSeries(runner, binaries, target);
const valid = series.frames.filter((f) => f.shortTermLufs != null);
const silence = series.frames.length - valid.length;
console.log(
  `frames: ${series.frames.length} hop: ${series.hopMs} ms  valid: ${valid.length}  silence: ${silence}`,
);
console.log(`integrated: ${series.integratedLufs} LUFS  true peak: ${series.truePeakDb} dB`);
if (series.frames.length === 0) {
  console.error("NO FRAMES PARSED - real output format mismatch");
  process.exit(2);
}
const durationMs = series.frames.at(-1)!.timeMs;
for (const fraction of [0.1, 0.25, 0.5, 0.75, 0.9]) {
  const at = Math.round(durationMs * fraction);
  const frame = series.frames.reduce((best, f) =>
    Math.abs(f.timeMs - at) < Math.abs(best.timeMs - at) ? f : best,
  );
  console.log(
    `  t=${String(frame.timeMs).padStart(7)} ms  M: ${frame.momentaryLufs ?? "  -  "}  S: ${frame.shortTermLufs ?? "  -  "}`,
  );
}
// Persist the raw series beside the report for inspection.
const out = "tools/reports/loudness-curve-sample.json";
await writeFile(out, JSON.stringify({ target, ...series }, null, 2));
console.log(`series written to ${out}`);
void readFile;
