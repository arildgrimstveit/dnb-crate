# Implementation plan: verified mixes per request — 18 October 2026

> **Status: ACTIVE HANDOFF PLAN.** Written against HEAD `ad37ac2` (18 October 2026). Source: the
> local review PDF `output/pdf/dnb-crate-review-and-next-steps.pdf` (gitignored). This plan
> sequences the open parts of the [quality roadmap](quality-roadmap-2026-10-12.md) (Q03–Q12) in the
> review's priority order and adds a Phase 0 of defects found while grounding the plan in code. The
> roadmap's per-item requirements and its "Instructions for the implementation agent" still apply
> wherever this plan is silent. Writing this plan changed no code.

## Goal

The review scored recent engineering 8/10 and direction 8/10, but evidence for the full promise
("give it a folder, get a good mix") only 6/10. The pilot is 3 × 15-minute mixes with 14 joins
(10 pass, 3 review, 1 fail). This plan turns that into measured progress, in the review's order:

1. Measure verified mixes per request on a frozen, repeatable benchmark (Workstream 1).
2. Choose better transitions before rendering (Workstream 2).
3. Repair one failure class automatically (Workstream 3).
4. Make first use simple (Workstream 4, a parallel track).
5. Improve loudness and vocal handling (Workstream 5).

Phase 0 fixes six small defects first, because they would distort the benchmark.

## Baseline at HEAD `ad37ac2` (verified while writing this plan)

- Clean working tree. Last commit: `docs(ledger): Q04 gains flip to always-body per owner decision`.
- `vitest run`: **71 files, 694 tests passed** in 390 s (Windows, local binaries).
- `tsc --noEmit` clean for all six packages and `tools/`.
- ESLint: 0 errors, 4 `max-lines` warnings — `catalog/src/render/coordinator.ts` (2,220 counted
  lines), `audio-analysis/src/dsp-analyzer.ts` (1,708), `catalog/src/service.ts` (1,284) and
  `catalog/src/planning/timeline.ts` (1,167).
- Real-library evidence: [library-baseline-2026-10-12.json](../../tools/reports/library-baseline-2026-10-12.json)
  — 642 tracks, 3 plans, 14 aligned joins, one stored-grid residual over 40 ms (pilot-298,
  diagnosed in [known-failure-diagnostics-2026-10-12.json](../../tools/reports/known-failure-diagnostics-2026-10-12.json)).
- In some agent shells `pnpm` is not on `PATH`. Use `corepack pnpm …` or the binaries in
  `node_modules/.bin/`, as was done for this baseline.

## Ground rules for every task

1. **Roadmap rules (verbatim):** "Do not modify the owner's audio files or reorganize the library,
   use approved joins as a requirement, disable checks to improve the pass count, or tune against
   exposed held-out results. Use isolated catalogs and generated fixtures for development. Keep
   private listening artifacts intentional and locally addressable."
2. **Failing first.** Every defect gets a boundary-level regression that fails on the current code
   before the fix. Say in the commit message that it was seen red.
3. **Determinism.** Same catalog + brief + seed gives the same plan. Ties break with
   `localeCompare`; randomness comes only from the seeded `hashSeed`; no `Date.now()` or
   `Math.random()` in planning paths. Planner-output changes are deliberate, justified per test in
   the commit message, and measured with the benchmark.
4. **One policy change at a time.** Each change that alters plans (P0.2, P0.5, W2.1, W2.2, W2.3,
   W4.5, W5.1) gets its own tuning-split benchmark run, compared against the previous run.
5. **Plan edits** go through `updateSetPlan` (`replaceTrack`, `setTrim`, `setTransition`,
   `applyTransition`, and the new `setGain`), never raw `buildEntries`. `applyTransition` sets
   `incomingSourceEndMs` only on the last entry; trim middle entries with `setTrim`.
6. **Don't grow the four oversized files.** New logic goes in new modules. If a task has to change
   one of them, first extract the touched part in a separate, behavior-neutral commit.
7. **Versions and migrations** follow [architecture.md](../architecture.md) "Where to add things".
   Bump `DSP_ANALYZER_VERSION` when analysis output changes, `JOIN_RESOLUTION_POLICY_VERSION` when
   contract rules change, and `RENDERER_VERSION` when rendered audio or the manifest contract
   changes (it is part of the frozen render identity). Persisted shapes get an additive migration
   registered in `migrate.ts`. MCP changes update the domain schema, the handler, the pinned
   handlers test and `docs/tool-contracts.md`. CLI changes update `usage.ts` and `docs/cli.md`.
8. **Acceptance bar per task:** `pnpm typecheck`, `pnpm lint` (no new warnings),
   `pnpm lint:exports`, `pnpm format:check` and the full `pnpm test`. After adding test files, also
   run `tsc --noEmit -p <package>/tsconfig.json`: vitest does not typecheck, and the Windows smoke
   lane will catch it otherwise.
9. **Delivery.** One commit per task, with the task id in the subject (for example
   `fix(planner): contract gain matches entry gain (P0.1)`). After each tranche, append a section
   to [implementation-ledger-2026-10.md](implementation-ledger-2026-10.md) in its existing table
   format (item | status | commit) with the final SHA, policy/schema/version changes, exact
   verification results, benchmark evidence and remaining acceptance work. Mark an item Delivered
   only as far as the evidence goes.

## Order of work

| Step       | Tasks           | Needs            | Why here                                                                                |
| ---------- | --------------- | ---------------- | --------------------------------------------------------------------------------------- |
| 1          | P0.1–P0.6       | —                | Small fixes to gains and check inputs the benchmark measures. W1.1 can run in parallel. |
| 2          | W1.1–W1.7       | P0               | Benchmark harness.                                                                      |
| 3          | W1.8            | W1.1–W1.7        | Freeze the baseline and the holdout before any tuning.                                  |
| 4          | W2.0, W2.1      | W1.8             | One residual implementation; pre-render residual gate.                                  |
| 5          | W5.1            | P0.3, P0.4, W1.8 | Exact-window loudness; the join search needs it for gain feasibility.                   |
| 6          | W2.2            | W1.8             | Local timing evidence (DSP bump, re-analysis).                                          |
| 7          | W2.3–W2.5       | W2.1, W2.2, W5.1 | Bounded join search.                                                                    |
| 8          | W3.1–W3.5       | P0.2, W2.1, W2.3 | Automatic repair, one failure class.                                                    |
| Parallel   | W4.1–W4.4, W4.6 | P0.6             | First use; independent of the planner work.                                             |
| After W1.8 | W4.5            | W1.8             | Duration tolerance changes plans; measure it on its own.                                |
| Last       | W4.7, W5.2–W5.4 | See each task    | Measurements, reporting, optional solver and vocal research.                            |

