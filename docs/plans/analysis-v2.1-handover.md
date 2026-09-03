# Handover plan — Analysis v2.1: close the loop from grids to mixes

Status: ready to start. Nothing in this plan is committed yet; the Stage 5 work it builds on is also uncommitted on `main`.

## 0. Context for whoever picks this up

**What exists (Stage 5, uncommitted):** `dnb-crate-dsp` 2.0 (STFT onsets, comb tempo fit, DP beat tracker, downbeat phase, chroma key, novelty sections, descriptors), optional Python sidecar, per-engine `track_analyses` + `track_sections`, provenance `manual > published > analyzed > tag`, planner auto-picking `phrase_mix` / `bass_swap` / `crossfade`, renderer downbeat-phase alignment, MCP tools `compare_track_analyses` / `get_track_sections` / `get_analysis_report` / `create_cue_preview`.

**Where it falls short (from the 2026-09-02 review):**

1. Planner picks aligned transitions but never sets `playbackRate`, so grids drift across the overlap.
2. Key detection is biased (6/14 tracks → `F`, 3 → `Dm`).
3. BPM confidence has a hard-coded 0.55 floor sitting just above the 0.5 gate.
4. Beat times are quantised to the 23 ms STFT hop; downbeat alignment inherits the error.
5. Sections are cut only at 8-bar multiples from t=0, never merged, confidence constant.
6. Analyzer cues are persisted as real cues and then treated as authoritative by the transition planner.
7. `get_analysis_report` cannot distinguish "engine miss" from "published BPM outside 160–190".
8. Python sidecar is untested against real installs; fake confidences; no timeout.
9. Compiled `.js` emitted next to `.ts` sources; `001_init` migration was edited after being applied.

**Environment notes**

- Windows, Node 24, FFmpeg on PATH. `pnpm` is not on PATH; use `node ./node_modules/vitest/vitest.mjs run` and `node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json --pretty false`. `corepack pnpm exec tsx <file>` works for scripts.
- Private crate under a gitignored music folder (583 tracks). Local DB `data/dnb-crate.sqlite`, config `dnb-crate.config.json`, output `output/` — all gitignored. Never commit `data/`, `output/`, config, audio, or library paths.
- Gate set: 14 tracks with `bpmSource: "published"` (IDs in §8). 9 of them are published at 174; the other 5 are 124 / 125 / 140 / 159 / 159 / 176.
- Baseline before this plan: `vitest` 17 files / 70 tests green; `tsc --noEmit` clean; DSP hits 6/9 published-174 tracks exactly; drop previews in `output/previews/`.

**Ground rules**

- Do not edit `.cursor/plans/*`.
- Every work package ends with the full test suite + typecheck green. Do not merge a package that lowers the gate numbers in §8.
- Analysis stays advisory. Canonical BPM/key precedence is not negotiable.
- Commit per work package (small, reviewable). Don't commit until WP0 has cleaned the tree.

---

## 1. Work packages and order

| WP | Title | Why first/last | Est. |
| --- | --- | --- | --- |
| 0 | Repo hygiene + migration cleanup | Everything else commits on top of this | 0.5 h |
| 1 | Tempo-matched aligned transitions in the planner | Biggest audible win; unblocks trusting grids | 2 h |
| 2 | Sub-hop beat times + output-time downbeat alignment | Bass swaps cancel without it | 2 h |
| 3 | Key estimation v2 | Harmonic scoring is currently misinformed | 3 h |
| 4 | Confidence calibration (remove the 0.55 floor) | Needs WP2's cleaner grid first | 2 h |
| 5 | Sections v2 (downbeat-anchored, merged, scored) | Feeds WP1 trims and cue previews | 3 h |
| 6 | Cue provenance in the transition planner | Depends on WP5 section quality | 1 h |
| 7 | Analysis report v2 + gate script as a CLI command | Makes §8 repeatable | 1.5 h |
| 8 | Sidecar hardening + real `beat-this` comparison | Optional; needs Python 3.12 | 2 h + install |
| 9 | Missing unit tests | Spread across WPs; listed here for tracking | — |

