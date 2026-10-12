# Implementation review and next steps — 12 October 2026

> **Status: HISTORICAL SNAPSHOT.** Superseded by the [repository review and quality roadmap](quality-roadmap-2026-10-12.md), which reconciles the subsequent T1–T8 delivery tranches through `cb8986c`. This snapshot reviews the implementation through `bd9f0043afbf0d70d7a0df03ba76472d3718b41f`, plus the real-library runner/report committed as `bcb7bce` during this review, against the [11 October review](implementation-review-2026-10-11.md). Findings T1–T8 below qualify the completion claims in the [implementation ledger](implementation-ledger-2026-10.md). Application code was not changed by this review.

## Recommendation

Fix the new recovery timing regression and the remaining ownership fences before tuning automatic selection against a real library. Finish the evaluation machinery alongside those fixes. The implementation made useful progress, but “A–C complete, only broader selection remains” is not supported by the current behavior.

The first real-library pilot now exists. Both renders completed, but both output checks failed; T8 identifies the two residual cases to preserve and investigate. The immediate next step is to understand those failures and repair the evaluation contracts, rather than broaden search using a pass rate whose meaning is still unsettled.

Keep the product direction: the crate should generate good joins without a user collecting approved pairs. Store resolved transitions internally for reproducibility. Approved-join libraries and an expanded manual workbench remain optional. Audition labels here are development evidence, not a prerequisite for every user-generated mix.

Recommended order: **T1/T4 timing → T2/T3 ownership → T5/T6 evaluation contracts → T7/T8 corpus and real-library baseline → broader automatic selection.** Independent measurement work can proceed alongside the correctness fixes; do not tune thresholds to compensate for their symptoms.

## Evidence and scope

- Reviewed **25 core commits**, 36 changed files, 3,074 insertions and 255 deletions from `c87fd7ce1a2ef86ab3ea952d5e39378fc4db8748` to `bd9f004`. Traced the changed planning, editing, analysis, enrichment, render, comparison and test paths. The supplemental `bcb7bce` adds a runner and two report files; it changes no application code or tests.
- Fresh local suite on `bd9f004`: **645 tests across 68 files passed**, reported duration **310.91 seconds**. All six package/application typechecks passed. Changed core files passed Prettier; all **366** domain exports have consumers. ESLint passes when excluding the separately arriving baseline runner, with four existing maximum-line-count warnings.
- Workspace-wide typecheck and lint fail in `tools/scripts/library-corpus-baseline.mts`, including after its commit as `bcb7bce`. T8 records these supplemental failures; they are not attributed to `bd9f004`.
- Focused probes reproduced T1, T2, T3, T4 at its rebuild boundary, T5 and T6. They used synthetic tracks, disposable catalogs, controlled process runners and direct planning functions. Temporary probe code and fixtures were removed. No owner music or library metadata was modified, and no real-library render was started by this review.
- The existing untracked `tools/reports/audio-regression-2026-10-11.json` was inspected, not regenerated. Remote CI and musical listening judgments were not independently rerun.
- Another implementation process added, ran and committed the real-library baseline during this review. Its code and artifacts were left untouched. The committed report was inspected; its audio was not independently auditioned or rerendered.

**Evidence labels:** reproduced means observed by an executable probe; code-traced means the control flow is established but a new integration regression is still needed. P1 items can produce incorrect audio or overwrite newer work. P2 items affect reliable evaluation and the remaining acceptance contract.

## What is actually complete

- **S1/S2:** the stale `recipeVersion` spread is removed on marked invalidation; transition/rate edits now invalidate more neighbors; resolved outgoing windows win over advisory manual cues. Preserve these fixes. Broad edit/proposal-to-render acceptance is still incomplete, notably T4.
- **S3:** the replacement placeholder-rate case, replacement explanation marker and richer before/after geometry diff are improved. Derived/pinned rate persistence is useful. A different application path now loses a supplied incoming rate, T4. Automation/gain and public response completeness remain followups.
- **S6:** the alternatives count now uses the brief's base eligibility, and the threshold/pinned-unmixable cases are addressed. This remains a whole-track supply policy, not interval-confidence selection.
- **S7:** saved rate bounds, effective-tempo comparison and actual-duration plumbing were delivered. The immutable resolved-context contract is still partial, T5.
- **S4/S8:** aggregate CLI failure accounting, cache-hit lifecycle, fresh hashes for ordinary previews and strict comparison freezing are real improvements. Retain the regressions. These do not finish S7's shared musical context or all coordinator-boundary validation.
- **S5:** terminal-row protection and a listen-encode takeover test exist. Actual catalog writes and later publication still escape the fence, T2/T3.
- **S9:** source identity checks, detailed probe output and a useful synthetic source-probe corpus were delivered. Coverage is wrong for abstentions, T6. Processed-deck regression testing and held-out automatic-plan evaluation remain open, T7.
- **Batch D:** a bounded incoming-window shift for structural conflict was added. This is one part of step 3, and it has T1's timing/evidence defects. Broader window/treatment selection, track reselection/backtracking, calibrated output recovery (step 4), and generalization evaluation remain open. Step 4 should not disappear from the status summary.
- **Listen peak retry and fixture cleanup:** bounded re-encoding still applies the output ceiling, and planning/render/analysis fixture cleanup improved. Preserve these. The delayed-publication test is a real coordinator boundary exercised with a fake process runner, not an actual delayed native encoder trial.