## Phase 0 — correctness fixes found while grounding this plan

### P0.1 Contract gain equals entry gain (Q03/Q04) — S

**Why.** Since `d5f63a6`/`dee3ff8`, entry gains use body loudness first (`gainInputLufs` in
[timeline.ts](../../packages/catalog/src/planning/timeline.ts) ≈L779 and the entry build ≈L1127).
The resolved-join contract built for `resolveJoinInputs` (≈L1080–1089, stored as
`parameters.resolvedJoin`) still derives `gain.gainDb` from `integratedLufs`. Contract and entry
disagree whenever body and integrated loudness differ, and no test compares them.

**Change.** One helper (for example `entryGain(track, referenceLufs, prior)` returning
`{ gainDb, source, input: "body" | "integrated" | null, warnings }`) computes each entry's gain
once; the entry and the contract both take that value.

**Tests first** ([planning.test.ts](../../packages/catalog/test/planning.test.ts), next to the gain
test ≈L694 and the contract test ≈L735):

- Three `gridTrack` fixtures with body ≠ integrated: for every join,
  `parameters.resolvedJoin.gain.gainDb` equals the outgoing entry's `gainDb`.
- The same on a rebuilt plan with a pinned prior.

**Acceptance.** Equality holds across all planning fixtures. The W1 runner later asserts it as an
invariant (exit 3 on violation).

### P0.2 Gain provenance, `setGain` and replacement gains (Q04/Q11) — S–M

**Why.**

- `buildEntries` keeps any prior numeric `gainDb` as if it were pinned, so every edit or rebuild
  freezes all gains and never re-derives them against the new set reference.
- `replaceTrack` copies the replaced track's `gainDb` onto the new track
  ([plan-editor.ts](../../packages/catalog/src/service/plan-editor.ts) L158). A quiet replacement
  inherits a hot track's cut — exactly the edit automatic repair will make. No test covers it.
- There is no way to pin a gain on purpose, so the contract's `gain.source: "pinned"` carries no
  meaning.

**Change.** Mirror rate provenance (`rateSource`, migration 024):

- Domain: `SetPlanEntry.gainSource?: "pinned"` in `planning.ts` and `contracts/planning.ts`.
- Migration `029_entry_gain_source.ts`: nullable `gain_source TEXT` on `set_plan_entries`, copying
  024's idempotent column check. Read and write it next to `rate_source` in
  [set-plan-repository.ts](../../packages/catalog/src/set-plan-repository.ts) (L155, L168, L310).
- `buildEntries` keeps a gain only when `prior.gainSource === "pinned"`; everything else
  re-derives. `replaceTrack` drops the gain.
- New `updateSetPlan.setGain { entryId, gainDb }`, bounded by `LEVEL_MATCH_GAIN_MIN_DB` and
  `LEVEL_MATCH_GAIN_MAX_DB`, sets `gainSource: "pinned"`. Expose it through the MCP
  `update_set_plan` schema.
- The contract's `gain.source` follows `gainSource`.
- Legacy rows (`gain_source` NULL) count as derived, so they re-derive on their next edit.
  Unedited stored plans render with their stored gains, unchanged. Record this in the ledger.

**Tests first.**

- Replace a hot track (−8 LUFS) with a quiet one (−14 LUFS): the new entry's gain is derived for
  the new track, not copied.
- A `setGain` pin survives a later `replaceTrack` elsewhere in the plan, while the other derived
  gains re-derive against the new median.
- Migration test: the column is added and a legacy NULL row reads as derived.

**Acceptance.** Tests above are green; the handlers test and tool contracts cover `setGain`.

### P0.3 Render-check level inputs follow the gain policy (Q04) — S

**Why.** The manifest records `outgoingLufs`/`incomingLufs` from `integratedLufs`
([coordinator.ts](../../packages/catalog/src/render/coordinator.ts) ≈L2369–2372). The hard 5 LU
gate then computes `plannedLevelStepLu` from integrated loudness plus body-derived gains — two
different inputs. Frozen render evidence has `integratedLufs` but no body value
([evidence.ts](../../packages/catalog/src/evidence.ts) L284).

**Change.**

- Freeze the loudness summary (body median plus its content hash) in the queued request's evidence
  snapshot.
- Export the gain-input rule (body first, integrated fallback) from one place and use it in both
  planner and checker.
- Manifest join rows gain `outgoingLevelLufs`, `incomingLevelLufs` and `levelInput`; keep the
  integrated fields for reference. The 5 LU gate uses the level fields; the measured `levelStepLu`
  stays report-only. Old manifests fall back to integrated with `levelInput: "integrated-legacy"`.
- First extract the manifest join-row builder out of `coordinator.ts` (ground rule 6). Bump
  `RENDERER_VERSION`; preview identities roll once, as expected.

**Tests first** ([render.test.ts](../../packages/catalog/test/render.test.ts)): a pair whose
integrated-based planned step exceeds 5 LU while its body-based step is within it passes; the
reverse fails; legacy manifests use the fallback.

### P0.4 Loudness freshness and a cheap summary read (Q02/Q04) — S

**Why.** `getLoudness` ([analysis-repository.ts](../../packages/catalog/src/analysis-repository.ts)
L245) ignores `content_hash`, so after a file changes, `toTimeline`
([service.ts](../../packages/catalog/src/service.ts) ≈L1215) keeps using the old median until
re-analysis. It also JSON-parses two ~3,000-frame series per track on every plan to read one
number.

**Change.**

- `getLoudnessSummary(trackId)` reads scalar columns only; `toTimeline` uses it.
- Accept a loudness row only when its `content_hash` matches the DSP stage hash
  (`getStage(trackId, "dsp")`, migration 026). Legacy weak stages are accepted with a weak flag;
  otherwise return null so the gain falls back to integrated loudness.
- Full series stay lazy (`getLoudness`) and are cached per planning run for W5.1.