WP1–WP2 can be done in parallel by two people. WP3 is independent of everything except WP0. WP4 must follow WP2. WP6 must follow WP5.

---

## 2. WP0 — Repo hygiene + migration cleanup

**Files:** `.gitignore`, `packages/**/src/**/*.js`, `packages/**/test/**/*.js`, `apps/**/src/**/*.js`, `apps/**/test/**/*.js`, `tsconfig.tsbuildinfo`, `node_modules/.vite/`, `packages/catalog/src/migrations/001_init.ts`.

Steps

1. Delete every `.js` that has a sibling `.ts` under `packages/*/src`, `packages/*/test`, `apps/*/src`, `apps/*/test`. Sanity check: `git status --short | rg '\.js$'` should be empty afterwards. Do not touch `vitest.config.js` if `vitest.config.ts` is the real one (it is — delete the `.js`).
2. Delete `tsconfig.tsbuildinfo`.
3. Add to `.gitignore`:
   ```
   *.tsbuildinfo
   node_modules/.vite/
   packages/*/src/**/*.js
   packages/*/test/**/*.js
   apps/*/src/**/*.js
   apps/*/test/**/*.js
   ```
4. Revert the `'published'` addition in `001_init.ts` so the CHECK constraint there matches what shipped; migration 006 remains the only place that widens it. Fresh DBs then apply 001 → 006 exactly like existing DBs.
5. Run tests + typecheck. Commit: `chore: remove emitted js, gitignore build artifacts, keep 001_init immutable`.

Acceptance: `git status` shows only intentional source changes; `vitest` and `tsc` green.

---

## 3. WP1 — Tempo-matched aligned transitions

**Problem:** `chooseTransition` in `packages/catalog/src/planning/timeline.ts` returns `phrase_mix`/`bass_swap` when grids are within ±3 %, but `buildEntries` sets `playbackRate = prior?.playbackRate ?? 1`. Aligned overlaps therefore run at two different tempos.

**Files:** `packages/catalog/src/planning/timeline.ts`, `packages/catalog/src/planning/planner.ts`, `packages/catalog/src/service.ts` (where `analysisToTimeline` is built), `packages/domain/src/planning.ts` (TransitionPlan `parameters`), `packages/catalog/test/planning.test.ts`, `docs/analysis.md`, `docs/scoring.md`.

Design

- `TimelineAnalysis` gains `canonicalBpm: number | null` (from `resolveCanonicalBpm(track, analysis).bpm`). `gridOk` stays keyed on the analysis grid, but all tempo maths uses `canonicalBpm`. This fixes the precedence violation where `chooseTransition` used `analysis.bpm` for bar length.
- `chooseTransition(outgoing, incoming)` returns `{ transition, outgoingRate, incomingRate, targetBpm }`. Target BPM: `normalizeDnbBpm((outCanon + inCanon) / 2)`, same rule as `transition-planner.ts`. Rates via `playbackRateForBpm`; check with `assertPlaybackRate(rate, { allowExcessive: false })`. If either rate fails, fall back to `crossfade` with `parameters.reason = "tempo-out-of-range"`.
- `buildEntries` applies the incoming rate to the next entry and, for the first aligned pair only, the outgoing rate to the current entry. A track that is both incoming (from pair i−1) and outgoing (to pair i+1) keeps the rate it received as incoming; pair i+1's target is recomputed from its *effective* BPM (`canonicalBpm × rate`). This keeps a chain of 174/175/176 tracks converging instead of jumping.
- `TransitionPlan.parameters` records `{ targetBpm, barCount, reason }`. `playableOutputMs` already divides by rate, so timeline math is unchanged.
- `update_set_plan.setPlaybackRate` still overrides; `prior?.playbackRate` wins in `buildEntries` when present.

Tests (`planning.test.ts`)

