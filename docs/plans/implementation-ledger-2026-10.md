# Implementation Session — Complete Commit Ledger

> **Status: HISTORICAL SNAPSHOT** (as of `98847da`, 10 October 2026). Records what shipped for the
> 8 October review plan. Follow-up work against the [10 October implementation review]
> (implementation-review-2026-10-10.md) — findings R1–R14, the follow-up commit table, and the
> deck-verifier recalibration — is appended at the end of this file and continues on `main`.

**Baseline:** `8dc0110` (review snapshot, 8 October 2026)
**HEAD:** `98847da` (exact replay from frozen context, 10 October 2026)
**Total:** 50 commits (36 from the implementation agent, 14 from the parallel DSP/planning agent)
**Source plan:** `docs/plans/repository-review-2026-10-08.md`
**Gates on HEAD:** both CI lanes green (Linux + Windows smoke), full test suite (67 files, 617+ tests), typecheck, lint, exports, format — all passing.

---

## Implementation Agent Commits (36)

### Batch 1–2: Trustworthy coordinates + honest QC

#### 1. `1bb16f4` — fix(render:check): place grids from manifest coordinates; audio scan reports honestly

- **Finding:** F1 (P1, reproduced) + F2 step 1 (P1, reproduced)
- **What:** The checker re-applied the recorded `downbeatOffsetMs` to the incoming start, double-counting it. The mixed-decode scan returned `advisory` on inconclusive evidence, which suppressed stored-grid failures.
- **How:** Added `placedIncomingOverlapStartMs` documenting the manifest coordinate contract (placed coordinates; offset is provenance, never a transform). Rewrote `diagnoseRenderedMix` to report mix quality only; alignment is explicitly `unmeasured` with a reason. Removed the advisory-clears-failure escape.
- **Why:** The double-count produced phantom residuals on every aligned join with a nonzero offset (review probe: placed start 80, offset 80 → read −80 instead of 0). The advisory override masked genuinely bad grids — a known-bad case could pass solely because evidence was missing.
- **Tests:** 5 unit cases (review probe, outgoing-end fallback, whole-beat shift, non-unit rates, genuine-misalignment control) + full render→check E2E.

### Batch 3: Local evidence + feasibility parity

#### 2. `0533c3f` — fix(planner): groove gate measures the actual overlap interval

- **Finding:** F3 (P1, reproduced)
- **What:** The structural groove gate sampled the outgoing's 16 bars _before_ its mix-out, not the actual overlap.
- **How:** Each side now samples from its own overlap start (outgoing `mixOutMs`, incoming aligned `mixInMs`) over the join's actual bar count (8/16/32). Added `localBeatProfile` + `beatIndexAtOrAfter` for overlap-local beat profiles with `grooveCompatibility`'s `positioned` mode.
- **Why:** A conflict only in bars 48–63 crossfaded while the same conflict in actual overlap bars 64–79 passed as `phrase_mix`. The fixed 16-bar span also misrepresented 8- and 32-bar overlaps.
- **Tests:** 10 cases (before/within/after overlap, 8/16/32-bar windows, partial coverage at series end, sparse abstention, nonzero origins, fractional starts, unequal rates). 8 of them fail against the pre-fix gate.

#### 3. `d6508e6` — fix(planner): transition proposals share structural eligibility; groove recalibration

- **Finding:** F6 (P2, code-traced)
- **What:** `plan_transition` could return aligned templates as feasible even when the shared chooser crossfaded for structural conflict. Also shipped the `groove-window-recalibrate.mts` tool.
- **How:** The structural gate is evaluated on each proposal's resolved window with the same shared function the set planner uses, so set planning, proposals, and validation report identical eligibility and reasons. Grid/tempo override flags (`allowLowConfidence` / `allowExcessiveTempo`) remain explicit and cannot bypass structural conflict.
- **Why:** The proposer dropped the chooser's rejection and computed a fresh window — a silent bypass of the only gate that prevents galloping blends.
- **Recalibration evidence:** 576 aligned joins across 50 recent plans replayed at each join's own mix-out/mix-in found **zero gate decisions that differ** between old and corrected windows — no existing plan changes treatment.
- **Tests:** 5 cases (proposer infeasible on conflict, no conflict outside overlap, validation parity, sparse abstention, override distinction).

### Batch 4: Immutable jobs (two separate commits as the plan required)

#### 4. `1450f0c` — fix(render): queued jobs verify frozen source identity (F4a)

- **Finding:** F4a (P1, code-traced + reproduced)
- **What:** `hydrateSegment` compared the decoded file against the _live_ track fingerprint, not the one frozen at enqueue time. A same-size interior edit was invisible to the head/tail fingerprint (first/last 64 KiB).
- **How:** Render requests freeze `sourceContentSha256` (full-content SHA-256 per source, computed once at queue time with a bounded in-process cache keyed by path+size+mtime+fingerprint). Execution verifies against the frozen hash; interior edits reject; identical-byte moves still render; legacy requests fall back to the frozen cheap fingerprint then the live-row comparison.
- **Why:** Replacing a file and rescanning made the live check pass while the queued plan still had different bytes. Preview cache identities change once (effective frozen inputs now include content bytes).
- **Tests:** 3 E2E cases (interior edit rejects after enqueue, move renders, legacy policy documented with the gap shown).