**Tests first.** A changed stage hash makes the summary ignored and the gain fall back to
integrated; a spy shows plan creation no longer calls `getLoudness` for summaries.

### P0.5 One boost ceiling for gain derivation (Q04) — S

**Why.** `levelMatchGainDb` caps boosts at `0 − truePeakDb`, while `solveSetGains` uses
`BOOST_PEAK_CEILING_DB = −0.1` ([loudness.ts](../../packages/domain/src/loudness.ts)): two rules
for one constraint.

**Change.** One constant in [constants.ts](../../packages/domain/src/constants.ts), default
−0.1 dBFS (decision D7), used by both. Expected effect: at most 0.1 dB on boosted tracks whose
peaks sit near 0 dBFS. Update affected oracles.

### P0.6 Rubber Band discovery and contradictory setup docs (Q09) — S

**Why.**

- `resolveRubberbandCli` ([rubberband-cli.ts](../../packages/audio-renderer/src/rubberband-cli.ts))
  checks the explicit path, `DNB_CRATE_RUBBERBAND_PATH` and the gitignored Windows download under
  `tools/rubberband-cli/`, but never `PATH`. Linux and macOS users with a package-manager Rubber
  Band must set an environment variable.
- The docs disagree: [README](../../README.md) L14 says Rubber Band is "bundled with the repo" and
  L74 calls it "Optional"; [first-mix.md](../first-mix.md) L79 says no binaries ship; the
  preflight message says "Restore the bundled tools/rubberband-cli".
- Other stale statements: [rendering.md](../rendering.md) L17 gives the integrated-only gain
  formula; the "Q04 body-gain A/B verdict" in [beatmatching-followups.md](../beatmatching-followups.md)
  says "do NOT flip the default gain policy", which `dee3ff8` superseded; the `get_mix_preflight`
  description says stretching requirements are checked against the plan (R3 is now also checked
  early); and README L55's 5-minute readiness window versus the planner's 90 s aim is unexplained.

**Change.**

- Look up `rubberband` and `rubberband-r3` (`.exe` on Windows) on `PATH`. Order: explicit, env,
  bundled, `PATH`. `audio-renderer` cannot import `catalog/src/which.ts`, so move that helper down
  to `audio-renderer` and re-export it from catalog, or add a minimal lookup.
- Platform-specific `nextAction` text for `RUBBERBAND_REQUIRED` (apt, brew, Windows download, or
  the environment variable).
- Correct every statement listed above so the docs agree.

**Tests first.** A fake executable on a temporary `PATH` is found; the precedence order holds; the
`nextAction` text matches each platform.

## Workstream 1 — Benchmark first (Q07)

The review's success measures: broken output fails CI; a frozen context reproduces the complete
plan, including windows and gains; at least 100 tuning and 100 held-out joins where supply permits.
Everything is counted against attempts, including failed attempts and unmeasured joins.

### W1.1 CI-ready synthetic corpora — S

**Why.** [audio-regression-corpus.mts](../../tools/scripts/audio-regression-corpus.mts) and
[processed-deck-corpus.mts](../../tools/scripts/processed-deck-corpus.mts) already exit with gate
codes (0 clean, 2 infrastructure, 3 unexpected escape or false alarm, 4 numeric, 5 calibration).
But they build config as `{ ...loadConfig(), … }`, which throws without a config file, and neither
runs in CI.

**Change.**

- `tools/scripts/lib/isolated-config.mts` builds an `AppConfig` through `appConfigSchema.parse`
  from explicit fields plus the binary environment overlays (`DNB_CRATE_FFMPEG_PATH`,
  `DNB_CRATE_FFPROBE_PATH`, `DNB_CRATE_RUBBERBAND_PATH`, `DNB_CRATE_KEYFINDER_PATH`). It never
  reads `dnb-crate.config.json`. Both corpora use it, and later the benchmark too.
- New `audio-corpus` job in [ci.yml](../../.github/workflows/ci.yml): Ubuntu, the main job's apt
  dependencies, runs both corpora, uploads their reports as artifacts and fails on any non-zero
  exit. Measure its runtime first; if it exceeds 15 minutes, run a declared subset on pull requests
  and the full set on pushes to main (decision D5).

**Acceptance.** In a scratch branch that is not committed, shift the renderer's incoming placement
by 60 ms and corrupt one processed deck: the job fails with exit 3 or 4. Record the CI run links in
the ledger.

### W1.2 Versioned report schema and unique run ids — S

- `tools/scripts/benchmark/report.mts`: a zod schema with `schemaVersion: 1`, validated on write.
- Fields: `runId` (`<compact ISO time>-<short SHA>-<suite>`); git SHA and dirty flag; version
  identities (`APP_VERSION`, `DSP_ANALYZER_VERSION`, `AUDIO_ENGINE_ID`, `RENDERER_VERSION`,
  `JOIN_RESOLUTION_POLICY_VERSION`); binary identities (FFmpeg version, Rubber Band hash); catalog
  identity (snapshot SHA-256, track count, hash of the analysis-identity set); split; per-request
  records; totals.
- Reports go to `tools/reports/benchmark/<suite>/<runId>.json` and are never overwritten. Today's
  date-only file names overwrite same-day runs.
- Reports may contain track titles (existing practice) but never absolute paths or audio.
- `tools/scripts/benchmark/compare.mts <runA> <runB>` prints the headline deltas.

### W1.3 Request matrix, pool sizes and difficult folders — M

- `tools/benchmark/matrix.v1.json` (committed) with these axes:
  - mood: none, `liquid`, `peak-time`, `dark`, `rolling` (from `mood-presets.ts`), sent as
    `preferredMoods`;
  - energy arc: steady, build, and the two example briefs' arcs, sent as `requestedArc`;
  - duration: 15, 30 and 60 minutes;
  - pool size: 25, 60, 150 tracks, and the full split;
  - difficulty pools: mostly single late drops, low tempo stability, mixed 170/174/176 BPM,
    duplicate edits, and loudness outliers with quiet intros.
- Not a full cross product: about 24 cells × 2 seeds per split. Seeds are disjoint between splits
  (tuning from 101, holdout from 9001). Size the matrix so each split yields at least 100 aligned
  joins.