## T1 — P1, reproduced: automatic window recovery breaks alignment at unequal tempos

**Source:** [chooseTransition and buildEntries](../../packages/catalog/src/planning/timeline.ts), especially the recovery loop around lines 424–463; [renderer resolved-placement branch](../../packages/catalog/src/render/coordinator.ts).

The recovery loop adds `shiftBars * (240000 / targetBpm)` directly to `mixInMs`. That coordinate is source time, while the increment is output time. The source increment must account for the incoming rate or be derived from the incoming grid. The audio-end check makes the same conversion mistake. No alignment bake is repeated after shifting.

**Observed:** with a 174 BPM outgoing track and a 178 BPM incoming track, the 16-bar recovery moves the incoming start from **21,573.034 ms to 43,642 ms** at rate **174/178 = 0.977528**. The resulting projected beat residual is approximately **+162.0 ms**; a 170 BPM incoming track produces approximately **−163.2 ms**. The equal-tempo control stays within 1 ms. `buildEntries` preserves the shifted start and stamps `recipeVersion: 1`, so the renderer's resolved-placement branch skips corrective alignment. These are geometric reproductions, not listening judgments.

Two related problems need fixing with the same candidate-resolution change:

- Recovery copies the original window wholesale and changes only `mixInMs`. The observed start moves from bar 16 to bar 32 while `mixInBar` stays 16. Phrase shape, drop anchoring and continuity evidence can still describe the old interval and influence automation.
- `!shifted.conflict` accepts both measured compatibility and missing evidence. A fixture with conflicting measured bars followed by null measurements returns `phrase_mix` with `groove-syncopation-conflict-resolved` and no abstention marker. The abstention label still consults the original, conflicting measurement. A sparse region may be usable, but an unknown region is not evidence of a measured recovery.

**Implement:** resolve each shifted candidate through the shared source/output conversion, alignment, bounds, phrase/continuity and local-evidence paths. Recompute all dependent fields. Represent measured compatible, measured sparse and unknown distinctly; apply an explicit policy to each. Only stamp resolved placement after the final geometry is validated. Keep candidate search bounded and deterministic.

**Acceptance:** 170/174/178 BPM combinations, nonzero grid origins, 8/16/32-bar overlaps, forward/backward shifts, audio bounds and insufficient evidence. Test chosen window → persisted entries → render manifest, including the second join of a middle entry. Assert residual tolerance and evidence intervals, not just `windowShiftBars` and template type.

## T2 — P1, reproduced/code-traced: deposed analysis and enrichment still write evidence

**Source:** [analysis coordinator](../../packages/catalog/src/analysis/coordinator.ts), [key service](../../packages/catalog/src/analysis/key-service.ts), [enrichment coordinator](../../packages/catalog/src/enrichment/coordinator.ts).

The new analysis check after `await analyzeTrack(...)` runs after that method has called `storeResult`, applied analyzed metadata and inserted cues. It protects the later DSP stage row, not those earlier writes. Key analysis checks ownership before starting an asynchronous operation but does not carry the claim to its result writes. Enrichment likewise checks before `await enrichTrack(...)`; its HTTP lookups and writes occur inside that method without a later claim check.

**Observed:** delay A's loudness subprocess, let B acquire ownership and recover the job, then release A. Before release the analysis is absent. After release a **DSP 3.13.0 row exists and the track is marked complete**, while the job remains interrupted/failed and its DSP stage row is absent. The repository-level “no evidence” test never runs the analyzer, so it does not exercise this boundary. Key/enrichment exposure is code-traced.