- Two tracks 174 / 176 with `gridOk` analyses → `bass_swap` or `phrase_mix`, incoming `playbackRate ≈ 174/175 … 176/175`, both within ±3 %, `parameters.targetBpm === 175`.
- 174 / 182 → `crossfade`, rates 1, reason `tempo-out-of-range`.
- Chain 174 / 175 / 176: rates monotone, no entry deviates > 3 % from its canonical.
- Manual `prior.playbackRate` survives a re-plan.

Docs: add a "Planner tempo matching" paragraph to `docs/analysis.md`; update `build-dnb-set` prompt in `apps/mcp-server/src/create-server.ts` to say aligned transitions come tempo-matched.

Acceptance: tests above pass; re-plan of the liked plan `0e2b79c6-4b8e-4b49-99f0-53aa1d6f4a56` (via `plan:create` with same seed/end-query) shows non-unit rates on aligned pairs and `validate_set_plan` is clean.

---

## 4. WP2 — Sub-hop beat times + output-time alignment

**Problem:** `trackBeats` in `packages/audio-analysis/src/dsp-analyzer.ts` returns `frame * hopMs` (hop 512 @ 22 050 Hz ≈ 23.2 ms). `downbeatAlignmentOffsetMs` in `packages/audio-renderer/src/downbeat-align.ts` works in source ms and ignores playback rate.

**Files:** `dsp-analyzer.ts` (`trackBeats`, `estimateTempo`/`fitTempoGrid` — expose `bestOffset`), `downbeat-align.ts`, `packages/catalog/src/render/coordinator.ts` (~line 530–555), `packages/audio-analysis/test/dsp-analyzer.test.ts`, `packages/audio-renderer/test/downbeat-align.test.ts`.

Steps

1. `fitTempoGrid` returns `{ bpm, offsetMs }` (it already computes `bestOffset`). Thread `offsetMs` through `estimateTempo`.
2. After DP backtracking in `trackBeats`, refine each frame by parabolic interpolation on `onset[t-1], onset[t], onset[t+1]` (reuse the `interpolateLag` maths; rename to `interpolatePeak`). Then snap each beat to the nearest comb position `offsetMs + k·periodMs` **only** if within 0.15·period; otherwise keep the interpolated onset time. Remove the now-unused `interpolateLag`/`refineBpm` leftovers if any remain.
3. `downbeatAlignmentOffsetMs` takes `outgoingRate` and `incomingRate`; convert both phases to output time (`phase / rate`) before `wrapDelta`, and use the *output* period `60_000 / targetBpm`. Return the offset in **incoming source ms** (`× incomingRate`) since that is what the coordinator adds to `sourceStartMs`.
4. In `render/coordinator.ts`, pass the entry rates and use `targetBpm` from `transitionToNext.parameters` (WP1) falling back to `analysisBpm`. Run alignment **after** rates are final.
5. Manifest: keep `downbeatOffsetMs`; add `alignmentPeriodMs` so a listener can judge the correction size.

Tests

- Click track 174 BPM, offset 100 ms, 22 050 Hz: median `|beat − expected|` < 3 ms (was ~12 ms).
- Synthetic DnB fixture: first downbeat within 10 ms of 0 or one beat.
- `downbeat-align.test.ts`: rates 1.02 / 0.99 case; offset magnitude ≤ half output period; sign matches a hand-computed example.

Acceptance: fixture tolerances above; full suite green; a `create_transition_preview` bass swap on Witchcraft → Tidal Wave has no audible low-end phasing at the swap bar (manual ear check, log in `docs/manual-test-log.md`).

---

## 5. WP3 — Key estimation v2

**Problem:** `estimateKey` sums linear STFT magnitude 60–2000 Hz over the whole track into one chroma vector. Sub-bass dominates, no tuning correction, no per-frame weighting. Result: `F` / `Dm` cluster.

**Files:** `dsp-analyzer.ts` (`estimateKey`), new `packages/audio-analysis/src/chroma.ts`, `packages/audio-analysis/src/synthetic-dnb.ts` (new fixtures), `packages/audio-analysis/test/dsp-analyzer.test.ts`, `docs/analysis.md`.

Design (`chroma.ts`)