- Pools on the real library: `excludedTrackIds` is capped at 200
  ([contracts/planning.ts](../../packages/domain/src/contracts/planning.ts) L222), so it cannot
  express pools. Instead, inside each scratch copy, set `rating = 1` on out-of-pool tracks and use
  `minRating: 2` in every benchmark brief. That is the owner's standard brief setting, and the
  planning pool already excludes tracks rated 1. Assert that the scratch database path differs from
  the configured one before any write.
- Synthetic difficult folders: `tools/scripts/benchmark/synthetic-crates.mts` builds variants with
  `buildKeyedDnbPcm` and `buildDnbFixtureWav`: late drops, 170 and 176 BPM, duplicate edits,
  quiet-intro masters, a 3-track folder, and paths with spaces and non-ASCII characters.

### W1.4 Freeze the holdout before any tuning — S

- `tools/scripts/benchmark/freeze-holdout.mts` groups tracks by recording family (the planner's
  duplicate-recording family rule) and canonical artist key (`artistKey` from
  `planning/shared.ts`, not title splitting). About 30% of artists, with all their families, go to
  the holdout by seeded hash (decision D3). A track with any holdout artist is a holdout track, so
  holdout artists never appear in tuning runs.
- It writes `data/benchmark/holdout-v1.json` (gitignored, library-specific) with the seed,
  fraction, creation SHA, counts, and each track's content hash and family key, which stay stable
  across rescans.
- A new `docs/benchmark.md` records the rules and the manifest's creation date and hash, not its
  contents.
- The runner refuses `--split holdout` without `--milestone <name>` and logs every exposure to
  `data/benchmark/holdout-log.json`. Holdout numbers are reported, never used to choose constants.

### W1.5 Benchmark runner — M–L

`tools/scripts/benchmark.mts` has two modes and writes one report schema.

- `--mode warm --split tuning|holdout`:
  - Take a SQLite `backup()` of the owner's catalog into scratch, cancel copied jobs and clear
    transition feedback and recipes, as the current baseline script does.
  - Restrict the pool as described in W1.3.
  - Run the full `MixWorkflowCoordinator` path (start, then wait) with request token
    `<runId>:<cell>:<seed>`, so the W3 repair loop is exercised. Library roots stay the owner's,
    read-only.
- `--mode cold --crate <class> | --folder <dir>`: an empty isolated catalog and a full
  folder-to-mix run, from preflight to check. Records the time to the first verified mix and the
  number of user commands.
- Per request, record:
  - workflow status and issues, the plan fingerprint (W1.6) and the quality report;
  - the render check, run with `--audio fast`;
  - per join from the manifest: type, bar count, stored-grid residual, predicted residual (once
    W2.1 lands), planned and measured level step, continuity, fallback reason, probe verdict and
    reason;
  - stage timings, peak scratch bytes and output bytes. Renders are deleted after measurement
    unless `--keep-audio` is passed.
- Totals, with requests attempted as the denominator:
  - `verifiedMixRate`: workflow `succeeded` with `result.verified`.
  - Outcomes: verified, check-failed (which gate), plan-blocked (which code), render-failed,
    infrastructure.
  - `interventionJoins`: joins that hard-fail the check, are unexplained under strict quality, or
    are rated bad in listening. Probe `review` verdicts and unmeasured joins (with reasons) are
    counted separately; this replaces the mislabeled `manualIntervention.probeFlagged`.
  - Track, pair and artist repeats within a split (canonical artist ids); coverage (distinct tracks
    used divided by pool size); duration error (planned against requested, rendered against
    planned); runtimes; disk.
  - Invariants: contract gain equals entry gain; every unmeasured join has a reason; fingerprints
    reproduce.
- Exit codes: 0 clean; 2 infrastructure; 3 invariant or determinism break; 4 numeric regression
  against `--baseline <runId>` (tuning split only, with tolerances declared in the matrix file).
- Retire `library-corpus-baseline.mts` once the runner reproduces its numbers, or keep it as a thin
  alias.

### W1.6 Full-plan fingerprint — S

- New `packages/catalog/src/planning/plan-fingerprint.ts`:
  - `normalizePlanForComparison(plan)` drops ids, timestamps and the name. It keeps order, track
    ids, source windows, rates and rate sources, gains and gain sources, transition type,
    duration and cue ids, and parameters with sorted keys (including `resolvedJoin`).
  - `planFingerprint(plan)` is the SHA-256 of that canonical JSON.
  - Export both from the catalog index.
- The determinism test (planning.test.ts ≈L274) and the replay tests (≈L3029–3107) compare only
  track-id sequences today. Make them compare fingerprints. A failure here is a real determinism
  bug; fix it before continuing.

### W1.7 Listening evidence as its own record — S

- `tools/scripts/benchmark/listening-sheet.mts` lists a run's joins with listen-copy timestamps.
  For A/B comparisons, it loudness-matches both variants, reusing the matching in
  [listen-ab.mts](../../tools/scripts/listen-ab.mts).
- Verdicts are recorded through the existing `feedback:rate` and hour-feedback commands, with the
  run id in the notes; the report links them by plan and render id. Pending verdicts are reported
  as pending, never as passes.

### W1.8 Freeze the baseline — S

- After Phase 0, run the warm tuning split at that HEAD, commit the report, summarize it in
  `docs/benchmark.md`, and run the holdout once as milestone `baseline`.
- **Acceptance:** CI fails on broken output (W1.1); fingerprints reproduce (W1.6); at least 100
  tuning and 100 holdout joins are measured, or the supply limit is stated with actual counts.

## Workstream 2 — Better transitions before rendering (Q03, Q05, Q08, Q10)

Constraints from the review: requirements reject and preferences rank; seeded variety only among
near-best candidates; the whole neighborhood is revalidated; no second planner; bounded runtime.
The roadmap adds: don't improve quality by rejecting music, so report coverage next to quality.

### W2.0 Preparation: layering and one residual implementation — S

- Move `planAlignmentOffsetMs` and `wrapDelta` from `audio-renderer` into domain, so
  `planning/windows.ts` stops importing from the renderer (the roadmap's documented layer
  exception).
- Move the pure residual math (`storedGridResidualMs` and the core of `storedGridFromEvidence`,
  [check-metrics.ts](../../packages/catalog/src/render/check-metrics.ts) L44 and L187) into a pure
  domain module used by both the checker and the planner.
- `recordingOf` in `planner.ts` uses a map instead of `catalog.find` (O(n) per call).
- **Acceptance:** no behavior change; planning oracles and render tests untouched.