**Implement:** separate computation from persistence. Pass an immutable claim context to a transaction that checks ownership and writes the complete result, canonical metadata, cues and stage state together. Cover key selection/results and enrichment records, including failure/status writes. Checking a local flag or querying immediately before unrelated writes is not a cross-process transaction. Review progress updates under takeover too.

**Acceptance:** delay decode/loudness/key/HTTP work independently, take over, write a distinctive winner result, release the old work, and assert every winner-owned row remains intact. Include cancellation, graceful shutdown under a still-valid claim, and recovery while a previous native process is alive.

## T3 — P1, reproduced: takeover during listen verification still overwrites the winner

**Source:** [listen verification callback](../../packages/catalog/src/render/coordinator.ts), around lines 1661–1675; [encodeListenFlac publication](../../packages/audio-renderer/src/listen.ts), around lines 165–174.

The new callback checks the claim before awaiting loudness measurement and hashing. Publication follows those awaits, then waits for an in-process publish lock, with no ownership check at replacement. The existing test pauses the encode before the callback; it misses takeover during verification or while waiting to publish. The lock itself is process-local.

**Observed:** pause A inside staged-listen loudness measurement, let B acquire/recover, place a recognizable winner artifact at the shared listen path, then resume A. The job remains interrupted/failed, but the winner file is replaced by A's **192,044-byte fake-runner output**. This exercises the actual coordinator and filesystem publication path; the audio bytes are synthetic.

Preview masters also use a shared cache-key path and are published by `renderMix` before the terminal fence. The comment that the master is harmless because it is job-ID-named only describes full masters.

**Implement:** design publication around immutable job/generation artifacts and an ownership-conditioned authoritative pointer, or an equivalent cross-process publication protocol shared with takeover. A recheck after measurement is necessary but alone leaves a check/rename race. Cover named listen files and preview cache publication; keep generation staging cleanup contained and owned.

**Acceptance:** takeover during encode, measurement, checksum and publication-lock wait, with a winner artifact already present. Assert winner bytes and metadata survive. Exercise separate process owners for the final publication protocol, not only two runtimes sharing the same JavaScript lock.

## T4 — P1, reproduced at rebuild boundary: applying a transition can discard its incoming rate

**Source:** [applyTransition](../../packages/catalog/src/service/plan-editor.ts), around lines 242–269; [rateFromPrior and retained-transition branch](../../packages/catalog/src/planning/timeline.ts), around lines 740–789.

The editor accepts explicit outgoing/incoming playback rates. When callers also supply new transition parameters, those parameters commonly lack the internal `incomingTrackId` stamp. The new rate-preservation logic therefore treats the incoming rate as untrusted and initializes it to 1. The outgoing transition already exists, so the chooser branch that would rederive the rate is skipped.

**Observed:** rebuilding exactly that post-application state for a 178 BPM incoming track changes its supplied **0.977528** rate to **1.0**, while preserving the transition's **174 BPM** target. This was reproduced in `buildEntries`; the path from the public editor to that state is code-traced. Fixing replacement rate derivation must not make proposal application discard its own resolved rate.

**Implement:** distinguish an applied, jointly resolved transition from both an untrusted replacement placeholder and an intentional user rate pin. Carry pair identity and rate provenance explicitly through application; do not infer authority solely from whether a free-form parameter contains a track ID. Invalidate/re-resolve both affected neighbors when applying rates/windows. Do not introduce a requirement to save or approve recipes.

**Acceptance:** apply an actual `planTransition` result with fresh parameters to a two-track and a middle-track join; reload and render. Check both effective tempos, exact requested windows and neighboring joins. Also cover parameters omitted, same-value rate edits, and the previous S3 replacement regression.

## T5 — P2, reproduced/code-traced: feasibility still changes the interval it claims to validate

**Source:** [proposal construction](../../packages/catalog/src/planning/transition-planner.ts), especially lines 184 and 287–330; [comparison snapshot ordering](../../packages/catalog/src/service/inspection.ts), around lines 321–376.

**Observed:** on 200-second tracks, a stored 22,069 ms overlap beginning at outgoing **190,000 ms** and incoming **199,000 ms** returns both aligned templates as **feasible, no blockers**. The outgoing interval is silently reconstructed as **177,931–200,000 ms**; the incoming interval contains only **1,000 ms**. The duration fix does not ensure that either exact requested interval fits. Full trimmed entry bounds still cannot be expressed in `savedWindow`.

