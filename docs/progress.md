# Progress

## Analysis v2.1 — grids to mixes (2026-09-02)

What works:

- Planner tempo-matched `phrase_mix` / `bass_swap` (canonical BPM, shared target, chain-stable rates; fallback `crossfade` with `tempo-out-of-range`)
- Comb-locked sub-hop beat times; downbeat alignment in output time (`alignmentPeriodMs` on the manifest)
- Key v2: spectral-peak chroma 165–3520 Hz, tuning, harmonic suppression, KK+Temperley
- Tempo confidence logistic (no 0.55 floor); reject below **0.6**
- Downbeat-anchored sections (8-bar minimum, merged labels, two-drop / drop-ending fixtures)
- Analyzer cues are inferred in `plan_transition` (reasons, not blockers); mix-out never uses drop
- `get_analysis_report` splits in-range vs out-of-range; CLI `analysis:gate`
- Optional Python sidecar timeout + `--input` batching (install/comparison skipped)

Evidence (2026-09-02, Node 24, Windows):

- `node ./node_modules/vitest/vitest.mjs run` — 17 files, **90 passed**
- `tsc --noEmit` — passed
- `analysis:gate` (DSP only; 14 published-BPM tracks; in-range = published 160–190):
  - In-range **9**, out-of-range **5** (124 / 125 / 140 / 159 / 159)
  - **6/9** in-range DSP BPM within 0.5 of published (same count as the v2.0 baseline)
  - Accepted exact 174: Coming Down, Basic Instinct, Witchcraft, Turn Up the Bass, Tidal Wave. Departure still estimates 174 but is rejected (confidence 0.28 — the old 0.55 floor was hiding this). Last Jungle 160 rejected at 0.58. Like a Memory 175 vs 176 (accepted). It Must Be 175 rejected.
  - No confidence plateau at 0.55. No accepted in-range grid at a wildly wrong tempo (Last Jungle is rejected).
  - Keys no longer collapse to F/Dm: Gm×3 is the mode; others unique or pairs. Target ≤3 tracks sharing one key holds.
- Default engine remains **`dnb-crate-dsp`**. Mix tempo still uses published/manual canonical BPM.
- Target in-range exact ≥ 8/10 is **not** met; synthetic fixtures are green. Python `beat-this` comparison not run.
- Ear-check of bass-swap / drop previews not repeated in this pass (existing `output/previews/` from v2.0).

## Stage 5 — Analysis v2 + mix intelligence

What works:

- `dnb-crate-dsp` 2.0: spectral-flux onsets, tempogram, DP beats, downbeats, chroma key with mode, sections, descriptors, suggestedEnergy
- Optional Python sidecar (`beat-this` / `allin1`) behind the same result shape; merger keeps DSP key/descriptors
- Per-engine `track_analyses` + `track_sections`; provenance **manual > published > analyzed > tag**
- Planner auto-selects phrase_mix / bass_swap / crossfade from grids and section lengths
- Transition planner uses section/downbeat windows; `<=` overlap bug fixed
- Renderer downbeat-phase alignment (`downbeatOffsetMs` on the manifest)
- Scoring uses suggestedEnergy fallback + structure compatibility; search filters for sub-bass/brightness
- MCP: `compare_track_analyses`, `get_track_sections`, `get_analysis_report`, `create_cue_preview`

Evidence (2026-09-02, Node 24, Windows):

- `vitest run` — 17 files, **70 passed**
- `tsc --noEmit` — passed
- Crate gate (14 store-lookup BPMs, retagged `bpmSource: published`, DSP only; Python sidecar not installed):
  - **6/14** DSP BPM within 0.5 of the stored published value
  - **6/9** exact 174 on tracks whose published BPM is 174 (Coming Down, Basic Instinct, Witchcraft, Turn Up the Bass, Tidal Wave, Departure)
  - 4 published values are outside DnB range (124 / 125 / 140 / 159), so 12/14 vs raw published is not a DSP-quality metric
  - 10 drop cue previews in `output/previews/`
- Default engine remains **`dnb-crate-dsp`**. Mix tempo still uses published/manual canonical BPM.

## Stage 4 — complete (automated gate)

What works:

- `@dnb-crate/audio-analysis`: envelope BPM/grid, half/double fold into 160–190, rejected low-confidence grids, click-track fixtures
- Analysis jobs (`queued` / `running` / `succeeded` / `failed`); interrupted jobs marked failed/retryable
- Manual BPM/key/cues override analysis without deleting the analysis row
- `plan_transition` / `validate_transition`; `update_set_plan.applyTransition` and `setPlaybackRate`
- Renderer: `atempo` tempo matching (±3%), `phrase_mix` (high-pass fade-in), `bass_swap` (bounded crossover/ramp). Pairwise mix when templates are not a single acrossfade chain
- Aligned renders blocked on missing/low-confidence grids unless `allowLowConfidence`
- MCP tools: `start_track_analysis`, `get_analysis_status`, `get_track_analysis`, `plan_transition`, `validate_transition`; resource `dnbcrate://tracks/{trackId}/analysis`
- CLI: `analysis:*`, `transition:plan`, `transition:validate`

Evidence (2026-08-31, Node 24.16.0, Windows):

- `pnpm test` — 13 files, **56 passed**, 2 skipped (real-FFmpeg crossfade + atempo pitch tests: ffmpeg/ffprobe were not on PATH)
- Fake-process coverage: click-track grids, half-time fold, rejected sine/noise grids, manual BPM over analysis, aligned-render fail-closed, Stage 3 render regressions, MCP 26-tool list
- `pnpm typecheck` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed

## Stage 3 — complete (automated gate)

Equal-power WAV rendering, jobs, previews, manifests. Still passing as regressions (crossfade path unchanged).

## Stage 2 — complete (automated gate)

Cue points, deterministic planner, set-plan resources. Still passing.

## Stage 1 — complete (automated gate)

Catalog, scanner, search, CLI, MCP stdio. Still passing.

## Known limitations (through Stage 4)

- Envelope analyzer is click-track accurate; real-music grids are advisory (superseded by `dnb-crate-dsp`, still true for legacy envelope rows)
- Key estimation is weak on broadband material (DSP chroma is the v2 path)
- Listening QA for phrase mixes / bass swaps / long mixes is not in `manual-test-log.md` (no FFmpeg on the implementation machine)
- `double_drop` remains later work
- Fingerprint is size + first/last 64 KiB
- Apps run from TypeScript via `tsx`

## Next

Optional: enable the Python sidecar and compare `beat-this` on the same 14 tracks. Ear-check `output/previews/*-drop.wav`.
