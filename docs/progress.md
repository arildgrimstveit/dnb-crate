# Progress

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

- Envelope analyzer is click-track accurate; real-music grids are advisory
- Key estimation is weak on broadband material
- Listening QA for phrase mixes / bass swaps / long mixes is not in `manual-test-log.md` (no FFmpeg on the implementation machine)
- `double_drop` is Stage 5
- Fingerprint is size + first/last 64 KiB
- Apps run from TypeScript via `tsx`

## Next

Stage 5 is not started. Authorize it explicitly before doubles, feedback, or HTTP transport.