Other S7 remainder is still present: crossfade drops the saved context and evaluates a fresh 30-second window; missing bar counts also switch to fresh proposals; feasibility is computed from live evidence before the asynchronous freeze; preview enqueue performs further live readiness validation. A common hash does not make those decisions share a snapshot. Strong hashes are an identity fix, not a replacement for this geometry/evidence contract.

**Implement:** freeze one resolved join context before feasibility evaluation. Include exact entry bounds, overlap duration, effective rates/rate regions and musical evidence. Validate those values without moving them. Give “search for another window” a separate operation. Use the context for all supported treatments, including crossfade and legacy plans, and separate live source availability checks from frozen musical eligibility. Validate supplied request/plan identity at the render coordinator boundary.

**Acceptance:** the reproduced short incoming interval must be rejected; outgoing overrun must not silently become an earlier interval. Add edited trims, unequal tempos, non-default durations, crossfade-origin plans, missing bar counts, and controlled edits during freeze. Compare proposal context, frozen job and actual manifest.

## T6 — P2, reproduced: coverage counts abstention as measured

**Source:** [source-deck probes](../../packages/catalog/src/render/deck-probe.ts), around lines 240–248.

`measured.add(join.order)` executes unconditionally after `verifyDeckAlignment`, including when its verdict is `unmeasured`. A zero-onset fixture returned **status unmeasured, attempted [0], measured [0]**. Consumers cannot use the new coverage fields as documented.

**Implement:** define eligible, identity-verified, attempted, measured and abstained outcomes separately. Add to `measured` only when an actual timing judgment is available. Keep failure reasons and raw/locked counts on decode failures, identity failures and sparse cases where available. Make legacy/no-hash evidence visibly distinct from verified evidence. Keep the checks advisory until calibrated.

**Acceptance:** off, non-aligned, missing source, hash mismatch, decode failure, empty/sparse/ambiguous evidence and measured pass/review/fail. Assert the sets and their denominators, not just the presence of the new fields. Uncertainty must remain uncertainty through CLI/MCP and baseline reports.

## T7 — P2, code-traced: the corpus is a source-probe scaffold, not processed-output validation

**Source:** [audio-regression-corpus.mts](../../tools/scripts/audio-regression-corpus.mts) and [deck-probe scope](../../packages/catalog/src/render/deck-probe.ts).

The eight cases create synthetic WAVs, hand-build a two-entry plan, render it, then classify `sourceDeckProbe` results. Every deck uses playback rate 1. The verifier reopens the original source files. This is useful evidence about source/grid timing, but it cannot establish that Rubber Band processing, join-only rate regions, splices, automation or the final blend preserve timing. It also does not exercise automatic plan generation merely because the temporary catalog contains no approval history.

The committed script has no real-library input mode; only its synthetic cases run. Its documented `--json` switch is not parsed. Do not tell an implementation agent simply to run this script “against the actual library” without a separate implemented runner.

The classification/reporting also needs care:

- An unexpected `unmeasured` outcome is labeled `FALSE-PASS` even for an expected aligned pass. Preserve abstention as a separate verdict and report defect escape separately from a literal false pass.
- Any status other than `pass` or `unmeasured`, including a missing `none` status, can count as a true positive when a defect was expected. Render/infrastructure failures are separately mislabeled verifier false failures. Use an exhaustive status model and an infrastructure-error bucket.
- Reported measured offsets are not asserted against injected offsets. The saved 140 ms case reads **123.1 ms** with only **15 locked incoming onsets**, so “offsets accurate” is too broad. Store offset/drift error and acceptable measurement tolerance independently from defect detection.
- Reports overwrite by UTC date and omit exact code/native-tool versions and frozen case identities. There is no explicit regression-exit policy. Preserve unique runs, link known failures, and distinguish a retained known failure from a newly introduced one.

The half-beat case is a **sub-beat lock-window blind spot**, not evidence that bar-phase inference alone will fix it. Filtering against a ±100 ms prior grid removes the evidence of the injected ~172 ms error before comparison. Whole-beat phase equivalence and bar/downbeat structure are different questions. A naive wider window may introduce musical false positives; evaluate an independent phase candidate/correlation method against offbeat and sparse controls before deciding.

**Implement:** retain this source-probe suite and add a processed-deck suite that captures the renderer's actual prepared audio and source/output time map. Add final-blend boundary/dynamics checks separately. Include non-unit and unequal rates, rate-region splices, edited windows, negative controls injected after preparation, and musical sparse/vocal/offbeat controls. Prove that a deliberately corrupted processed deck fails even when its source and frozen grid are correct.

