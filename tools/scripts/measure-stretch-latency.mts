import { readFile } from "node:fs/promises";
import { lowpass, onsetTimesMs } from "../../packages/catalog/src/render/audio-diagnostics.ts";

/**
 * Stretch-engine latency diagnostic (T7 follow-up, 12 October 2026).
 *
 * Renders the same 174 BPM kick train through atempo and rubberband at the
 * corpus's unequal-rate factor (175/174), then measures each file's kick
 * onsets against its OWN STRETCHED grid. The picker's attack-lag bias is
 * identical in every file (it comes from the picker, not the filters), so
 * any DIFFERENCE in median residual is the filter's own group delay.
 *
 * Finding (this machine, ffmpeg via PATH):
 *   raw:       -78.6 ms (picker bias — the control zero)
 *   rubberband: -78.6 ms (ZERO added latency: identical to raw)
 *   atempo:     -91.4 ms (+12.8 ms GROUP DELAY vs its stretched grid)
 *
 * Consequence: the renderer's rubberband path (preferred) is clean; the
 * atempo FALLBACK shifts every stretched deck ~13 ms late against its
 * projected grid. The processed-deck corpus's +24.8 ms unequal-rate
 * finding is consistent with both decks atempo'd (mutual timing preserved,
 * output grid sees the accumulated delay) or with the picker interaction;
 * per-deck stem capture will separate them.
 *
 * Usage: pnpm tsx tools/scripts/measure-stretch-latency.mts (after
 * generating the fixtures in the OS temp stretch-latency dir; see
 * beatmatching-followups for the reproduction recipe).
 */

const dir = "C:/Users/arild/AppData/Local/Temp/opencode/stretch-latency";
async function onsets(file: string): Promise<number[]> {
  const buf = await readFile(`${dir}/${file}`);
  const samples = new Float32Array(buf.length / 4);
  for (let i = 0; i < samples.length; i += 1) samples[i] = buf.readFloatLE(i * 4);
  return onsetTimesMs(lowpass(samples, 22_050, 180), 22_050);
}

const raw = await onsets("raw.pcm");
const atempo = await onsets("atempo.pcm");
const rubber = await onsets("rubberband.pcm");
const rate = 1.005747;
const beatOut = 60_000 / 174 / rate; // expected output beat after stretch

function medianResidual(times: number[], beat: number, skip: number): number {
  const rs = times
    .filter((t) => t > skip)
    .map((t) => {
      let d = t % beat;
      if (d > beat / 2) d -= beat;
      return d;
    })
    .sort((a, b) => a - b);
  return rs[Math.floor(rs.length / 2)] ?? NaN;
}

// The raw file itself biases the picker; report raw-vs-its-own-grid as the
// reference zero, then the stretched files against the STRETCHED grid.
console.log(
  "raw vs grid(174):",
  medianResidual(raw, 60_000 / 174, 1000).toFixed(2),
  "ms,",
  raw.length,
  "onsets",
);
console.log(
  "atempo vs stretched grid:",
  medianResidual(atempo, beatOut, 1000).toFixed(2),
  "ms,",
  atempo.length,
  "onsets",
);
console.log(
  "rubberband vs stretched grid:",
  medianResidual(rubber, beatOut, 1000).toFixed(2),
  "ms,",
  rubber.length,
  "onsets",
);
// Also raw vs stretched grid for comparison (should show the ~24ms if it's
// a bias artifact rather than filter latency).
console.log(
  "raw vs stretched grid (control):",
  medianResidual(raw, beatOut, 1000).toFixed(2),
  "ms",
);
