# Decisions

## 2026-09-02 — `-filter_complex` fallback

`-filter_complex_script` is probed at detect time (`ffmpeg -filter_complex_script` with no file). If FFmpeg reports `Unrecognized option`, mixes use inline `-filter_complex` instead. Observed on Windows nightly `N-125875` (2026-07-31), which has `acrossfade`/`atempo`/`ebur128` but not the script option. The script path stays preferred when present so long graphs do not inflate argv.

## 2026-08-31 — MCP TypeScript SDK v2 packages

The implementation spec named `@modelcontextprotocol/sdk`. The stable TypeScript line for MCP revision 2026-07-28 ships as `@modelcontextprotocol/server` and `@modelcontextprotocol/client` (v2.0.0). Stage 1 uses those packages, `registerTool` / `registerResource`, `serveStdio`, and Zod 4 schemas (`zod/v4`).

## 2026-08-31 — TypeScript executed with tsx

Apps run from TypeScript source via `tsx` rather than a `dist/` compile step. Workspace `exports` point at `src/index.ts`. This keeps Stage 1 iteration short; a compile pipeline can be added when packaging for non-dev hosts.

## 2026-08-31 — File fingerprint

A track fingerprint is SHA-256 over file size plus the first and last 64 KiB (the tail is omitted when the file is smaller than 64 KiB). Modification time is **not** mixed into the hash: including it made copy/rewrite moves look like new files. Two different files that share size and those windows can still collide. That is accepted for Stage 1 move detection. A full-file hash can replace this later if collisions appear.

## 2026-08-31 — Missing title statistic

`missingTitleFromTagsCount` is approximated as “title equals the filename stem”. Embedded title tags that happen to match the filename are counted as missing. Good enough for Stage 1 hygiene; a dedicated provenance flag can be added later.

## 2026-08-31 — Stage 2 timing overlap

Stage 2 treats a 30-second crossfade as a **timing assumption only**. Transition type is stored on the plan so Stage 3 can render it; no audio is mixed yet.

## 2026-08-31 — Manual BPM/key vs rescan

File scans no longer overwrite BPM or key when `bpmSource` / `keySource` is `manual`. Energy, rating, moods, tags, and notes were already preserved.

`fileMissing` is included on public tracks so a search can still find a renamed/deleted file without exposing `filePath`. `filePath` is omitted from every MCP and default CLI search result.

## 2026-08-31 — Prompt schemas live in domain

`apps/mcp-server` does not depend on `zod`. `build-dnb-set` argument schemas are exported from `@dnb-crate/domain` (`buildDnbSetPromptArgsSchema`) so the MCP server can pass them to `registerPrompt` without a direct Zod import.

## 2026-08-31 — get_track vs update_track_metadata output

`get_track` returns a public track **plus** `cuePoints` (`getTrackDataSchema`). `update_track_metadata` still returns a public track without requiring cue points (`publicTrackSchema`).

## 2026-08-31 — Stage 3 renderer and loudness

WAV is the only output. Mixing uses FFmpeg `acrossfade` with `hsin` curves (equal-power) at 48 kHz stereo `pcm_s24le`. Argument arrays only; filter graphs use stream labels, never source paths.

Loudness: mix-wide target **-14 LUFS**, true-peak ceiling **-1 dBTP**. Individual tracks are not loudnormed. If integrated LUFS is more than 0.5 LU above target, one mix-wide attenuation is applied. Stage 3 does not promise bit-identical output across FFmpeg builds.

Jobs persist in SQLite. `cancel_render_job` aborts the child process. Running jobs leftover after a crash are marked `RENDER_INTERRUPTED`.

The in-process fake FFmpeg runner is used in catalog/MCP tests so the gate does not require a system FFmpeg install. A real-FFmpeg integration test skips when binaries are missing.

## 2026-08-31 — Stage 4 analyzer and atempo

Beat grids come from a TypeScript onset-envelope analyzer (`dnb-crate-envelope`) plus WAV decode. No Python worker and no native aubio: Windows native builds were rejected, and a second runtime would split the product. Key estimation is a coarse pitch/zero-crossing hint and is often omitted (confidence 0) on broadband/click material; tags and manual keys remain canonical.

Pitch-preserving stretch uses FFmpeg `atempo` after `atrim`/`asetpts`. `asetrate` is not used because it would shift pitch.

Bass-swap EQ frequencies, swap bar, and ramp are clamped template parameters (crossover 120–250 Hz, ramp 20–80 ms). The model cannot pass raw filter expressions.

## 2026-09-02 — Analysis v2 engines