1. Band 110–3520 Hz (A2–A7). Below 110 Hz the sub carries the root but at ±1 semitone precision it aliases into neighbours.
2. Per-frame magnitude → `log1p(mag · gain)` compression, then bin→pitch-class with fractional midi (no `Math.round` before tuning).
3. Tuning: histogram of `(midi mod 1)` weighted by magnitude across all frames; take the peak as a global offset in cents; subtract before quantising.
4. Harmonic suppression: for each bin, subtract 0.5× the contribution assigned to its 2nd and 3rd harmonic bins (simple HPCP-style). Keeps roots, dampens fifths.
5. Per-frame chroma normalised to unit L1; frames with low spectral energy (bottom 20 %) are dropped; median across remaining frames (robust to breakdowns).
6. Krumhansl–Kessler correlation as today, but also compute Temperley profiles and average the two rank scores.
7. Confidence = `(best − second) / |best|` **times** a clarity term `1 − entropy(chroma)/log(12)`. Report `keyRunnerUp` as now.
8. Expose `chromaVector: number[12]` in `descriptors` (already a free-form JSON column) so disagreements can be inspected without re-analysing.

Fixtures / tests

- Existing C-major chord → `C` / `8B` (regression).
- New `buildKeyedDnbPcm({ key: "F#m" })`: synthetic-DnB fixture plus a sustained triad pad and an F# sub at 46 Hz → expect `F#m` / `11A`, and **not** `F#` major.
- Same fixture with a 55 Hz A sub (foreign sub) → key must still be `F#m` (proves sub suppression).
- Detuned pad (−30 cents) → still `F#m`.

Real-data check: run `analysis:start` on the 14 gate tracks, compare against Beatport/Tunebat keys the user supplies (add a `keyPublished` column? — no: use `update_track_metadata { musicalKey, keySource: "published" }`, same pattern as BPM). Target ≥ 9/14 exact or relative-major/minor match; record in `docs/progress.md`.

Acceptance: fixtures pass; no more than 3 of 14 gate tracks share one key; `compare_track_analyses` shows the new `chromaVector`.

---

## 6. WP4 — Confidence calibration

**Problem:** lines ~286–289 of `dsp-analyzer.ts` clamp confidence to ≥ 0.55 whenever stability ≥ 0.45. Six gate tracks land at exactly 0.55 vs a 0.5 gate.

**Files:** `dsp-analyzer.ts` (`estimateTempo`), `packages/domain/src/constants.ts` (`MIN_ANALYSIS_CONFIDENCE`), `packages/domain/src/analysis.ts` (`SonicDescriptors` gains `tempoEvidence`), new script `tools/scripts/calibrate-confidence.mts` (gitignored output), tests.

Steps

1. Remove the floor. Return raw components in `descriptors.tempoEvidence = { prominence, stability, tempoConf, onGridRatio }`.
2. Build a labelled set: the 9 published-174 gate tracks + 5 out-of-range tracks + synthetic DnB + click track + a sine + white noise. Label = `|dsp − published| ≤ 0.5` (out-of-range tracks and noise = 0).
3. `calibrate-confidence.mts` runs the analyzer, prints the component table, and fits a 3-feature logistic regression (plain gradient descent, no deps). Bake the resulting weights into `estimateTempo` as named constants with the fit date in a comment. Re-run whenever the onset/tempo path changes.
4. Set `MIN_ANALYSIS_CONFIDENCE` from the fitted curve at the point where false-accept rate on the labelled set is 0. If that lands above 0.5, keep 0.5 as the *floor* and let `allowLowConfidence` remain the override.
5. Update `tempoStability` semantics in `docs/analysis.md`.

Tests

- Synthetic DnB confidence ≥ 0.7; click track ≥ 0.7; pure sine and white noise rejected (already in `click-grid.test.ts` — extend to DSP).
- Gate: no accepted track with `|dsp − published| > 0.5` when published is in range.

Acceptance: no track reports exactly 0.55; §8 numbers do not regress.

---

## 7. WP5 — Sections v2

