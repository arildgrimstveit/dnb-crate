/**
 * Fit logistic weights for DSP tempo confidence.
 *
 * Usage:
 *   node ./node_modules/tsx/dist/cli.mjs tools/scripts/calibrate-confidence.mts
 *   node ./node_modules/tsx/dist/cli.mjs tools/scripts/calibrate-confidence.mts --config dnb-crate.config.json
 *
 * Writes a table to stdout. Does not modify source; paste the printed constants
 * into packages/audio-analysis/src/dsp-analyzer.ts after reviewing them.
 */
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";
import { dspAnalyzer } from "../../packages/audio-analysis/src/dsp-analyzer.ts";
import { buildClickTrackPcm } from "../../packages/audio-analysis/src/click-track.ts";
import { buildSyntheticDnbPcm } from "../../packages/audio-analysis/src/synthetic-dnb.ts";
import {
  DNB_BPM_MAX,
  DNB_BPM_MIN,
  loadConfig,
  MIN_ANALYSIS_CONFIDENCE,
} from "../../packages/domain/src/index.ts";

type Row = {
  name: string;
  label: number;
  prominence: number;
  stability: number;
  tempoConf: number;
  weight: number;
  inRange?: boolean;
};

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function predict(row: Row, bias: number, w: [number, number, number]): number {
  return sigmoid(bias + w[0] * row.prominence + w[1] * row.stability + w[2] * row.tempoConf);
}

function fitLogistic(rows: Row[]): { bias: number; w: [number, number, number] } {
  let bias = -1.6;
  let w: [number, number, number] = [1.0, 3.2, 1.2];
  const lr = 0.15;
  for (let step = 0; step < 4000; step += 1) {
    let gB = 0;
    const gW = [0, 0, 0];
    let mass = 0;
    for (const row of rows) {
      const x = [row.prominence, row.stability, row.tempoConf];
      const z = bias + w[0] * x[0]! + w[1] * x[1]! + w[2] * x[2]!;
      const p = sigmoid(z);
      const err = (p - row.label) * row.weight;
      gB += err;
      gW[0] += err * x[0]!;
      gW[1] += err * x[1]!;
      gW[2] += err * x[2]!;
      mass += row.weight;
    }
    const n = mass > 0 ? mass : 1;
    bias -= (lr * gB) / n;
    w[0] -= (lr * gW[0]!) / n;
    w[1] -= (lr * gW[1]!) / n;
    w[2] -= (lr * gW[2]!) / n;
  }
  return { bias, w };
}

function evidenceOf(
  name: string,
  label: number,
  pcm: { samples: Float32Array; sampleRateHz: number; durationMs: number; channels: number },
): Row {
  const result = dspAnalyzer.analyze(pcm);
  const ev = result.descriptors?.tempoEvidence;
  return {
    name,
    label,
    prominence: ev?.prominence ?? 0,
    stability: ev?.stability ?? 0,
    tempoConf: ev?.tempoConf ?? 0,
    weight: 1,
  };
}

function thresholdForZeroFalseAccept(rows: Row[], bias: number, w: [number, number, number]): number {
  let maxFalse = 0;
  for (const row of rows) {
    if (row.label !== 0) {
      continue;
    }
    maxFalse = Math.max(maxFalse, predict(row, bias, w));
  }
  const aboveFalse = Math.ceil((maxFalse + 1e-4) * 1000) / 1000;
  return Math.max(0.5, aboveFalse);
}

function countAcceptedCorrect(
  rows: Row[],
  bias: number,
  w: [number, number, number],
  minConfidence: number,
): { acceptedCorrect: number; falseAccept: number } {
  let acceptedCorrect = 0;
  let falseAccept = 0;
  for (const row of rows) {
    if (row.inRange === false) {
      continue;
    }
    const p = predict(row, bias, w);
    if (p < minConfidence) {
      continue;
    }
    if (row.label === 1) {
      acceptedCorrect += 1;
    } else {
      falseAccept += 1;
    }
  }
  return { acceptedCorrect, falseAccept };
}

function loadCrateRows(configPath: string | undefined): Row[] {
  const env = { ...process.env };
  if (configPath && configPath.trim().length > 0) {
    env.DNB_CRATE_CONFIG = configPath;
  }
  let config;
  try {
    config = loadConfig({ env });
  } catch {
    process.stdout.write("No crate config; fitting synthetics only.\n");
    return [];
  }
  const runtime = createCatalogRuntime(config, undefined, { useFakeFfmpeg: true });
  try {
    const rows: Row[] = [];
    let skipped = 0;
    for (const track of runtime.repository.listAll()) {
      if (track.bpmSource !== "published" && track.bpmSource !== "manual") {
        continue;
      }
      const stored = runtime.analyses.findByTrackId(track.id, "dnb-crate-dsp")
        ?? runtime.analyses.findByTrackId(track.id);
      if (!stored) {
        skipped += 1;
        continue;
      }
      const ev = stored.descriptors?.tempoEvidence;
      if (!ev) {
        skipped += 1;
        continue;
      }
      const canonical = track.bpm;
      if (canonical == null) {
        skipped += 1;
        continue;
      }
      const inRange = canonical >= DNB_BPM_MIN - 1e-6 && canonical <= DNB_BPM_MAX + 1e-6;
      const free = stored.bpmRaw ?? stored.bpm;
      const exact = free != null && Math.abs(free - canonical) <= 0.5;
      rows.push({
        name: track.title,
        label: !inRange ? 0 : exact ? 1 : 0,
        prominence: ev.prominence,
        stability: ev.stability,
        tempoConf: ev.tempoConf,
        weight: 2,
        inRange,
      });
    }
    process.stdout.write(
      `Crate rows: ${rows.length} with tempoEvidence (${skipped} published/manual skipped).\n`,
    );
    return rows;
  } finally {
    runtime.close();
  }
}