#### 5. `e712e3c` — fix(render): freeze canonical metadata for queued quality (F4b)

- **Finding:** F4b (P1, code-traced + reproduced)
- **What:** `snapshotTrackEvidence` captured analysis rows but no canonical metadata. Manual/published keys could be replaced by analyzed keys; plans could pass live quality and fail queued quality, or change result after later metadata edits.
- **How:** Requests freeze a canonical block (musicalKey, camelotKey, keySource, keyConfidence, nativeBpm, effectiveEnergy, keyAnalyzerName, gridEngine) computed with the same resolvers the live quality path uses. Absent analysis no longer means absent canonical metadata.
- **Why:** A snapshot with no analysis had `present: false`, null key, null confidence even when the catalog had a valid manual key. Frozen quality consulted live key source and live energy.
- **Tests:** 4 unit cases (manual key without analysis, conflicting analyzed key with manual precedence, split engine identities, post-edit stability).

### Batch 5: Contracts + freshness

#### 6. `10dd494` — fix(domain): descriptor schema keeps committed and 3.12 fields (F5)

- **Finding:** F5 (P2, reproduced)
- **What:** `sonicDescriptorsSchema` omitted `grooveSyncopation`, `backbeatConcentration`, `bars.syncopation`, and the DSP 3.12 phase diagnostics. Parsing a descriptor through the schema silently stripped them.
- **How:** Schema mirrors `SonicDescriptors` exactly including optionality. Added `SONIC_DESCRIPTOR_KEYS`/`BAR_SERIES_KEYS` key-list guards (compile-time `AssertEmpty` + runtime equality with the zod shape keys). Round-trip fixtures pin every field survives parsing and JSON serialization. The type-side was reconciled: `energy`, `danceability`, `chromaVector`, `tempoEvidence` became optional to match what pre-3.x descriptors and the schema always allowed.
- **Why:** Schema-driven clients (MCP) couldn't depend on committed data. Bidirectional assignability cannot catch an optional field added to one side only — the key-list guards close that hole permanently.

#### 7. `14e6c51` — fix(tools): recalibrate script satisfies tools typecheck and lint

- **What:** The `groove-window-recalibrate.mts` script had TypeScript errors in the tools tsconfig project and lint issues.
- **Why:** The tools project typecheck (`tsc -p tools/tsconfig.json`) wasn't run before the initial commit.

#### 8. `67d5de2` — fix(analysis): freshness covers inputs; anchor edits invalidate grid features (F9)

- **Finding:** F9 (P2, code-traced)
- **What:** `dspCurrent` judged freshness by analyzer version, fingerprint, and reference BPM only — changing the configured tempo range or beat anchor left stale rows "current." `setBeatAnchor` spread the existing row, leaving grid-indexed sections, kick/snare arrays, per-bar syncopation, and groove/phase descriptors describing the _previous_ grid.
- **How:** A versioned input identity (`dsp-identity.ts`, shared by the coordinator check, the stage rows, and the stale-scope selection) covers tempo bounds + beat anchor. Unset optional inputs keep the bare-version identity so existing libraries are not mass-invalidated. Anchor edits strip grid-indexed features via `stripGridIndexedFeatures` (independent loudness/band/chroma/energy survive). Reference locks are manual/published only; the analyzed-BPM writeback echo is never passed back as a reference. Explicit `trackIds` or `scope: "all"` forces a DSP pass (`forceDsp` via migration 021, idempotent ALTER).
- **Why:** The documented "rerun after changing the tempo range" performed no DSP work. Old descriptors were being interpreted against a new grid origin.
- **Tests:** 4 cases (tempo-bound change triggers re-analysis and idempotent rerun, force for explicit ids, anchor strips grid features + row goes stale, reference-removal re-runs).

### Batch 6: Editing + replay

#### 9. `1182a6f` — fix(plan-editor): structural edits invalidate changed adjacencies (F7)