**Problem:** `labelSections` cuts only at `i % 8 === 0` from t=0, labels everything after the drop `bridge`/`breakdown` by a single 0.7 ratio, never merges, and hard-codes `confidence: 0.55`. `detectDropMs` has a dead branch.

**Files:** `dsp-analyzer.ts` (`labelSections`, `detectDropMs`, bar loop in `analyze`), `packages/audio-analysis/test/dsp-analyzer.test.ts`, `packages/catalog/src/planning/timeline.ts` (`analysisToTimeline` uses the improved intro/outro), `docs/analysis.md`.

Steps

1. Bar grid anchored at `downbeatTimesMs[0]` when the grid is accepted; fall back to t=0 otherwise. Bars before the first downbeat form a `pre` region folded into `intro`.
2. Per-bar features: RMS, sub-bass (< 120 Hz), mid flux density, high-band ratio. Novelty = L1 distance between 4-bar mean feature vectors on either side of the boundary.
3. Candidate boundaries at every 4 bars; prior bonus at 8 and 16. Pick peaks above `mean + 0.6·std` with a minimum section length of 8 bars.
4. Labelling: `intro` first; `drop` = section with highest sub-bass **and** RMS rise vs previous, biased by `detectDropMs`; sections between intro and first drop → `build`; after a drop: sub-bass < 0.6× drop → `breakdown`, RMS rising toward a later drop → `build`, else `bridge`; last section → `outro` only if RMS < 0.7× drop, otherwise `drop` (tracks that end on the drop).
5. Merge adjacent sections with the same type. Allow a second `drop` (DnB usually has two); cues keep the first.
6. Confidence per section = normalised novelty margin at its start boundary (0.3–0.95).
7. Fix `detectDropMs`: return `null` when outside 8–85 % instead of returning `t`.
8. `cuesFromSections`: `breakdown` cue = first breakdown *after* the first drop; `outro_start` only if an outro exists.

Tests

- Synthetic DnB (intro 8 / drop 16 / breakdown 8 / outro 8 bars): section starts within 1 bar of expected; exactly one of each label; confidences monotone with the fixture's energy jumps.
- New fixture with two drops → two `drop` sections, one `drop` cue.
- Track ending on drop → last section `drop`, no `outro` cue.

Acceptance: fixtures pass; on the gate set, average section count drops (Witchcraft currently has 7 consecutive bridges); drop previews for Basic Instinct and Angel land on an audible drop (ear check, log it).

---

## 8. WP6 — Cue provenance in the transition planner

**Problem:** `insertAnalyzedCuesIfAbsent` persists analyzer cues; `pickOutgoingCue`/`pickIncomingCue` in `packages/catalog/src/planning/transition-planner.ts` then treat them as `inferred: false`, and `drop` is in the outgoing fallback chain, so a track can be mixed out at its own drop.

**Files:** `transition-planner.ts`, `packages/catalog/test/planning.test.ts`, `docs/analysis.md`.

Steps

1. `cueByType` returns the cue **and** its `source`. A cue with `source === "analyzed"` sets `inferred: true` and pushes a reason (`"Outgoing outro cue is analyzer-derived (confidence 0.62)"`) instead of counting as authoritative.
2. Outgoing chain: `outro_start (manual) → outro section → last breakdown section → last 8 downbeats → duration − overlap`. Remove `drop` from the outgoing chain.
3. Incoming chain: `intro_start (manual) → intro section → first downbeat → 0`. Keep `drop` only when the caller passes `preferredType: "bass_swap"` **and** `allowDropIn: true` (new optional flag; default false).
4. Proposal `confidence` = min(grid confidences, min cue confidence used).

Tests: analyzed-only cues → proposal feasible with reasons, not blockers; manual `outro_start` → no reason; outgoing never ends before the outgoing track's first drop section ends.

---

## 9. WP7 — Analysis report v2 + gate as a CLI command

