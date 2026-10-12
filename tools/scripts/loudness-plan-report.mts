import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createNodeProcessRunner,
  detectFfmpeg,
  measureLoudnessSeries,
} from "../../packages/audio-renderer/src/index.ts";
import {
  solveSetGains,
  windowShortTermLoudness,
  type SetGainEntry,
} from "../../packages/domain/src/index.ts";

/**
 * Q04 advisory report (12 October 2026): for one stored set plan, measure
 * each entry's PLAYABLE BODY window on the original stereo signal
 * (time-indexed ebur128 series), run the joint attenuate-first gain
 * solver, and print CURRENT vs PROPOSED gains with residuals. This is the
 * roadmap's measure-and-report step BEFORE any gain policy flips - the
 * owner auditions the difference; nothing is written to the catalog.
 *
 * Usage: pnpm tsx tools/scripts/loudness-plan-report.mts <setPlanId>
 */

const req = createRequire("C:/Users/arild/repos/dnb-crate/packages/catalog/package.json");
const Database = req("better-sqlite3") as new (
  path: string,
  options?: { readonly: boolean },
) => {
  prepare: (sql: string) => { get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] };
};

const planId = process.argv[2];
if (!planId) {
  console.error("usage: loudness-plan-report.mts <setPlanId>");
  process.exit(1);
}

type EntryRow = {
  id: string;
  track_id: string;
  order_index: number;
  source_start_ms: number;
  source_end_ms: number;
  playback_rate: number;
  gain_db: number;
};
type TrackRow = { title: string; file_path: string; duration_ms: number };
type AnalysisRow = { true_peak_db: number | null; integrated_lufs: number | null };

const db = new Database("data/dnb-crate.sqlite", { readonly: true });
const entries = db
  .prepare(
    `SELECT id, track_id, order_index, source_start_ms, source_end_ms, playback_rate, gain_db
     FROM set_plan_entries WHERE set_plan_id = ? ORDER BY order_index`,
  )
  .all(planId) as EntryRow[];
if (entries.length === 0) {
  console.error(`no entries for plan ${planId}`);
  process.exit(1);
}
const nameRow = db.prepare(`SELECT name FROM set_plans WHERE id = ?`).get(planId) as
  | { name: string }
  | undefined;
console.log(`plan: ${nameRow?.name ?? planId} (${entries.length} entries)`);

const runner = createNodeProcessRunner();
const binaries = await detectFfmpeg(runner, {
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
});
if (!binaries) {
  console.error("ffmpeg unavailable");
  process.exit(1);
}

const solverEntries: SetGainEntry[] = [];
const detail: Array<Record<string, unknown>> = [];
for (const entry of entries) {
  const track = db
    .prepare(`SELECT title, file_path, duration_ms FROM tracks WHERE id = ?`)
    .get(entry.track_id) as TrackRow | undefined;
  const analysis = db
    .prepare(`SELECT true_peak_db, integrated_lufs FROM track_analyses WHERE track_id = ?`)
    .get(entry.track_id) as AnalysisRow | undefined;
  if (!track) {
    continue;
  }
  const series = await measureLoudnessSeries(runner, binaries, track.file_path);
  const shortTermLufs = series.frames.map((frame) => frame.shortTermLufs);
  const body = windowShortTermLoudness({ hopMs: series.hopMs, shortTermLufs }, {
    startMs: entry.source_start_ms,
    endMs: entry.source_end_ms,
  });
  solverEntries.push({
    id: entry.id,
    bodyShortTermLufs: body?.medianLufs ?? null,
    truePeakDb: analysis?.true_peak_db ?? null,
    currentGainDb: entry.gain_db,
  });
  const row = {
    order: entry.order_index,
    title: track.title,
    bodyMedianLufs: body?.medianLufs ?? null,
    bodyCoverage: body?.coverage ?? null,
    integratedLufs: analysis?.integrated_lufs ?? null,
    currentGainDb: entry.gain_db,
  };
  detail.push(row);
  console.log(
    `  ${String(entry.order_index).padStart(2)} ${track.title.padEnd(44)} body ${row.bodyMedianLufs ?? "  ?  "} LUFS (cov ${body ? body.coverage.toFixed(2) : "-"})  integrated ${row.integratedLufs ?? "?"}  gain ${entry.gain_db > 0 ? "+" : ""}${entry.gain_db} dB`,
  );
}

const solution = solveSetGains(solverEntries);
console.log(`\nsolver reference: ${solution.referenceLufs ?? "none (no loudness)"} LUFS`);
console.log("proposed changes (attenuate-first, -6..+3 dB, peak-capped boosts):");
let changes = 0;
for (const gain of solution.gains) {
  const row = detail.find((d) => d.id === gain.id || d.order === solverEntries.findIndex((e) => e.id === gain.id));
  const current = solverEntries.find((e) => e.id === gain.id)!.currentGainDb;
  if (!gain.matched) {
    console.log(`  ${String(row?.order ?? "?").padStart(2)} ${row?.title ?? gain.id}: no loudness - passthrough ${current} dB`);
    continue;
  }
  if (Math.abs(gain.gainDb - current) > 0.05) {
    changes += 1;
  }
  console.log(
    `  ${String(row?.order ?? "?").padStart(2)} ${row?.title ?? gain.id}: ${current > 0 ? "+" : ""}${current} -> ${gain.gainDb > 0 ? "+" : ""}${gain.gainDb} dB${Math.abs(gain.residualLufs) > 0.05 ? `  (residual ${gain.residualLufs} LU)` : ""}`,
  );
}
console.log(`\nentries changed: ${changes}/${solution.gains.length}  total boost: ${solution.totalBoostDb} dB`);

const report = {
  generatedAt: new Date().toISOString(),
  setPlanId: planId,
  planName: nameRow?.name ?? null,
  solution,
  detail: detail.map((d, i) => ({ ...d, id: solverEntries[i]?.id })),
};
const out = path.join(import.meta.dirname, "..", "reports", `loudness-plan-${planId.slice(0, 8)}.json`);
await writeFile(out, JSON.stringify(report, null, 2));
console.log(`report: ${path.relative(process.cwd(), out)}`);