### W2.1 Pre-render predicted residual gate — M

- At plan time, compute `predictedResidualMs` for each aligned join with the shared function, from:
  the analysis beats and downbeats (what render freezes), the placed overlap starts (`mixOutMs`,
  `mixInMs`, with the alignment offset already baked in), the rates and `onsetLockBeats`. Stamp
  `predictedResidualMs` and `predictedResidualSource` on the transition parameters.
- Quality report: `predictedResidualMs` per join, and a strict issue `JOIN_PREDICTED_RESIDUAL` when
  it exceeds `RENDER_CHECK_RESIDUAL_FAIL_MS` (40) with usable evidence.
- Selection gate: failure code `PREDICTED_RESIDUAL` in `makeSelectionQualityCheck`
  ([selection.ts](../../packages/catalog/src/planning/selection.ts)), so the chain is rejected
  before the track is chosen, as `ENERGY_CONTINUITY` already is.
- The render check reports predicted next to measured residual, and adds an advisory
  `predictor-disagreement` note when they differ by more than 5 ms. The checker stays the
  authority.
- Before relying on the gate, measure agreement on a tuning run and find a cause for every
  disagreement over 5 ms (for example render-time placement fallback or rate-region rounding).
- **Tests first:**
  - End to end on a synthetic fixture: the prediction equals the checker's residual within 1 ms.
  - A join engineered to predict 60 ms is rejected by selection, and the planner picks another
    track.
  - Strict quality blocks a hand-edited plan whose join predicts more than 40 ms.

### W2.2 Local timing confidence (resolves the pilot-298 class) — M–L, DSP bump

**Why.** `gridPhaseDiagnostics` ([dsp-analyzer.ts](../../packages/audio-analysis/src/dsp-analyzer.ts)
≈L1762–1870) scans at most six 30-second windows, with gaps between them, and keeps only the
maximum. Pilot-298 reads 25 ms for the whole track but 108 ms at its join. The roadmap asks for
three distinct states: drums agree, drums disagree, and too little drum evidence to judge.

**Change.**

- **First**, freeze pilot-298's pre-bump evidence (beats, downbeats, join geometry, rates, offsets;
  no audio) into a committed diagnostic fixture, because re-analysis will replace those grids.