- **Finding:** F7 (P2, reproduced)
- **What:** `moveEntry` reorders entries and `buildEntries` reused any existing outgoing transition keyed only by track ID. Moving `[A,B,C,D]` to `[A,C,B,D]` carried A→B's parameters onto A→C. Edited plans saved the old explanation's rankings as if current.
- **How:** `buildEntries` stamps every transition with `incomingTrackId` (pair identity). `updateSetPlan` drops transitions whose incoming side changed after any structural edit; unchanged adjacencies keep their treatments. Changed adjacencies mark the explanation `edited` (timestamp + changed-join list) so stored rankings are read as stale.
- **Why:** Numeric validation can't establish that B-specific cue/automation settings are still musically intended for C. Chain-tempo rates stay as stored; downstream re-derivation is documented follow-up.
- **Tests:** 2 cases (middle move replans all changed pairs with new ids + pair stamps, rotation keeps unchanged pair's exact transition, no-op trim leaves explanation unmarked).

#### 10. `2e9bcf0` — fix(planner): automatic history is explicit, filtered and recorded (F8)

- **Finding:** F8 (P2, code-traced)
- **What:** `createSetPlan` silently picked variety history, fetching only the 12 most recent plans before filtering for 8+ entries — short drafts could hide older qualifying history. None of the resolved inputs were persisted.
- **How:** History resolution is now explicit: `"explicit"` (from the brief), `"auto"` (default; scans `VARIETY_AUTO_HISTORY_SCAN = 64` recent, filters eligibility _before_ taking `VARIETY_RECENT_PLAN_WINDOW = 6`), `"off"`. Every plan records `historyMode`, resolved `referencePlanIds`, `recentArtistUses`, and `policyVersion` in `explanation.variety`.
- **Why:** "Same catalog + constraints + seed" was no longer a sufficient reproducibility claim — generating a plan changed future planning.
- **Tests:** 3 cases (records resolved auto history, 14 short drafts don't hide older qualifying plan, explicit off mode).

### Batch 7: Independent audio verifier

#### 11. `d3cfec5` — fix(render:check): unique phase-4 scratch names for concurrent checks

- **What:** Phase-4 PCM decode used a deterministic filename (`phase4-N.pcm`); concurrent checks of the same render could collide.
- **How:** Added a random 8-character token per invocation.

#### 12. `2cadaf6` — feat(render:check): independent deck-probe alignment verifier (F2 step 2)

- **Finding:** F2 step 2 (P1, the review's most-demanding gap)
- **What:** The mixed-decode scan cannot attribute transients to decks, so alignment had no audio measurement at all.
- **How:** `verifyDeckAlignment` decodes each deck's OWN placed source window, beat-locks measured onset trains to the projected frozen grids, and compares in output time: inter-deck offset with beat-phase wrapping (whole-beat relationships stay phase-equivalent — bar-phase judgment needs downbeat anchors and belongs to the grid checks), start/end-half drift, honest abstention when either train is too sparse. Modes: `--audio fast` (default; 10s midpoint probe, 2 decodes per aligned join), `full` (whole overlap + half-drift), `off`.
- **Calibration:** First run on the two accepted-listen renders (47 aligned joins): **0 measured fails, 12 pass, 7 review, 28 unmeasured** — no hard false positives. The initial run exposed two measurement flaws (phrase-period alignment windows disabled wrapping; raw full-band onset clouds paired musical content instead of beats) — fixed by deriving the beat period from the frozen grid and beat-locking each train.
- **Why:** Verdicts stay advisory; the stored-grid residual remains the only alignment gate until the labeled corpus grows.

#### 13. `3710089` — test(planning): make the prolific-rotation fixture deterministic

- **What:** The auto-references test seeded 20 identical tracks with fresh random UUIDs; planner tie-breaks hash seed+trackId (deterministic per catalog, random across runs) and the fixture was supply-constrained (plan 1 consumed 7 of 14 soloists, forcing a Prolific into plan 2).
- **How:** Fixed with 20 soloists (fresh supply guaranteed) and a pinned Prolific opener (guaranteed history to rotate out). Verified ~40% flake rate before the fix; 8/8 isolated and 3/3 full-file runs stable after.

### Batch 8: Ops hardening

#### 14. `2c31e35` — fix(ops): fence worker takeover, own scratch dirs, useful persist errors, Windows lane

- **Finding:** F10 + review items 2/5/9
- **Worker fencing:** `heartbeat()` detects the token-scoped UPDATE affecting no row, clears the owned flag, returns false; the pump stops claiming work immediately. In-flight synchronous jobs still complete but no further claims happen. Deterministic two-owner takeover tests (fake stale heartbeat, second owner acquires, first owner's next beat reports deposal).
- **Scratch ownership:** Scratch dirs carry an `owner.json` pid marker (`claimScratchDir`, wired into the analysis decode path). The sweep keeps stale dirs owned by live processes (however old their mtime), sweeps dead-owner and legacy (marker-less) dirs, validates symlink containment against the resolved temp root, recognizes the render:check deck/phase-4 scratch patterns. Tests fake both time and owner state.
- **Persist errors:** `parseStoredJson` reports which stored shape failed, where (zod path), and how to recover (clone with replan) — the raw "invalid explanation" dead end is gone.
- **Windows CI:** 30-minute bounded lane with winget ffmpeg; covers paths, process spawn, SQLite locks, rename/publication, temp hygiene on non-native test files. No new platform support promise; full Linux/native lane unchanged.

### Batch 9: User-facing features

#### 15. `78d82e0` — feat: join inspector — one evidence view for a saved join

- **What:** `inspect_transition` (MCP) / `transition:inspect` (CLI) — one read-only evidence view for a saved join: stored treatment (type, duration, bars, target BPM, selection reason, F7 pair stamp, applied recipe), placed source windows for both sides (start/end, playback rate, the outgoing's overlap start in source coordinates), alignment provenance (offset, period, mode, onset-lock beats), the groove-gate numbers recorded at selection (gap, per-side means and measured bars, window positions, abstention reason), what the planner would choose for the pair today, and per-template alternatives with F6-eligibility blockers.
- **Why:** The review's #1 recommended next feature — everything a bad-join diagnosis needs in one call, built on every prerequisite (F1–F3 windows, F5 contracts, F6 parity, F7 pair identity).

#### 16. `addd775` — tools: audition-previews renders OLD/NEW A/B previews for the groove flips

- **What:** Renders the stored treatment and the fresh planner's choice on the same frozen windows for any pair, so only the treatment varies. Copied into `output/audition-YYYY-MM-DD/` with a listening sheet.
- **Why:** The review's variant-comparison concept, used manually throughout the calibration sessions.

#### 17. `812b3bb` — tools: audition script retries cancelled previews, skips missing-file pairs

- **What:** A raced claim or an aborted worker could cancel a fresh job (retry once settles it); a track marked missing from disk crashed the loop.

### Calibration from owner listening

#### 18. `d0dd876` — fix(planner): automatic bass swap requires decisive conflict (audition-calibrated)

- **What:** The old `groove < 0.0` trigger fired on rounding noise — ~10% of library pairs got automatic bass_swap from scores in ±0.2.
- **Evidence:** First A/B audition (6 pairs, frozen windows): all four automatic triggers sat in a −0.002..−0.207 groove-score band with no separation by outcome (a phrase_mix-preferring pair scored MORE negative than a bass_swap-preferring one). Library-wide distribution (173 distinct pairs): p10 −0.002, median 0.26, only 1 below −0.45. The designed kick/snare label-swap case scores ≈−0.95.
- **How:** Trigger raised to `PLANNER_BASS_SWAP_TRIGGER_GROOVE = −0.45`. Mild negatives stay phrase_mix; hand-liked swaps preserved via recipes. All 12 verdicts recorded as transition feedback on the exact preview renders.
- **Owner principle (verbatim in substance):** _phrase_mix is always better when it works — it preserves volume and keeps energy flowing; bass_swap fades the outgoing out too much before the incoming fades in, leaving a volume/energy dip._
- **Tests:** Partial label-swap fixture landing at ~−0.2 asserts phrase_mix; full swapped-backbone still asserts bass_swap + glide.

#### 19. `4128cb8` — format: prettier on service.ts (eslint --fix parens)

- **What:** `eslint --fix` added redundant parentheses that Prettier wanted removed — the two tools disagreed their way into a failed CI run.

#### 20. `d1831a2` — tools: verifier-suspect previews, bass-swap candidate list, pnpm fix

- **Verifier suspects:** Inspects + previews the deck verifier's candidate catches (Picton Blues → Hayling at ~100ms despite a 9ms stored offset; Tour → Under with a designed 8-beat onset-lock slip + measured sub-beat drift).
- **Bass-swap candidates:** Lists stored bass_swap joins whose score wouldn't meet the tightened bar and carry no liked feedback/recipe — 33 distinct pairs, 30 candidates, 1 still decisive.
- **`pnpm fix`:** `eslint . --fix && prettier --write .` — prevents the class of CI failure from #19.

#### 21. `4ba2458` — tools: narrow the liked-feedback type guard in the candidate list

- **What:** `feedbackRatingValueSchema` allows `number | "not_assessed"`, so the `overall >= 0.7` comparison needed a typeof guard.

#### 22. `d5dd500` — fix(render:check): deck probes time the kick band, not the full mix

- **What:** Full-band onset trains timed vocals and pads — the verifier's first two candidate catches were auditioned _perfect_ by the owner: labeled false positives.
- **How:** Probes now low-pass at 180 Hz before onset extraction (the `lowpass` helper from audio-diagnostics), keeping the kick (and the bass it lands on) as the timing authority — the same medicine the review prescribed for the DSP 3.12 broadband phase flag. Re-measured: both false positives clear, zero measured fails across all renders, accepted corpus stays 0-fail (6 review, 32 unmeasured — the sparser kick signal abstains more, which is the honest direction).
- **Why:** Vocal-heavy material skews the deck-to-deck offset measurement.

### Windows CI catches (the lane doing its job)

#### 23. `c5b2452` — fix(render): readiness resolves library roots the way the scanner does

- **What:** The scanner stores `realpath()`-expanded track paths, but render readiness compared against bare `path.resolve(config.libraryRoots)`. On GitHub's Windows runner (`os.tmpdir()` returns `C:\Users\RUNNER~1\...`), every track read as "outside the roots" and every render was refused.
- **How:** `assessReadiness` now uses `resolveLibraryRoots` — the same helper the scanner uses. Regression test renders a full job from a library whose configured root is a junction/symlink alias. Verified the test fails against the unfixed coordinator.
- **Why:** Any Windows user whose configured root contains an 8.3 short name would hit this on their real catalog.

#### 24. `50d86a4` — test(scanner): match the readdir mock against the realpath'd subtree

- **What:** The unreadable-subtree fixture's mock compared exact strings; on the runner, the scanner walks the realpath'd root (long form) while the test built the short form — the mock never fired.

### Continued feature work + calibration

#### 25. `0a83baa` — fix(render:check): deck-probe advisories never gate first-mix workflows

- **What:** Deck-probe verdicts varied with the ffmpeg build and their advisory entries landed in `checkRender.warnings` — the channel the first-mix workflow treats as fatal (RENDER_WARNINGS → OUTPUT_CHECK_FAILED), passing locally on Windows ffmpeg while failing on CI's Linux build.
- **How:** Deck-probe results now live ONLY on the join rows (`audioStatus`, `audioFindings`, `audioUnmeasuredReason`) until calibrated; the top-level warnings list keeps exactly its pre-verifier semantics.

#### 26. `a01c062` — tools: audition script pins to a plan, matches duplicate titles exactly

- **What:** The library has two tracks both titled exactly "Escape" — the fuzzy title matcher hit the wrong one. Now matches exact-title candidates first and checks all candidates during adjacency search.

#### 27. `2b214c0` — docs+tools: high-gear A/B round two — all three flips prefer the blend

- **What:** The owner A/B'd the High gear hour's three noise-era bass swaps — all three preferred phrase_mix. Verdicts recorded, the High gear plan's three joins flipped to phrase_mix on their frozen windows, v1 listen preserved (`high-gear-v1-perfect.flac`), re-rendered green.
- **Calibration tally:** 5 of 8 auditioned flips prefer the blend, 2 prefer the swap (both recipe-pinned), and the trigger score does not separate winners — confirming the architecture.

#### 28. `14bbfcc` — fix(planner): remixes share one family for plan dedup (owner verdict)

- **What:** "Rock It" (Sub Focus) and "Rock It - Wilkinson Remix" (Sub Focus, Wilkinson) landed in the same hour because the remixer credit split the family artist key.
- **How:** The family key now uses the primary artist (before the first collaborator comma) and a family-only title normalizer that strips named-remix suffixes and paren groups. Recording identity (`recordingKey`) is untouched: remixes stay distinct productions for history, feedback, and recipes.
- **Owner verdict:** "we can't have 2 Rock Its in the mix."

#### 29. `28a9b62` — fix(domain): dash-suffixed VIP/edit variants share the family too

- **What:** "Pool Hopping - VIP" didn't collapse with "Pool Hopping" because the dash-suffix stripper missed bare `VIP`/`edit` tokens.

#### 30. `c0129dd` — fix(planner): grid-suspect tracks stay out of the planning pool

- **What:** The DSP 3.12 diagnostics flag tracks whose stored grid disagrees with their own audio (`gridPhaseSuspect`), but nothing consulted the flag when building plans. The variety mix proved the cost: `canuhearmenow?` (55ms) and `Pool Hopping - VIP` (82ms) landed as aligned joins with **corroborated** 60–140ms misalignments — the stored-grid residual AND the deck-probe verifier independently agreed.
- **How:** `analysisToTimeline` carries `gridPhaseSuspect` through; the pool rejects such tracks (`GRID_PHASE_SUSPECT`).

#### 31. `5ecbcf0` — format: prettier on the audition script

#### 32. `1a0a875` — feat(planner): unmixable tag hard-excludes from the pool; quarantine tool

- **What:** The owner reported three songs as "not good in mixes" (joins fine, songs aren't).
- **How:** Verdict recorded as accepted hour feedback; tracks tagged `unmixable` + rating 1; physically moved to `Music/unmixable/`; rescanned. The pool rejects `unmixable`-tagged tracks unconditionally — no brief should have to opt out of an owner-recorded verdict. `quarantine-unmixable.mts` moves tracks + rescans.

#### 33. `2f0e887` — feat: variant comparison + surgical repair (batch 9 complete)

- **Variant comparison** (`compare_transition_variants` / `transition:compare`): renders the stored treatment + every other feasible aligned template for one saved join on the same frozen windows (comparable loudness). Per-variant: template, isStored, F6 feasibility, blockers, preview job ID. After previews finish, present listen files; record the owner's verdict per variant with `rate_transition`.
- **Surgical repair** (`repair_set_plan` / `plan:repair`): replaces a join's incoming track while preserving every other adjacency. Built on F7 pair-aware invalidation: only the changed pair is replanned; every other join keeps its stored treatment exactly. Protected transition IDs accepted for explicit preservation. Returns the updated plan + a surgical diff (changed join from/to, protected count, invalidated list).
- **Why:** The review's two highest-value remaining features — productizes the manual A/B flow used throughout the auditions and makes "repair join 7, keep these approved" a first-class command.

#### 34. `9dc9c2e` — test: repair fixture picks a spare track not already in the plan

- **What:** The replacement track was already in the plan on CI (different fixture resolution order) — the repair introduced a duplicate.

#### 35. `c86f24d` — fix(planner): grid-suspect exclusion is confidence-aware, not hard

- **What:** The hard grid-suspect pool exclusion from #30 blocked small libraries: the first-mix fixtures (2 MP3s) analyzed with suspect grids and the pool emptied, failing both integration tests on CI.
- **How:** The exclusion now only fires when `catalog.length >= PLANNER_POOL_MIN_TRACKS * 2` (enough alternatives to be selective). A small library admits suspect tracks rather than refusing to plan.
- **Result:** Both CI lanes went green — the first fully green run since the Windows lane was created.

#### 36. `98847da` — feat(planner): exact replay from a frozen planning context (feature 4)

- **What:** `replayFromPlanId` reuses the referenced plan's _persisted_ frozen context — its reference plans' track IDs, pairs, artist-use counts from the explanation — and its seed, so the same catalog + brief reproduces the same selection despite newer plans.
- **How:** The `createSetPlan` pipeline is extracted into a shared `createSetPlanWithHistory` helper. The replay path loads the referenced plan's explanation and feeds the frozen context directly, skipping live history resolution entirely. The replayed plan's explanation records `historyMode: "replay"`.
- **Why:** F8's acceptance: "replay with frozen context remains stable despite added/edited/deleted reference plans." Prerequisite for dependable "repair just this join" and fresh/replay UX.
- **Test:** Create plan A (seed 42), create plan B (seed 99), replay A — identical track selection to A despite B now being in the auto-history.

---

## Parallel Agent Commits (14)

#### 1. `f627a4c` — analyzer 3.12.0: grid phase + beat-phase content diagnostics

- **What:** The DSP analyzer gained a stored grid-phase scan (largest grid-vs-audio phase error across 30-second windows, `gridPhaseMaxErrorMs` / `gridPhaseSuspect`) and a beat-phase content histogram (`beatPhaseHistogram`, 20 bins per beat — bin 0 = on the beat, bin 10 = the off-beat 8th, bins ~7/13 = triplet positions).
- **Why:** Detects the "slightly off, drums don't line up" join class (verified on We Can Have It All, whose grid ran 93ms early against its own audio) and off-beat-dominated content (Seba's Snow blend region peaked at ⅓ and ⅔ positions) that reads as misaligned under straight material.

#### 2. `6bb6df1` — analyzer 3.12.1: phase scan on the kick+snare backbone

- **What:** The phase detector was rescoped to measure on the kick+snare backbone (the frequencies that carry the grid) rather than broadband, which was contaminated by hats, vocals, and pads.

#### 3. `01f9d37` — analyzer 3.12.2: phase detector requires a decisive win over the stored grid

- **What:** A suspect flag was only set when the alternative alignment decisively beat the stored grid — not just when any error was found. Prevents false positives from syncopated or triplet content that legitimately sits off the stored grid.

#### 4. `9fe8e51` — analyzer 3.12.3: phase detector accepts only sub-beat shifts

- **What:** The detector was further constrained to only flag constant sub-beat shifts (not whole-beat or bar-level offsets, which are phase-equivalent on the beat grid and the lock's territory).

#### 5. `75ee623` — docs: grid-phase detector calibration record (3.12.0–3.12.3)

- **What:** The full calibration record for the phase detector's evolution, including the synthetic offbeat-hat counterexample that drove the sub-beat constraint.

#### 6. `6fa6e88` — Update README.md

#### 7. `7b0f354` — feat(planning): harden pools, windows, and edits from the 2026-10 listening sessions

- **What:** Five listening-session hardenings in one commit: (1) pool rejects `tempoStability < 0.6` (PLANNER_MIN_TEMPO_STABILITY); (2) windows prefer drummed incoming heads and anchor dead intros on the drop; (3) quality fails ENTRY_BODY when a body can't host both join regions; (4) `fam:` keys deduplicate edition variants; (5) plan editor strips stale alignment pins on window edits.
- **Why:** Every unmixable track the owner verdicted (Half Light 0.175, Break The Cycle 0.131) measured unstable while paper metrics stayed clean; drumless entries and thin bodies were render-time surprises; "Heartbeat Loud" appeared twice via radio/extended variants; stale pins became audible flams.
- **Tests:** 11.

#### 8. `9c1f61e` — docs(mixing): record the 2026-10 listening-session findings

- **What:** The six validated failure signatures (unstable grids, drumless heads, gallop signature → bass_swap, plan-time body check, variant dedupe, editor gotchas) written into the repo's own planning rules, plus the `.cursor` mix-session rule.

#### 9. `c2c0310` — test: complete TimelineAnalysis fixture fields for windows-smoke

- **What:** The hardening test fixture omitted four required fields (`audioStartMs`, `audioEndMs`, `mixInMs`, `mixOutMs`). Vitest doesn't typecheck, so only the Windows-smoke CI job caught it. Fixed the fixture.

#### 10. `3657d31` — feat(planning): energy-death joins fail strict quality

- **What:** Shared `isEnergyDeathContinuity` predicate (valley > 3.5 with coexist < 9 — the measured boundary between the owner's complaints ≥3.69 and approved joins ≤2.90 or ≥10 coexist), wired into both the quality report and the planner's chain gate.
- **Why:** The recurring "energy dies" complaint was an aligned join whose outgoing fade rode a dying breakdown. The selection gate now reroutes before choosing the track.

#### 11. `6177176` — docs(rule): canonical session-offender registry and brief hygiene

- **What:** Canonical `data/session-offenders.json` (31 IDs with reasons) after discovering per-brief exclusion lists drift — one had silently lost six offenders. Also documented the `minRating` footgun.

#### 12. `8b99100` — fix(windows): stale manual intro cues no longer override drop anchoring

- **What:** Manual `intro_start` cues (from old audition tooling) were overriding drop anchoring unconditionally, landing mix-in at source 0 over dead intros. A cue now wins only where it lands on live material. Verified on the crate: Pathways and All Our Yesterdays proposals now anchor at drop−16 bars instead of source 0.
- **Tests:** 3.

#### 13. `8cd674d` — fix(planning): minRating excludes rated-bad, never unrated

- **What:** Old semantics rejected UNRATED tracks on any `minRating` — a footgun that forced hand-maintained exclusion lists. Now unrated pass, rated-1 excluded. Search deliberately keeps rated-only semantics ("show 4+ stars" ≠ "exclude known bad").

#### 14. `49d7369` — fix(validate): collapse systematic energy-arc deviations into one warning

- **What:** Every render carried 4–6 identical "energy 7 vs target 4.0" lines — all the same condition (pool lacks material as soft as the arc). ≥3 deviations in one direction now collapse to one summary naming the worst gap.

#### 15. `e976108` — fix(descriptors): melodicness spreads on real DnB instead of pinning at 0.013

- **What:** The DSP fix. Melodicness was a constant ~0.013 across all 642 tracks because a clarity gate real DnB never passes crushed keyConfidence to 0.001–0.02 — liquid mood presets could never work. Live-probed liquid vs heavy, rebuilt the formula on entropy-clarity + onset-suppressed peaks, bumped DSP to 3.13.0, re-analyzed the crate: now p10 0.10 / p50 0.26 / p90 0.63, top decile the genuine liquid material.

#### 16. `5117569` — test(analysis): pin the click-track analyzer version to DSP 3.13.0

- **What:** Trivial follow-through — the version pin in the click-track test needed the bump from the melodicness fix.

---

## Summary by review finding

| Finding                                         | Priority | Status                | Commit(s)                       |
| ----------------------------------------------- | -------- | --------------------- | ------------------------------- |
| F1: checker double-applies alignment offset     | P1       | ✅ Fixed              | `1bb16f4`                       |
| F2: inconclusive audio clears failures          | P1       | ✅ Fixed (both steps) | `1bb16f4`, `2cadaf6`, `d5dd500` |
| F3: groove gate reads pre-overlap material      | P1       | ✅ Fixed              | `0533c3f`, `d6508e6`            |
| F4a: frozen source identity                     | P1       | ✅ Fixed              | `1450f0c`                       |
| F4b: canonical evidence frozen                  | P1       | ✅ Fixed              | `e712e3c`                       |
| F5: descriptor schema drops fields              | P2       | ✅ Fixed              | `10dd494`                       |
| F6: proposals bypass groove fallback            | P2       | ✅ Fixed              | `d6508e6`                       |
| F7: moveEntry preserves old neighbor's settings | P2       | ✅ Fixed              | `1182a6f`                       |
| F8: automatic freshness unrecorded              | P2       | ✅ Fixed              | `2e9bcf0`                       |
| F9: freshness omits inputs, anchor stale        | P2       | ✅ Fixed              | `67d5de2`                       |
| F10: cleanup needs ownership                    | P2       | ✅ Fixed              | `2c31e35`, `d3cfec5`            |

## Summary by review feature

| Feature                                 | Status                                                           | Commit(s)                       |
| --------------------------------------- | ---------------------------------------------------------------- | ------------------------------- |
| 1. Join inspector + variant comparison  | ✅ Complete                                                      | `78d82e0`, `2f0e887`            |
| 2. Surgical repair with protected joins | ✅ Complete                                                      | `2f0e887`                       |
| 3. Confidence-aware safe mix zones      | ✅ Track-level done (stability + grid-suspect + unmixable gates) | `7b0f354`, `c0129dd`, `1a0a875` |
| 4. Replay/fresh/discovery controls      | ✅ Replay done                                                   | `2e9bcf0`, `98847da`            |
| 5. Similar approved treatments          | Data ready (18 recorded ratings); not yet built                  | —                               |
| 6. Vocal-overlap awareness              | Not started (experimental)                                       | —                               |

## Additional work items from the review

| Item                                | Status                                                                 | Commit(s)                       |
| ----------------------------------- | ---------------------------------------------------------------------- | ------------------------------- |
| 1. Extraction by responsibility     | Parked (lint hotspots remain; fold into batches)                       | —                               |
| 2. Persistence boundaries           | ✅ Useful errors for plan reads                                        | `2c31e35`                       |
| 3. Centralized coordinate contracts | ✅ `placedIncomingOverlapStartMs` documents the manifest contract      | `1bb16f4`                       |
| 4. Decoder normalization parity     | Parked (needs cross-format fixtures)                                   | —                               |
| 5. Worker fencing                   | ✅                                                                     | `2c31e35`                       |
| 6. Engine/policy identity           | Partially (policyVersion for variety; engine identities frozen in F4b) | `2e9bcf0`, `e712e3c`            |
| 7. Native cancellation coverage     | Parked                                                                 | —                               |
| 8. Living documentation             | ✅ 7+ docs updated                                                     | Multiple                        |
| 9. Windows smoke CI                 | ✅ Lane green (caught 2 real bugs + 1 test bug)                        | `2c31e35`, `c5b2452`, `50d86a4` |

## Implementation review follow-up - 10 October 2026 (findings R1-R14)

Fixes for the 10 October implementation review, in commit order:

| Finding                                                      | Status                                                                                                                                   | Commit(s)                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| R1: protected repair invariant + honest diff                 | Fixed                                                                                                                                    | `f4b774d`                       |
| R2: `transition:compare` CLI worker policy                   | Fixed                                                                                                                                    | `f4b774d`                       |
| R3: buildEntries overrides resolved cue placement            | Fixed (scoped: aligned-join mix-in + plannedStart; mix-out keeps manual cue - Linux first-mix integration rejected the full swap)        | `700b5c4`, `a4bfe84`            |
| R4: edited windows skip realignment (recipeVersion re-stamp) | Fixed                                                                                                                                    | `700b5c4`                       |
| R5: deck-probe coordinate mismatch                           | Fixed                                                                                                                                    | `f4b774d`                       |
| R7: recentArtistUses persisted for all history modes         | Fixed                                                                                                                                    | `f4b774d`                       |
| R8: execution SHA check reuses stale enqueue hash            | Fixed (execution reads bytes; freeze surfaces hash failures)                                                                             | `12e0b93`                       |
| R9: frozen absence falls through to live evidence            | Fixed (presence-based maps, canonical owns nulls, frozen keys for clash check)                                                           | `91b9d2d`                       |
| R10: workflow freshness vs dspInputIdentity                  | Fixed (shared dspFreshness decision; pending+missing-stage rows selected stale)                                                          | `3c52758`                       |
| R11: grid-suspect pool size switch                           | Fixed                                                                                                                                    | `f4b774d`                       |
| R12: takeover does not fence completion                      | Fixed (claimed_by migrations 022/023; fenced markSucceeded/markFailed across render/analysis/enrichment; deposed owners discard results) | `e608f62`, `ab577ad`, `8d5e1a4` |
| R13: PlanExplanation.edited schema drift                     | Fixed                                                                                                                                    | `f4b774d`                       |
| R14: comparison feasibility on fresh windows                 | Fixed (savedWindow context; labeled comparison context incl. MCP schema)                                                                 | `ec89457`                       |

Remaining from the review:

| Item                                                                                         | Status                                                                                                                              |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| R6: verifier scope naming/status consistency + recalibration after R5                        | Open - re-run `audio-verifier-calibrate.mts` against the library, then reconcile scope names and off/skipped/decode-failed statuses |
| R2 remainder: per-variant lifecycle state + partial-success exit behavior in the compare CLI | Open                                                                                                                                |
| R7 remainder: replay-of-replay stability, eligibility paging before the 64-plan window       | Open                                                                                                                                |
| Single frozen comparison-context identity across variant previews                            | Open (R14 labeled the context; previews still freeze per-variant)                                                                   |
| Documentation reconciliation (9 items)                                                       | Open                                                                                                                                |

### Deck-verifier recalibration after R5 (10 October 2026)

Re-ran `audio-verifier-calibrate.mts` over 8 renders (4 owner-accepted) with the
probe-coordinate fix in place. Accepted-listen joins: 98 - pass 39, review 21,
fail 0, unmeasured 38. Zero false fails; the advisory "review" verdicts are
measured drift swings (20-92 ms) on joins the owner accepted by ear, so they
stay advisory per the gate-promotion rule. Coverage improved versus the
pre-R5 run (retained grids no longer starve the 32-bar midpoint probe).
Remaining R6 work is naming/status consistency, not measurement.

## Review follow-up completion - 11 October 2026

Final commits closing the review remainder:

| Item                                                                                                                       | Commit               |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| R2 remainder: per-variant lifecycle + partial-success exit (CLI/MCP/service)                                               | `d6af596`            |
| R6 remainder: source-deck scope naming, per-mode unmeasured reasons, audioVerification block                               | `42d915e`            |
| R7 remainder: eligibility-aware history paging (SQL), replay-of-replay stability test                                      | `c57ebaf`            |
| Doc batch 1: scoring/mixing policy ownership, rendering verification semantics                                             | `976c7d9`            |
| Doc batch 2: README start-here, active-backlog governance, architecture qualifications, agent rules, followups corrections | `e447fc9`, `e1e49a7` |
| Doc batch 3: cli compare semantics, session-script triage to experiments area                                              | `d53bfbf`            |

CI note: the MCP first-mix integration (`apps/mcp-server/test/first-mix.integration.test.ts`)
flaked on the Linux lane three times on 10 October (RENDER_WARNINGS + OUTPUT_CHECK_FAILED);
reruns of the same commits are green and a previously-green commit also re-ran green, so it is an
intermittent Linux-runner failure, not a regression. The test now dumps the check-stage detail
(job warnings + full check result) when the workflow does not succeed (`bf7a4a4`), so the next
occurrence is diagnosable from the log. Follow up if it recurs.

Still open beyond the review: the single frozen comparison-context identity spanning variant
previews (R14 labeled the context; previews freeze per-variant), and the lint-hotspot
responsibility extraction the review scopes to "while changing them".

### Final engineering items - 11 October 2026

| Item                                                                                                                                                                                                      | Commit    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Single frozen comparison-context identity across variant previews (R14 completion; tolerant freeze preserves per-variant readiness failures; CLI --wait reports measured loudness per variant)            | `4266403` |
| Lint-hotspot extraction: render/deck-probe.ts (coordinator 2,366 -> 2,211) and service/inspection.ts (service 1,534 -> 1,239), both behind the existing suites; DSP 3.13 files left to the parallel agent | `4266403` |

Both CI lanes green on `4266403`. The Linux MCP first-mix flake did not recur;
its in-test diagnostics remain armed. Nothing from the 10 October review or its
remainder list is open; future work returns to the feature shortlist (similar
approved treatments, vocal-overlap awareness) and opportunistic gray-zone
calibration.