**Acceptance:** stable fixture identities and numeric tolerances; explicit outcome taxonomy; full measurement coverage/error report; a known-bad processing mutation caught by the harness; deterministic report comparison with a documented exit policy. Source-probe checks remain useful but cannot close this acceptance alone.

## T8 — P2, committed runner/report: finish the real-library baseline before using it for tuning

A separate [library baseline runner](../../tools/scripts/library-corpus-baseline.mts) and [first report](../../tools/reports/library-baseline-2026-10-11.json) arrived during this review and were committed as `bcb7bce`. This is the appropriate direction, and the report already provides actionable cases. The files were left untouched.

**Reported pilot:** two 15-minute briefs, eight aligned joins, five probe passes, two reviews and one fail. Both renders succeeded, but **both `checkOk` values are false**. There were zero window recoveries, so this pilot does not exercise T1. Preserve these two cases before reanalysis or replanning:

- **Girl In The Fire → All Fall Down - Fred V & Grafix Remix:** stored-grid residual **120 ms**, source-probe offset approximately **108.3 ms**, probe fail.
- **Witchcraft → Atmosphere:** stored-grid residual **60 ms**, source-probe offset approximately **49.7 ms**, probe review.

Trace each case from selected windows and alignment provenance through the frozen request and manifest. The report lacks those identities/windows, so it cannot establish the root cause by itself. These are technical failure signals, not new listening verdicts. Do not classify either as the recovery-shift bug, or change a groove threshold to hide the residual.

Remaining runner/report work:

- **Build gates:** tools typecheck fails on an unused `rm` import and nonexistent `CreateSetPlanResult.partialReasons`; ESLint also fails. Both typecheck failures were confirmed after `bcb7bce`. Fix the actual result-contract handling rather than casting it away.
- **Catalog snapshot:** the draft copies only the database file with `copyFile`, while [openDatabase](../../packages/catalog/src/db.ts) uses WAL. A live file copy can miss committed WAL contents and is not the promised reproducible snapshot. Use SQLite's consistent backup mechanism. Prepare the copy with workers disabled; remove copied pending jobs/ownership state before activating only the intended corpus work.
- **Holdout protocol:** hashing observed ordered pairs creates a repeatable partition, but does not itself prevent tuning on the same tracks, listening labels or aggregate held-out results. Freeze the baseline before tuning; identify tuning/held-out cases and reserve track-disjoint coverage where supply permits. State clearly when only a pair holdout is practical.
- **Identity and determinism:** the report should retain plan/entry/transition/track IDs, content/evidence identities, brief, versions and exact windows. Checking only the sequence of track IDs misses changed rates/windows/treatments. Compare normalized resolved plans too. Artist diversity must use track artist identity; splitting track titles on `" - "` does not measure it.
- **Audition and retention:** emit usable absolute paths, join IDs and a clear isolated-catalog/report label workflow. Do not direct feedback for scratch plans into the owner's original catalog. Keep required listen artifacts intentionally, but give each run an owner marker and retention/cleanup policy; date-only files and unmanaged OS-temp retention will recreate the earlier scratch problem.
- **Baseline claims:** distinguish measured defects, uncertain probes, musical listening labels and suggested intervention. A probe review is not an observed user repair. Report eligible supply and successful-plan coverage alongside quality, variety and runtime. A cold history still uses the owner's existing tags, exclusions and analysis; describe that scope honestly.

**Acceptance:** a clean run from a consistent isolated catalog, no unintended copied job execution, reproducible resolved plans, all artifacts/labels addressable, and explicit tuning/held-out results. Reproduce and explain the two failed-check cases before policy tuning. Eight joins establish pilot feasibility; they do not establish a reliable population pass rate or justify new hard quality gates.

## Remaining code-quality and documentation work

Keep this bounded and tied to the fixes:

1. Extract a resolved-candidate contract and a claim-conditioned persistence/publication boundary as T1–T5 require them. Avoid separate timing or fencing implementations in each caller. The four line-count warnings identify pressure, but moving code without changing these contracts does not fix the defects.
2. Finish the existing public repair response schema in [MCP planning tools](../../apps/mcp-server/src/tools/planning.ts). It still omits entry/transition IDs, the richer effective diff and edited explanation. Its description promises exact treatment preservation more broadly than the current diff establishes. Include gain/automation changes when claiming full treatment equality; do not build optional protected-recipe features to do this.
3. Keep the [stored explanation recovery](../../packages/catalog/src/set-plan-repository.ts) issue explicit: recommending clone-with-replan is not a working recovery route when clone must first parse the malformed explanation. Provide a tested recovery path or truthful remediation.
4. Carry forward frozen validation metadata, fair final-gain comparisons, and legacy freshness policy from the previous review. They were not closed by the newer commits. Test the intended contracts while changing the relevant modules.
5. Scratch cleanup improved in three suites, but the newly added ownership-test roots still often register only `close()`. Cover those roots and operational generation staging. In the pool, replace per-suspect `catalog.find(...)` with a map while next editing it; the eligibility logic improved, but that rejection-report loop remains quadratic.
6. Keep one active plan pointer. Mark dated reviews and ledger sections as historical; do not append another blanket “everything complete” beneath contradictory summaries. Preserve the useful reported listen-peak diagnosis and the unchanged ceiling check. Qualify root-cause language if it goes beyond the captured evidence.
7. Correct scope terminology in [rendering](../rendering.md), [beatmatching followups](../beatmatching-followups.md) and source comments: source probes versus processed output, sub-beat versus whole-beat/bar phase, measured versus abstained. Remove stale statements that all placement errors are healed by rendering: normally generated resolved transitions intentionally bypass re-alignment.

This review updates the README pointer and marks the 11 October review historical. Detailed canonical behavior changes should be documented with their implementation commits; preserve past listening evidence and do not reorganize the owner's music as documentation cleanup.

## Delivery plan

### 1. Restore automatic timing correctness

Implement T1 and T4 separately, sharing fixtures and the resolved-candidate contract. Add full manifest checks and preserve S1/S2/S3's working subcases. Finish T5's exact geometry contract before expanding candidate enumeration.

**Exit:** every emitted aligned candidate uses the intended coordinates/rates and has evidence for that exact interval; uncertain candidates cannot masquerade as measured recoveries. Applying a proposal preserves its effective tempo.

### 2. Close actual persistence and publication races

Implement T2 and T3 at the side-effect boundaries. Retain terminal-row checks as defense in depth. Exercise takeover during each delayed stage, with the winning result already present, and then test the cross-process protocol.

**Exit:** late work cannot alter the winner's evidence or audio, including preview cache artifacts, while legitimate graceful shutdown still works.

### 3. Make the baseline trustworthy

Fix T6 and T7's reporting/measurement model; finish T8's isolated runner and build gates. Preserve and investigate the first pilot's two failed-check cases, then expand to a representative frozen corpus with explicit holdouts. Keep source diagnostics, processed-deck correctness, final-output defects and musical judgments separate. Record actual coverage, abstention, render/check failures and runtime before setting targets.

**Exit:** the baseline catches known technical defects, can be reproduced, and measures musical acceptance without approved-pair recall or selective omission of failed plans.

### 4. Broaden automatic selection from observed failures

Prioritize the failure classes the baseline reveals: local grid confidence/drift, drum compatibility, sparse energy handover and vocal collision. Reuse existing analysis before adding models or expensive stages. Evaluate multiple entry/exit windows, phrase lengths and existing treatments using the same resolved context.

Add bounded track reselection/backtracking when a pair cannot meet quality and brief constraints. Revalidate both neighbors and downstream rate dependencies. Calibrated processed-output checks may trigger bounded regeneration for demonstrably detectable failures; retain uncertainty instead of inventing a pass or retrying indefinitely. Explain when the available music cannot satisfy the brief.

**Exit:** held-out automatic mixes improve while coverage, variety and runtime stay within agreed limits. Compare with the frozen baseline, including unsuccessful attempts. No user-curated join library is required.

## High-value features after these steps

- **Usable mix intervals with local confidence:** recover trustworthy regions from otherwise suspect tracks, keeping unknown evidence distinct from observed sparsity or measured compatibility.
- **Automatic drum/vocal/energy collision avoidance:** select better windows and treatments before introducing stems or additional models; require incremental corpus benefit.
- **Quality-aware variety:** generate different sets within the same evaluated quality standard, with bounded search and honest constraints.
- **A concise automatic mix report:** show meaningful limitations and the choices that resolved them, supported by the actual artifact. Avoid making a diagnostic approval checklist the normal user workflow.

For each implementation batch, attach the acceptance evidence to the boundary it promises, run the relevant regressions and required repository gates, and record the final SHA and exact results. “Tests pass” and “the acceptance contract is complete” must remain separate claims.