- DSP: add a dense scan over the whole track in contiguous 8-bar intervals, on the same kick+snare
  backbone envelope, keeping the existing summary fields. Each interval records its start and end,
  signed offset, score margin, backbone energy and a state, using today's rules:
  - `disagree`: a decisive win (best score above 1.25 × the stored grid's score) at a sub-beat
    offset over 20 ms and up to 110 ms;
  - `agree`: otherwise, given enough backbone energy;
  - `insufficient`: energy or onset count below the floor.
- Store the intervals as `descriptors.gridPhaseIntervals` (about 25 small records per track), add
  them to the domain schema and expose them through `analysisToTimeline`. Bump
  `DSP_ANALYZER_VERSION` from 3.13.0 to 3.14.0. The owner then re-analyzes with
  `pnpm cli analysis:run --scope stale --wait`; record how long it takes.
- Planning: a new `planning/local-timing.ts` with `localTimingConfidence(analysis, startMs, endMs)`
  returning `{ state, coverage, worstOffsetMs }`. Populate the contract's `alignment.confidence`
  and `alignment.coverage`, which are always null today.
- Policy (decision D2): `disagree` in either overlap rejects aligned candidates only once
  calibration shows no new rejections among the 98 owner-accepted joins, or each new rejection has
  been auditioned and explained. Otherwise it ships as a ranking penalty plus a report, with the
  reason recorded. `insufficient` abstains: no rejection, a lower rank, null confidence.

**Tests first.**

- A synthetic track with a 60 ms phase drift only in bars 64–96 reads `disagree` there and `agree`
  elsewhere.
- Pilot-298's frozen fixture reads `disagree` at its join.
- The synthetic corpus cases `shift-140` and `half-beat` classify as expected.
- The analyzer-version pin test is updated.

### W2.3 Bounded candidate join search — L

A new module, `packages/catalog/src/planning/join-candidates.ts` (do not grow `timeline.ts` or
`windows.ts`), decides how a given adjacent pair A→B is joined. It never changes which tracks are
selected or their order; that stays in `planner.ts`.

- **Enumerate** bar counts 32, 16 and 8 × outgoing exits (`pickOutgoingExit`, `activeExits`,
  `lateTailExit`, capped per bar count) × incoming entries (the drop-anchored landing plus up to
  two alternative phrase starts with a drummed head) × treatments (`phrase_mix` and `bass_swap`;
  `crossfade` only where the quality policy allows it).
- **Evaluate each candidate at its actual rates and placement:** bake alignment per candidate
  (lazily, ordered by cheap features, under a bake budget); predicted residual (W2.1); local timing
  (W2.2); continuity (valley and coexistence) and the groove gate, recomputed on the candidate's
  real window; incoming head energy; B's native body; gain and headroom feasibility (W5.1).
- **Requirements reject**, with typed, counted reasons: out of bounds, no native body, predicted
  residual over 40 ms, local timing disagreement (per D2), drumless head (below
  `INCOMING_HEAD_ENERGY_FLOOR`), structural groove conflict for `phrase_mix`, energy-death
  continuity, infeasible headroom, strict-policy violation.
- **Preferences rank**, keeping the score breakdown: continuity, landing depth, the owner's 32-bar
  preference, groove compatibility, harmonic relation, residual size, fit to the brief's arc, then
  treatment order `phrase_mix`, `bass_swap`, `crossfade`.
- **Seeded variety** only inside the near-best band (`PLANNER_JOIN_NEAR_BEST_MARGIN`): pick with
  `hashSeed(seed, "<A.id>-><B.id>:join")`, breaking ties with `localeCompare` on candidate keys.
- **Output:** the chosen candidate plus compact diagnostics in the transition parameters
  (`evaluated`, `baked`, `rejectedByReason`, `nearBest`). The resolved-join contract records
  geometry, alignment, gain, treatment and the local-timing evidence fingerprint. Bump
  `JOIN_RESOLUTION_POLICY_VERSION` to 2; version 1 contracts stay readable and renderable.
- **Budget and cache:** per-join caps (`PLANNER_JOIN_MAX_CANDIDATES`, `PLANNER_JOIN_MAX_BAKES`),
  and a memo keyed by the immutable context (track ids, analysis and loudness identities, rates and
  chain target, pins, policy versions) for the life of one planning run. The memo is required,
  because `joinAllowed` and `selectionQualityOk` rebuild the whole prefix with `buildEntries` on
  every probe. Runtime budget: p95 plan time for a 60-minute request on the full tuning catalog at
  most max(2 × baseline, baseline + 10 s); set the final numbers from W1.8.
- **Integration:** `chooseTransition` delegates to the search. Approved recipes and required
  transitions are recalled first and keep precedence; pinned joins are not searched. The current
  structural-conflict recovery (incoming shifts of ±1 and ±2 phrase lengths, rebaked with
  `continuity: undefined`) is replaced by candidates whose evidence is recomputed. When no
  candidate is acceptable, a typed rejection goes to the existing selection gate.

**Tests first.**

1. A pair whose current single pick predicts over 40 ms but has a passing alternative exit: the
   search picks the alternative.
2. A drumless-head candidate is never chosen.
3. The same seed gives the identical choice; different seeds may choose differently, but only
   within the near-best band.
4. The caps hold, as shown in the diagnostics.
5. A pinned recipe join is unchanged.
6. A shifted window (formerly "recovered") carries recomputed continuity evidence.

**Acceptance.** Planner oracle changes are justified per test, and [scoring.md](../scoring.md) and
[mixing.md](../mixing.md) describe the search. On the tuning split, `interventionJoins` falls,
`verifiedMixRate` does not drop, coverage drops by at most 5 percentage points, and runtime stays
within budget. Run the holdout once at the workstream milestone.

### W2.4 Neighborhood revalidation — M

- When the chosen A→B candidate moves B's entry, re-evaluate B→C from the new start, B's native
  body (the body must be longer than the incoming and outgoing join regions combined) and the total
  duration. If B→C becomes infeasible, try the next A→B candidate, within the budget, before
  rejecting the pair.
- Evidence (continuity, groove, predicted residual) is always recomputed after a shift, never
  carried over.
- **Tests first:** a fixture where the best A→B entry leaves B too short for B→C falls back to the
  next candidate, and the total duration stays within tolerance.

### W2.5 Re-run the known failures — S

- Re-run both corpora and the pilot plans. Pilot-298 must no longer produce a failing join: it is
  either rejected before rendering or replaced by a different window. Change `KNOWN_FAILURES` only
  when outcomes change, and record the results in the calibration dataset of
  [beatmatching-followups.md](../beatmatching-followups.md).

## Workstream 3 — Automatic repair, one failure class (Q12)

The first class is **a stored-grid residual over 40 ms on an aligned join.** It is the only hard
failure in the pilot, it is attributable to one join, and W2.1 predicts it cheaply. The review's
remedy order: window or overlap length, then treatment, then bounded gain, then a different track.

### W3.1 Repair policy and budget — S

- Domain `repair-policy.ts` maps a diagnosis to ordered remedies. For `STORED_GRID_RESIDUAL`:
  1. the next W2.3 candidate for the same pair, excluding everything already tried, that predicts a
     pass;
  2. a treatment change between `phrase_mix` and 16-bar `bass_swap` on the best surviving window;
  3. (gain does not apply to this class);
  4. replacing the incoming track, or the outgoing one if the incoming is pinned.
- Constants `REPAIR_MAX_ALTERNATIVES_PER_JOIN = 3` and `REPAIR_MAX_FULL_RENDERS = 2` (the review's
  example; decision D4).
- Never alter user pins: required tracks and transitions, applied recipes, rate and gain pins,
  start and end tracks. A failing pinned join stops with `REPAIR_BLOCKED_BY_PIN` and a `nextAction`
  for the owner.
- Never retry an unchanged context; the tried set is keyed by each candidate's context.

### W3.2 Join-scoped re-resolution — M

- New `packages/catalog/src/planning/join-repair.ts`. Input: the plan, the failing join order(s),
  their measured residuals and the tried set. Output: an `UpdateSetPlanInput` sequence
  (`applyTransition`, plus `setTrim` for middle entries), a `replaceTrack`, or `exhausted`.
- Edits apply to a clone (`cloneSetPlanInto`, with lineage `repairedFromPlanId` in the
  explanation); the original plan stays untouched.
- Repair every failing join of this class in one attempt, then render once.
- After applying: full strict validation, both neighbors, duration tolerance, artist spacing, and
  predicted residual for every join.
- While here (Q11): `repairSetPlan`'s treatment-equality check must include gain and automation.
- **Tests first:**
  - A residual-failing fixture gets the next candidate and validates.
  - A pinned join is blocked.
  - After three alternatives the track is replaced, respecting artist spacing and recording
    families.
  - The replacement entry's gain is derived (needs P0.2).

### W3.3 Workflow integration with idempotent attempts — M

- In the `MixWorkflowCoordinator` check stage: when the output is not verified, every failure is of
  a repairable class, and budget remains, run W3.2 and validate. Then reserve the next render job id
  before enqueueing (as the validate stage does), append it to `renderJobIds`, and return to the
  render stage.
- Record `repairs[]` in the workflow data, one row per attempt: attempt number, diagnosis, join
  orders, remedy, source and repaired plan ids, render job id, predicted and measured residuals,
  and outcome. Key attempts by source plan, join and attempt number, so a resume after a crash
  never duplicates a render.
- Contracts: make `repairs` optional in `mixWorkflowDataSchema`. The repository casts stored JSON
  without validating it ([mix-workflow-repository.ts](../../packages/catalog/src/mix-workflow-repository.ts)
  L68, L108, L126), so old rows lack the field and code defaults it to `[]`. Update the MCP output
  schemas and `docs/tool-contracts.md`.
- When the budget runs out, the workflow fails with `REPAIR_EXHAUSTED`, listing the attempts. A
  failed check is never relabeled as verified.
- Candidate evaluations are reused across attempts through the W2.3 memo.
- Add `autoRepair: false` as an option on the workflow request; repair is on by default for
  workflows (D4).
- **Tests first** (fake runner):
  - The first render fails the residual check on join 2 and the repaired plan passes: the workflow
    succeeds with two render jobs and `repairs[0].outcome = "verified"`.
  - Exhaustion fails with `REPAIR_EXHAUSTED` and lists every attempt.
  - Cancelling during a repair render cancels the owned child job.
  - Resuming mid-repair does not duplicate a render.

### W3.4 Final mix report — S–M

- Optional `result.report` containing: listen and master root-relative paths; the tracklist with
  output timestamps from the manifest; the checks performed (hard gates, plus probe coverage with
  pass, review and unmeasured counts and reasons); limitations (for example "3 joins not measured
  by the source-deck probe" or "loudness fell back to integrated for 1 track"); and a repair
  summary. Never claim a check that did not run.
- `mix:create --wait` prints a human summary to stderr (listen path, tracklist, limitations) while
  stdout stays JSON. On failure, both include the workflow id and the exact resume command.
- **Tests:** the report is consistent with the manifest; a snapshot covers the human summary.

### W3.5 Measure — S

- Run the tuning split with automatic repair on and off, and report the `verifiedMixRate` gain,
  extra renders per request and runtime. Run the holdout once at the milestone. Choose the next
  failure class from this data (candidates: level step, energy continuity before rendering,
  interior silence, plan-stage strict blocks).

## Workstream 4 — First use (Q09), in parallel with Workstreams 1 and 2

### W4.1 `config:init` — S

- A CLI command handled before `loadConfig()` in [main.ts](../../apps/cli/src/main.ts). Flags:
  `--library <dir>` (repeatable, required), `--output <dir>` (default `./output`),
  `--database <path>` (default `./data/dnb-crate.sqlite`) and `--force`.
- It resolves absolute paths, validates them with `appConfigSchema` and checks that library and
  output are separate. It refuses to overwrite an existing config without `--force`, writes binary
  paths only when given, creates the data and output folders, writes `dnb-crate.config.json` (or
  the `DNB_CRATE_CONFIG` target), runs preflight, and prints the exact next command.
- **Tests:** a temporary folder with spaces and non-ASCII names; refusal without `--force` and
  overwrite with it; an actionable error for a missing library folder.

### W4.2 Preflight completeness — S–M

- New issues in [preflight.ts](../../packages/catalog/src/preflight.ts), each with a precise
  `nextAction` (the field already exists on `mixIssueSchema`):
  - `DATABASE_UNWRITABLE`;
  - `OUTPUT_LOW_DISK`: free space from `fs.statfs` below an estimate for the requested duration
    (master, listen copy and float pairwise intermediates);
  - `NODE_VERSION_UNSUPPORTED` (below 24);
  - platform-specific install hints for FFmpeg, Rubber Band and KeyFinder.
- Update the `get_mix_preflight` tool description.
- **Tests:** each issue through fakes, with `statfs` mocked.

### W4.3 One setup path for Windows and POSIX — S

- `tools/scripts/setup-check.mts` (root script `setup:check`) runs without a config. It checks the
  Node and pnpm versions, FFmpeg and ffprobe encoders and filters, Rubber Band R3 and the optional
  KeyFinder, and prints the next action per platform.
- Rewrite the README and first-mix install sections around one sequence: clone, install,
  `config:init`, `setup:check`, `mix:create`, with PowerShell and POSIX examples.
- The Windows smoke lane runs `config:init` and `setup:check`.

### W4.4 `mix:create` flags, progress and summary — S

- Add `--mood <preset>` (validated against the presets in `mood-presets.ts`, sent as
  `preferredMoods`) and `--energy <steady|build|peak|wave>` (named arc presets in domain, sent as
  `requestedArc`) next to `--duration-min`.
- `--wait` prints one stderr line per stage with counts, then the W3.4 summary.
- **Tests:** a CLI integration test in the style of
  [first-mix.integration.test.ts](../../apps/cli/test/first-mix.integration.test.ts) asserting the
  brief built from the flags.

### W4.5 Duration tolerance scaled to the request — S, changes plans

- Replace the fixed `DURATION_TOLERANCE_MS` (90 s) with
  `durationToleranceMs(target) = clamp(round(target × 0.025), 30 s, 90 s)`: 30 s for 15 minutes,
  45 s for 30 minutes, 90 s for an hour.
- Replace the fixed `DURATION_QUALITY_WINDOW_MS` (5 minutes) with
  `durationQualityWindowMs(target) = clamp(round(target / 12), 60 s, 300 s)`: 75 s for 15 minutes,
  and 300 s for an hour, so hour mixes are unchanged (decision D1).
- Update the planner's fill and trim, the quality report, `assertPlanReadyForRender`, the "Quality"
  section of mixing.md and the README's readiness statement.
- **Tests:** a table test for both functions; fixtures keep 15-minute plans within 30 s; the
  quality window fails a 15-minute plan that is two minutes off; oracle updates are justified.
  Measure this change in its own benchmark run.

### W4.6 Generated demo crate — M

- A `demo:create` CLI command generates 8 synthetic 174 BPM tracks (`buildKeyedDnbPcm`, compatible
  keys, drops 30–60 s in, 2.5–3 minutes each) into `<outputRoot>/demo/crate`. It uses a separate
  catalog at `<outputRoot>/demo/demo.sqlite`, never the user's database.
- After scanning and analysis, it records the generator-known keys as manual metadata. Tagged keys
  resolve to confidence 0 (`resolveCanonicalKeyConfidence`), so strict planning would refuse them;
  manual keys are honest here because the generator knows them, and KeyFinder stays optional.
- It runs a 10-minute strict workflow and prints the listen path, the summary and the time to the
  first mix.
- **Tests:** an integration test on Linux CI (and the Windows lane if runtime allows) asserts a
  verified result and no writes outside `<outputRoot>/demo`.

### W4.7 First-use measurements — S

- W1 cold mode records the time to the first verified mix and the number of commands for the demo,
  a 10-track synthetic folder and a path with spaces and non-ASCII characters.
- Resume test: interrupt during analysis, resume, and confirm that finished analysis and renders
  are not redone.

## Workstream 5 — Loudness and vocals (Q04, Q06)

### W5.1 Exact-window loudness — M

- Use `windowShortTermLoudness(series, { startMs, endMs })` on each entry's actual native body
  (between its join regions) and on each join's overlap regions (outgoing tail, incoming head).
- Gains derive from the body-window value. The policy is unchanged (body first), with the fallback
  chain window, then series median, then integrated; step down when window coverage is below 0.5.
- Recompute whenever windows move: in every `buildEntries` pass, every W2.3 candidate and every W3
  repair.
- Record the level input in the contract (window bounds, series identity, coverage), and have the
  render check read that same value, replacing the interim rule from P0.3.
- Series load lazily and are cached per planning run (P0.4).
- **Tests:** a synthetic series with a quiet intro and outro gives a window gain different from the
  series median; moving a window changes the gain; the coverage fallback works.
- **Measure:** the planned level-step distribution before and after. Expect small changes (the
  owner's A/B found a median 0.6 LU difference between whole-track and body loudness). Audition
  only if a join's gain moves by more than 2 dB.

### W5.2 Rendered level trajectories — S–M, report only

- `render:check` reports per join: the master's short-term loudness from 8 bars before to 8 bars
  after the overlap, the largest dip or jump relative to the neighbors, per-segment true-peak
  margin, and each track's body dynamics (the P10–P90 short-term spread).
- Report only, with no new gate. The 5 LU planned-step gate stays, on consistent inputs. Do not
  reintroduce a threshold gate.
- **Tests:** a synthetic render with an engineered −6 LU dip at a join is reported, and the gates
  are unchanged.

### W5.3 Joint solver for outliers only — S, after W1 has outlier fixtures

- Keep `solveSetGains` separate. An opt-in `gainPolicy: "solver-outliers"` applies it only to
  entries whose body and integrated loudness differ by more than 2 LU (the candidate trigger from
  the 13 October verdict). Validate on synthetic quiet-intro masters and with an owner audition
  before any default change.

### W5.4 Vocal activity stage — research with a go/no-go, last

- An optional, versioned analysis stage, off by default like key analysis, producing a per-bar
  vocal-activity probability with confidence and coverage. Start with a CPU-only heuristic. Any
  model must be an explicit, documented opt-in, with no silent downloads. Unknown means unknown,
  never instrumental.
- Evaluate before use: label at least 30 joins from listening notes (vocals on both sides, one
  side, or neither) and report precision and recall. Go only if the owner accepts the numbers (D6).
- After a go: add a soft preference to W2.3 against windows where both overlap regions carry
  vocals, preferring other windows. No ducking and no stems.

## Architecture guardrails (Q10/Q11, inside the tasks)

- New modules from this plan: `plan-fingerprint.ts`, `local-timing.ts`, `join-candidates.ts`,
  `join-repair.ts`, domain `repair-policy.ts` and the shared residual module. Add each to the
  module map in [architecture.md](../architecture.md).
- The four oversized files may only shrink. P0.3 and W5.2 extract the manifest join-row builder
  from `render/coordinator.ts`; W2.3 moves the candidate logic of `chooseTransition` out of
  `timeline.ts`.
- W2.0 removes the planning-to-renderer layer exception.

## Owner decisions — defaults the agent uses unless the owner overrides

| ID  | Decision                                         | Default                                                                                         |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| D1  | Duration tolerance and quality window (W4.5)     | The two formulas in W4.5                                                                        |
| D2  | Local-timing disagreement: reject or rank (W2.2) | Reject only after no new rejections among the 98 accepted joins (or each auditioned); else rank |
| D3  | Holdout unit and size (W1.4)                     | 30% of canonical artists, seeded, frozen once                                                   |
| D4  | Automatic repair default and budget (W3)         | On for workflows; 3 alternatives per join, 2 extra full renders                                 |
| D5  | CI audio-corpus job on pull requests (W1.1)      | Required; a declared subset on pull requests if the full run exceeds 15 minutes                 |
| D6  | Vocal stage (W5.4)                               | No-go until the evaluation passes                                                               |
| D7  | Shared boost ceiling (P0.5)                      | −0.1 dBFS                                                                                       |

## Risks

- **Plan churn** from P0.2, P0.5, W2.x, W4.5 and W5.1: one policy per benchmark run, and every
  oracle change justified.
- **Planner slowdown** from the join search: memo, caps, and a runtime budget gated by the
  benchmark.
- **A shrinking usable library** from new rejections: coverage reported and bounded (W2.3
  acceptance).
- **Full re-analysis** after the DSP bump (W2.2): freeze diagnostics first; the owner schedules the
  re-analysis.
- **Predictor and checker disagreeing:** the checker is the authority; disagreements are reported
  and explained.
- **Old workflow rows:** new fields are optional and defaulted in code.
- **Benchmark disk use:** renders are deleted after measurement unless `--keep-audio`; peak disk is
  reported.

## Out of scope

- Changes to the owner's audio files or library layout.
- Promoting the source-deck probe to a gate; it stays advisory until a true positive is confirmed
  by ear.
- Tempo walking, stems and vocal ducking.
- New MCP tools. This plan only extends existing schemas (`update_set_plan` gains `setGain`; the
  workflow output gains optional fields).

## Command reference

Run these one at a time (Windows PowerShell 5 has no `&&`):

```text
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm lint:exports
corepack pnpm format:check
corepack pnpm test
node_modules/.bin/tsc --noEmit -p packages/catalog/tsconfig.json
corepack pnpm tsx tools/scripts/audio-regression-corpus.mts
corepack pnpm tsx tools/scripts/processed-deck-corpus.mts
corepack pnpm tsx tools/scripts/benchmark.mts --mode warm --split tuning --matrix tools/benchmark/matrix.v1.json
corepack pnpm tsx tools/scripts/benchmark.mts --mode warm --split holdout --milestone <name>
corepack pnpm cli analysis:run --scope stale --wait
corepack pnpm cli render:check --id <jobId>
```

## Traceability to the review

| Review section                         | Tasks                |
| -------------------------------------- | -------------------- |
| 1. Measure first                       | W1.1–W1.8            |
| 2. Better transitions before rendering | W2.0–W2.5, W5.1      |
| 3. Fix problems automatically          | W3.1–W3.5            |
| 4. Make first use simple               | P0.6, W4.1–W4.7      |
| 5. Volume and vocal handling           | P0.1–P0.5, W5.1–W5.4 |

## Kickoff instruction for the implementation agent

> Implement Phase 0 of `docs/plans/implementation-plan-2026-10-18.md`, task by task from P0.1 to
> P0.6, following its ground rules. Stop after P0.6 and report, per task: the commit SHA, the
> failing-first evidence, version and schema changes, verification results, and remaining
> acceptance work. Append the tranche to the ledger.