**Files:** `packages/catalog/src/service.ts` (`getAnalysisReport`), `packages/domain/src/analysis-contracts.ts` (`analysisReportDataSchema`), `apps/cli/src/main.ts` (`analysis:gate`), `apps/mcp-server/src/create-server.ts` (tool description), `docs/progress.md`, `docs/tool-contracts.md`.

Steps

1. Report splits references: `inRange` (published/manual within `DNB_BPM_MIN..MAX`) vs `outOfRange`. `withinHalf` is computed on `inRange` only. `outOfRange` rows are listed as `needsReview` with the DSP estimate and the folded published value (e.g. published 87 → 174 would be in range; 125 is not).
2. Per-track engine rows include `bpmConfidence`, `gridRejected`, `keyAgreement` (WP3), `sectionCount`.
3. New CLI `analysis:gate [--engine dsp|beat-this] [--previews]` that: re-analyses every track with `bpmSource in (published, manual)`, prints the report, and optionally renders drop previews. This replaces the ad-hoc `output/gate-run.mts` that was deleted.
4. Record the gate output in `docs/progress.md` under a dated heading each time it's run.

Acceptance: `analysis:gate` reproduces §10 baseline numbers before any DSP change and is what every later WP reports against.

---

## 10. WP8 — Sidecar hardening + `beat-this` comparison (optional)

**Files:** `tools/analyzer-py/analyze.py`, `tools/analyzer-py/requirements.txt`, `packages/catalog/src/analysis/python-engine.ts`, `packages/catalog/test/python-engine.test.ts`, `docs/analysis.md`.

Steps

1. `runPythonAnalyzer`: add `timeoutMs` (default 180 s beat-this, 900 s allin1) via the `ProcessRunner` (add `timeoutMs` to its input if missing) → `ANALYSIS_ENGINE_FAILED` retryable on timeout.
2. `analyze.py`: honour `--sample-rate` for `beat-this` by loading via `load_mono` and passing the array (beat-this exposes `Audio2Beats`); derive `bpmConfidence = clamp(1 − IQR(beat periods)/median, 0, 1)` instead of the constant; verify the all-in-one package import (`import allin1; allin1.analyze(...)`) against the installed wheel and fix the module name.
3. Load the model once per process: accept `--input` multiple times and emit one JSON line per file; the Node side can still call per track for now (keep the protocol backwards-compatible).
4. Install: `tools/analyzer-py/setup.ps1` with Python 3.12; set `analysis.engines.python.enabled: true` in the local config.
5. Run `analysis:gate --engine beat-this`; put DSP vs beat-this side by side in `docs/progress.md`. Decide default engine from that table (rule: DSP stays default unless beat-this is ≥ 2 tracks better on `inRange` and adds < 10 s/track).

Acceptance: sidecar timeout test with fake runner; gate table published; `docs/decisions.md` entry with the default-engine decision.

---

## 11. WP9 — Tests to add (tracked across WPs)

