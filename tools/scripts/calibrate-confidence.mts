/**
 * Fit logistic weights for DSP tempo confidence.
 *
 * Usage: corepack pnpm exec tsx tools/scripts/calibrate-confidence.mts
 * Writes a table to stdout. Does not modify source; paste the printed constants
 * into packages/audio-analysis/src/dsp-analyzer.ts after reviewing them.
 */
import { dspAnalyzer } from "../../packages/audio-analysis/src/dsp-analyzer.ts";
import { buildClickTrackPcm } from "../../packages/audio-analysis/src/click-track.ts";
import { buildSyntheticDnbPcm } from "../../packages/audio-analysis/src/synthetic-dnb.ts";

type Row = { name: string; label: number; prominence: number; stability: number; tempoConf: number };

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function fitLogistic(rows: Row[]): { bias: number; w: [number, number, number] } {
  let bias = -1.6;
  let w: [number, number, number] = [1.0, 3.2, 1.2];
  const lr = 0.15;
  for (let step = 0; step < 4000; step += 1) {
    let gB = 0;
    const gW = [0, 0, 0];
    for (const row of rows) {
      const x = [row.prominence, row.stability, row.tempoConf];
      const z = bias + w[0] * x[0]! + w[1] * x[1]! + w[2] * x[2]!;
      const p = sigmoid(z);
      const err = p - row.label;
      gB += err;
      gW[0] += err * x[0]!;
      gW[1] += err * x[1]!;
      gW[2] += err * x[2]!;
    }
    const n = rows.length;
    bias -= (lr * gB) / n;
    w[0] -= (lr * gW[0]!) / n;
    w[1] -= (lr * gW[1]!) / n;
    w[2] -= (lr * gW[2]!) / n;
  }
  return { bias, w };
}

function evidenceOf(name: string, label: number, pcm: { samples: Float32Array; sampleRateHz: number; durationMs: number; channels: number }): Row {
  const result = dspAnalyzer.analyze(pcm);
  const ev = result.descriptors?.tempoEvidence;
  return {
    name,
    label,
    prominence: ev?.prominence ?? 0,
    stability: ev?.stability ?? 0,
    tempoConf: ev?.tempoConf ?? 0,
  };
}

const sine = new Float32Array(22_050 * 4);
for (let i = 0; i < sine.length; i += 1) {
  sine[i] = Math.sin((2 * Math.PI * 440 * i) / 22_050);
}
const noise = new Float32Array(22_050 * 4);
for (let i = 0; i < noise.length; i += 1) {
  noise[i] = ((i * 1103515245 + 12345) >>> 16) / 32768 - 1;
}

const rows: Row[] = [
  evidenceOf("click-174", 1, buildClickTrackPcm({ bpm: 174, durationMs: 12_000, sampleRateHz: 22_050 })),
  evidenceOf("dnb-174", 1, buildSyntheticDnbPcm({ bpm: 174 })),
  evidenceOf("sine", 0, { samples: sine, sampleRateHz: 22_050, durationMs: 4000, channels: 1 }),
  evidenceOf("noise", 0, { samples: noise, sampleRateHz: 22_050, durationMs: 4000, channels: 1 }),
];

const fit = fitLogistic(rows);
process.stdout.write("name\tlabel\tprominence\tstability\ttempoConf\n");
for (const row of rows) {
  process.stdout.write(
    `${row.name}\t${row.label}\t${row.prominence.toFixed(3)}\t${row.stability.toFixed(3)}\t${row.tempoConf.toFixed(3)}\n`,
  );
}
process.stdout.write(
  `\n// Fitted ${new Date().toISOString().slice(0, 10)} on synthetic click/DnB/sine/noise\n`,
);
process.stdout.write(`const TEMPO_LOGISTIC_BIAS = ${fit.bias.toFixed(4)};\n`);
process.stdout.write(`const TEMPO_LOGISTIC_W_PROMINENCE = ${fit.w[0]!.toFixed(4)};\n`);
process.stdout.write(`const TEMPO_LOGISTIC_W_STABILITY = ${fit.w[1]!.toFixed(4)};\n`);
process.stdout.write(`const TEMPO_LOGISTIC_W_TEMPO_CONF = ${fit.w[2]!.toFixed(4)};\n`);