const sine = new Float32Array(22_050 * 4);
for (let i = 0; i < sine.length; i += 1) {
  sine[i] = Math.sin((2 * Math.PI * 440 * i) / 22_050);
}
const noise = new Float32Array(22_050 * 4);
for (let i = 0; i < noise.length; i += 1) {
  noise[i] = ((i * 1103515245 + 12345) >>> 16) / 32768 - 1;
}

const synthetics: Row[] = [
  evidenceOf("click-174", 1, buildClickTrackPcm({ bpm: 174, durationMs: 12_000, sampleRateHz: 22_050 })),
  evidenceOf("dnb-174", 1, buildSyntheticDnbPcm({ bpm: 174 })),
  evidenceOf("sine", 0, { samples: sine, sampleRateHz: 22_050, durationMs: 4000, channels: 1 }),
  evidenceOf("noise", 0, { samples: noise, sampleRateHz: 22_050, durationMs: 4000, channels: 1 }),
];

const args = process.argv.slice(2);
const crateRows = loadCrateRows(option(args, "--config"));
const rows = [...synthetics, ...crateRows];
const fit = fitLogistic(rows);
const suggestedMin = thresholdForZeroFalseAccept(rows, fit.bias, fit.w);
const oldW: [number, number, number] = [1.0, 3.2, 1.2];
const baseline = countAcceptedCorrect(crateRows, -1.6, oldW, MIN_ANALYSIS_CONFIDENCE);
const next = countAcceptedCorrect(crateRows, fit.bias, fit.w, suggestedMin);

process.stdout.write("name\tlabel\tprominence\tstability\ttempoConf\tweight\tinRange\n");
for (const row of rows) {
  process.stdout.write(
    `${row.name}\t${row.label}\t${row.prominence.toFixed(3)}\t${row.stability.toFixed(3)}\t${row.tempoConf.toFixed(3)}\t${row.weight}\t${row.inRange ?? ""}\n`,
  );
}
const fittedAtCurrentMin = countAcceptedCorrect(crateRows, fit.bias, fit.w, MIN_ANALYSIS_CONFIDENCE);
process.stdout.write("\nCrate predictions (old weights / fitted weights):\n");
for (const row of crateRows) {
  const oldP = predict(row, -1.6, oldW);
  const newP = predict(row, fit.bias, fit.w);
  process.stdout.write(
    `  ${row.name}\tlabel=${row.label}\tinRange=${row.inRange}\told=${oldP.toFixed(3)}\tfitted=${newP.toFixed(3)}\n`,
  );
}
process.stdout.write(
  `\n// Fitted 2026-09-03 on synthetic click/DnB/sine/noise + crate published/manual (weight 2)\n`,
);
process.stdout.write(`const TEMPO_LOGISTIC_BIAS = ${fit.bias.toFixed(4)};\n`);
process.stdout.write(`const TEMPO_LOGISTIC_W_PROMINENCE = ${fit.w[0]!.toFixed(4)};\n`);
process.stdout.write(`const TEMPO_LOGISTIC_W_STABILITY = ${fit.w[1]!.toFixed(4)};\n`);
process.stdout.write(`const TEMPO_LOGISTIC_W_TEMPO_CONF = ${fit.w[2]!.toFixed(4)};\n`);
process.stdout.write(
  `\nUnconstrained MIN (false-accept = 0, floor 0.5) = ${suggestedMin.toFixed(3)}\n`,
);
process.stdout.write(
  `In-range crate accepted-correct: baseline ${baseline.acceptedCorrect} (false ${baseline.falseAccept}) at MIN ${MIN_ANALYSIS_CONFIDENCE}\n`,
);
process.stdout.write(
  `  fitted weights @ MIN ${MIN_ANALYSIS_CONFIDENCE}: ${fittedAtCurrentMin.acceptedCorrect} (false ${fittedAtCurrentMin.falseAccept})\n`,
);
process.stdout.write(
  `  fitted weights @ unconstrained MIN: ${next.acceptedCorrect} (false ${next.falseAccept})\n`,
);
if (next.acceptedCorrect < baseline.acceptedCorrect || fittedAtCurrentMin.acceptedCorrect < baseline.acceptedCorrect) {
  process.stdout.write(
    `Keep existing weights and MIN ${MIN_ANALYSIS_CONFIDENCE}: fitted curve drops accepted-correct.\n`,
  );
}