| Test | File | WP |
| --- | --- | --- |
| `chooseTransition` rates/targets/fallback | `packages/catalog/test/planning.test.ts` | 1 |
| `analysisToTimeline` intro/outro/canonicalBpm | same | 1 |
| Sub-hop click accuracy < 3 ms | `packages/audio-analysis/test/dsp-analyzer.test.ts` | 2 |
| Alignment with rates ≠ 1 | `packages/audio-renderer/test/downbeat-align.test.ts` | 2 |
| Keyed DnB fixtures (F#m, foreign sub, detuned) | `dsp-analyzer.test.ts` | 3 |
| Sine/noise rejected by DSP, no 0.55 plateau | `dsp-analyzer.test.ts` | 4 |
| Section boundaries / two drops / drop-ending | `dsp-analyzer.test.ts` | 5 |
| Analyzed cues → reasons not blockers | `planning.test.ts` | 6 |
| Report in/out-of-range split | `packages/catalog/test/analysis.test.ts` | 7 |
| Sidecar timeout | `packages/catalog/test/python-engine.test.ts` | 8 |
| MCP: `get_analysis_report` shape, `create_cue_preview` with fake ffmpeg | `apps/mcp-server/test/handlers.test.ts` | 7 |

---

## 12. Gate set and baseline (reproduce before you start)

Track IDs with `bpmSource: "published"`:

```
16449696-7939-4de0-804a-6f3793498ed0  Goldie — Angel                     159
7c9bab38-fe94-4645-8b71-229490e1f334  Goldie — Saint Angel               159
33192aff-c815-4c77-996d-a321e7bc41a6  Maduk — Coming Down                174
ccd0e13b-f068-4f9d-a633-a92eceb531f3  Netsky — Complicated               125
03d85fc8-646a-4994-ae3d-5adfe40dcda3  Netsky — Basic Instinct            174
0db42c21-a296-4960-ba5c-07fc7584d236  Pendulum — Witchcraft              174
557a0c7e-1d4a-43a3-8d3f-c8c48ee8a916  Sub Focus — Turn Up the Bass       174
20c5cc3c-fdc5-4331-b177-120ee38d9fe1  Sub Focus — Last Jungle            174
d2d025cb-3a32-4cb4-ae4d-abb8b5cc2a03  Sub Focus — Falling Down           140
fb863c28-831c-4a2d-9fad-2e2714491eee  Sub Focus — Tidal Wave             174
4e4e0f74-62ae-4bac-b5a7-a49ede15c858  Technimatic — Like a Memory        176
3128c6b1-4145-4634-a63b-4f5c1419b4df  Technimatic — Departure            174
4479e93a-e1f5-4c5c-92f2-5c2f06f3a13f  Technimatic — It Must Be           174
f2de4af5-dae5-402f-ad76-540885eba79c  Sub Focus & Wilkinson — Alone      124
```

Baseline (2026-09-02, DSP only):

- In-range references (10): **6 exact** (Coming Down, Basic Instinct, Witchcraft, Turn Up the Bass, Tidal Wave, Departure); Like a Memory 175 vs 176; It Must Be 175.3 rejected (conf 0.25); Last Jungle 179.5 rejected (0.29); Saint Angel 160 vs 159 rejected (0.18).
- Out-of-range references (4): all miss by construction.
- Confidence: six accepted tracks at exactly 0.55.
- Key: `F`×6, `Dm`×3, `C`×3, `F#m`, `Bb`.
- Runtime ≈ 4.4 s per 5-minute track.

Targets after WP1–WP7: in-range exact ≥ 8/10; no confidence plateau; ≤ 3 tracks sharing a key; drop previews audible on ≥ 8/10; a re-planned hour with aligned pairs renders with tempo-matched rates and passes an ear check.

---

## 13. Verification checklist per WP

```
node ./node_modules/vitest/vitest.mjs run
node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json --pretty false
corepack pnpm exec tsx apps/cli/src/main.ts analysis:gate          # WP7 onward
git status --short                                                 # no .js, no data/output/config
```

Update `docs/progress.md` (evidence + gate numbers), `docs/analysis.md` (behaviour), and `docs/decisions.md` (only for decisions: key algorithm, confidence threshold, default engine).

---

## 14. Risks and how to handle them

- **Over-fitting the DSP to 14 tracks.** Keep synthetic fixtures as the hard tests; treat the gate as a regression signal, not a target to hit at any cost. If a change helps the gate but breaks a fixture, the fixture wins.
- **Tempo matching a chain of tracks drifts the whole set's BPM.** WP1 recomputes each pair's target from effective BPM; cap total deviation per track at 3 % from canonical.
- **Sub-hop refinement snapping to the wrong comb position** in swing/breakbeat passages. The 0.15·period threshold is deliberate; do not widen it without a fixture that fails.
- **Key v2 still biased by sub.** The foreign-sub fixture exists to catch this. If it fails, raise the low cutoff to 165 Hz before adding complexity.
- **Migration 006 on a DB that already got the edited 001.** Any DB created between 2026-09-02 15:59 and WP0 already has the wide CHECK; 006 rebuilds it identically. No data risk; just redundant.
- **Python install friction on Windows** (torch wheels). WP8 is optional; do not let it block WP1–WP7.
