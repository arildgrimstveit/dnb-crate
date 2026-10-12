import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { lowpass, onsetTimesMs } from "../../packages/catalog/src/render/audio-diagnostics.ts";
import { resolveRubberbandCli } from "../../packages/audio-renderer/src/rubberband-cli.ts";

const run = promisify(execFile);

/**
 * Stretch-engine latency diagnostic (T7 follow-up, 12 October 2026).
 *
 * Renders the same 174 BPM kick train through each stretch path at the
 * corpus's unequal-rate factor (175/174), then measures each file's kick
 * onsets against its OWN STRETCHED grid. The picker's attack-lag bias is
 * identical in every file (it comes from the picker, not the filters), so
 * any DIFFERENCE in median residual is the path's own group delay.
 *
 * Paths measured, mirroring how mix.ts invokes them:
 *   1. ffmpeg atempo filter            (fallback engine)
 *   2. ffmpeg rubberband filter        (in-graph engine)
 *   3. Rubber Band R3 CLI              (preferred path; rubberband-cli.ts:
 *      `rubberband -3 -T <rate> --centre-focus -q in out`)
 *
 * Findings (this machine, 12 October 2026):
 *   ffmpeg rubberband filter: ZERO added latency (residual == raw)
 *   ffmpeg atempo filter:     +12.8 ms group delay vs its stretched grid
 *   R3 CLI:                   ZERO added latency (same residual as raw)
 *
 * Consequence: NO stretch engine explains the processed-deck corpus's
 * unequal-rate offset - the real cause was join placement (corpus fixture
 * phase + the renderer's file-boundary anchoring under rateRegionsVersion 2;
 * both fixed the same day - see beatmatching-followups). The atempo FALLBACK
 * still carries its -14 ms group delay uncompensated.
 *
 * Self-contained: generates fixtures into a temp dir. Requires ffmpeg on
 * PATH. Usage: pnpm tsx tools/scripts/measure-stretch-latency.mts
 */

const SR = 44_100;
const BPM = 174;
const RATE = 175 / 174; // corpus unequal-rate factor
const OUT_SR = 22_050;

function kickWav(beatsMs: number[], samples: number): Buffer {
  const data = Buffer.alloc(samples * 4);
  for (const t of beatsMs) {
    const start = Math.floor((t * SR) / 1000);
    for (let i = 0; i < (120 * SR) / 1000; i++) {
      const tt = i / SR;
      const env = Math.exp(-tt * 30);
      const v = Math.sin(2 * Math.PI * 60 * tt) * env * 0.7;
      const idx = start + i;
      if (idx >= samples) break;
      for (const ch of [0, 1]) {
        const off = idx * 4 + ch * 2;
        data.writeInt16LE(Math.round(v * 32767), off);
      }
    }
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function onsetsOf(pcmFile: string): Promise<number[]> {
  const buf = await readFile(pcmFile);
  const samples = new Float32Array(buf.length / 4);
  for (let i = 0; i < samples.length; i += 1) samples[i] = buf.readFloatLE(i * 4);
  return onsetTimesMs(lowpass(samples, OUT_SR, 180), OUT_SR);
}

function medianResidual(times: number[], beat: number, skip: number): number {
  const rs = times
    .filter((t) => t > skip)
    .map((t) => {
      let d = t % beat;
      if (d > beat / 2) d -= beat;
      return d;
    })
    .sort((a, b) => a - b);
  return rs[Math.floor(rs.length / 2)] ?? Number.NaN;
}

const dir = path.join(tmpdir(), `stretch-latency-${process.pid}`);
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const beat = 60_000 / BPM;
const beats: number[] = [];
for (let k = 0; k < 200; k++) beats.push(k * beat);
await writeFile(path.join(dir, "kicks.wav"), kickWav(beats, Math.ceil(120 * SR)));

async function toPcm(input: string, out: string) {
  await run("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    input,
    "-f",
    "f32le",
    "-ac",
    "1",
    "-ar",
    String(OUT_SR),
    out,
  ]);
}

await toPcm(path.join(dir, "kicks.wav"), path.join(dir, "raw.pcm"));
await run("ffmpeg", [
  "-nostdin",
  "-v",
  "error",
  "-y",
  "-i",
  path.join(dir, "kicks.wav"),
  "-af",
  `atempo=${RATE.toFixed(6)}`,
  path.join(dir, "atempo.wav"),
]);
await toPcm(path.join(dir, "atempo.wav"), path.join(dir, "atempo.pcm"));
await run("ffmpeg", [
  "-nostdin",
  "-v",
  "error",
  "-y",
  "-i",
  path.join(dir, "kicks.wav"),
  "-af",
  `rubberband=tempo=${RATE.toFixed(6)}:pitch=1:pitchq=quality:channels=together`,
  path.join(dir, "rubberband.wav"),
]);
await toPcm(path.join(dir, "rubberband.wav"), path.join(dir, "rubberband.pcm"));

const cli = resolveRubberbandCli();
if (cli) {
  await run(
    cli,
    [
      "-3",
      "-T",
      RATE.toFixed(8),
      "--centre-focus",
      "-q",
      path.join(dir, "kicks.wav"),
      path.join(dir, "cli.wav"),
    ],
    { timeout: 120_000 },
  );
  await toPcm(path.join(dir, "cli.wav"), path.join(dir, "cli.pcm"));
} else {
  console.log("R3 CLI not found on PATH - CLI path skipped");
}

const beatOut = beat / RATE;
const raw = await onsetsOf(path.join(dir, "raw.pcm"));
const rawBias = medianResidual(raw, beat, 1000);
console.log(`raw (picker bias control): ${rawBias.toFixed(2)} ms, ${raw.length} onsets`);

for (const [name, file] of [
  ["ffmpeg atempo filter", "atempo.pcm"],
  ["ffmpeg rubberband filter", "rubberband.pcm"],
  ...(cli ? ([["R3 CLI (-3 -T --centre-focus)", "cli.pcm"]] as const) : []),
] as const) {
  const times = await onsetsOf(path.join(dir, file));
  const residual = medianResidual(times, beatOut, 1000);
  console.log(
    `${name}: residual ${residual.toFixed(2)} ms => group delay ${(residual - rawBias).toFixed(2)} ms (${times.length} onsets)`,
  );
}
await rm(dir, { recursive: true, force: true });