Stage 4's envelope analyzer stays as `dnb-crate-envelope` for migrated rows. The default engine is in-process TypeScript DSP (`dnb-crate-dsp` 2.0): STFT spectral flux, tempogram, Ellis-style DP beat tracking, chroma key with mode, novelty sections, descriptors.

essentia.js was evaluated and rejected (last release 0.1.3 in 2021, AGPL-3.0, Node slowest in the authors' benchmarks, WASM heap OOM on full-length files, mood models need native `@tensorflow/tfjs-node`).

An optional Python sidecar (`beat-this`, `allin1`) is allowed behind the same `AudioAnalyzer` JSON shape when `analysis.engines.python.enabled` is true. The TypeScript engine remains the always-available default so the product never depends on Python. Sidecar rhythm is merged with DSP key/descriptors. Python 3.12 is pinned because torch wheels lag 3.14.

Provenance for BPM/key is **manual > published > analyzed > tag**. `update_track_metadata` accepts `bpmSource: "published"` for store/label lookups.

The 2026-08-31 wording "No Python worker and no native aubio" is superseded for the *optional adapter only*; native aubio remains rejected.

## 2026-09-02 — Key estimation v2 and confidence calibration

DSP key uses HPCP-style chroma in **165–3520 Hz** (spectral peaks rather than every FFT bin, global tuning histogram, suppression of energy explained as the 2nd/3rd harmonic of a lower note), median of L1-normalised frames after dropping the quietest 20 %, and the average of Krumhansl–Kessler and Temperley rank scores. The low cutoff is 165 Hz so a kick's 2nd harmonic (~110 Hz) cannot alias into a neighbouring pitch class. `chromaVector` is stored on descriptors for inspection.

Tempo confidence is a 3-feature logistic (prominence, stability, grid-vs-rival) fitted on synthetic click/DnB/sine/noise. The **0.55 clamp is gone**. After the v2.1 onset/tempo path, Last Jungle was a false accept at 0.58 (160 vs published 174), so `MIN_ANALYSIS_CONFIDENCE` is **0.6**. `allowLowConfidence` remains the override. Re-run `tools/scripts/calibrate-confidence.mts` when the onset/tempo path changes.

## 2026-09-02 — Default analysis engine

`dnb-crate-dsp` stays the default. The Python sidecar is optional; a `beat-this` crate comparison was not required to ship v2.1. Switch the default only if beat-this is ≥ 2 tracks better on in-range published BPM and adds < 10 s/track.

## 2026-09-03 — Reference grids from canonical BPM

Published/manual BPM is a **phase reference**, not a new canonical source. The analyzer still estimates freely; if that grid is rejected or disagrees by > 0.5 BPM, it fits `bestOffsetForBpm` at the reference and runs the same logistic. Features are measured on the reference comb (grid-vs-rival, on-grid ratio, windowed comb stability) so a clean free estimate cannot carry a wrong tempo over the threshold. Accept → `gridSource: "reference"`. Reject → never keep a wrong-tempo free grid. Applies to out-of-range references (125 still gets a 125 grid for cues/sections). `007_grid_source` stores the provenance.

## 2026-09-03 — Confidence calibration on the crate

`calibrate-confidence.mts --config` now loads stored `tempoEvidence` for published/manual tracks (no re-analysis), labels `|bpmRaw − canonical| ≤ 0.5` (out-of-range refs = 0), and fits with those rows at weight 2 plus the synthetic click/DnB/sine/noise rows.

Unconstrained fit on the 14 labelled crate rows (2026-09-03): bias −3.4732, prominence 4.0339, stability 0.2045, tempoConf 4.3950. Zero-false-accept MIN would be **0.795**, but that drops in-range accepted-correct from **5 → 1**. Fitted weights at MIN 0.6 drop it to **3**. The driver is Like a Memory (free 175 vs published 176) scoring as a false accept alongside true 174s. Last Jungle (160 vs 174) is already rejected at 0.582.

**Kept** the 2026-09-02 synthetic weights and **MIN 0.6**. Fixtures stay green; accepted-correct does not drop. Re-run after a reference-grid re-analysis if Like a Memory locks to 176.

## 2026-09-03 — 3-band mix presets

Phrase-mix and bass-swap are no longer two hard-coded graphs. `expandPreset` builds per-band automation (low / mid / high) that both the planner and the renderer compile. The graph is `asplit=3` → band filters → chained `afade` → `amix=inputs=6`. Crossfade stays `acrossfade`. `RENDERER_VERSION` is **6.0.0** so preview cache keys change. Partial fades need FFmpeg `afade` `unity`/`silence`; the local build has them, and the fake runner advertises them.
