# Implementation review and recommended next steps — 11 October 2026

> **Status: ACTIVE BACKLOG** (updated 12 October 2026). Delivery per the ledger:
> Batches A (S1–S3, S6, S7 stage 1), B core (S4, S5 evidence + publication gates
> including the delayed two-runtime trial, S8), C (S9 both stages — probe identity/
> coverage plus the synthetic-controls regression corpus), and Batch D step 3
> (whole-phrase window recovery) are fixed/delivered with commits and failing-first
> regressions. Open: Batch B scratch lifecycle, Batch D steps 1–2 and 5, and the
> documentation reconciliation this update belongs to. The corpus found one real
> verifier defect (half-beat false abstention) — recorded in beatmatching-followups.

## Recommendation

Do a bounded correctness pass before the next feature wave. The implementation delivers real improvements, but the claim that all acceptance criteria from the 10 October review are complete is too broad. Several failures remain reproducible on the current HEAD, including the edited-window bug the latest patch intends to fix.

The product goal is a crate that automatically produces good joins from the available music and the user's brief. Users should not have to audition candidates, collect approved joins, or repair each generated set. Prioritize consistent generated geometry, reliable analysis/rendering evidence, an audio regression corpus, and better automatic window/treatment/track selection. Correct existing editing and comparison bugs without making a larger manual workbench the next product milestone.

This is a new implementation handoff, not an application change. It supersedes the completion assessment in the [implementation ledger](implementation-ledger-2026-10.md) and the status header of the [10 October review](implementation-review-2026-10-10.md). Preserve those documents as historical evidence; reconcile their status pointers in the documentation task below.

## Product direction — automatic quality first

This revision incorporates the owner's clarification on 11 October: saving good joins must not be a prerequisite for getting a good mix.

Keep the resolved transition details inside each generated plan: source windows, rates, overlap, treatment and evidence identity. These are internal execution records that make preview, rendering, diagnostics and reproduction agree. The `recipeVersion` field discussed below belongs to that implementation contract; fixing it does not require a user-facing saved-join library.

A library of manually approved transitions is a separate, optional preference feature. Defer approved-treatment recall, protected-join repair and an expanded join workbench. Preserve compatibility with existing data and make existing operations truthful; do not delete stored plans or remove useful controls as part of this reprioritization.

The automatic pipeline should assess the actual overlap, compare multiple feasible windows and treatments, and choose another window or track when it cannot support a good join. An arbitrary pair of tracks need not be made compatible. If the available music and hard constraints cannot support a satisfactory plan, report that limitation clearly rather than silently relaxing the quality standard or asking the user to curate a permanent set of acceptable pairs.

Listening feedback should improve generalizable analysis and selection rules. Use accepted and rejected examples as evaluation evidence, including unseen pairs, rather than making exact-pair approval the mechanism that produces acceptable output. Human listening remains part of development and calibration; routine users should not have to approve every transition.

## Review baseline and evidence

- HEAD: `c87fd7ce1a2ef86ab3ea952d5e39378fc4db8748`.
- Compared against `98847dadc54ff392ccd0cf094ff471395d2acdc9`: **22 commits**, 60 changed files, 3,217 insertions and 751 deletions. The supplied account describes approximately 25 commits; Git’s reachable comparison is the precise scope here.
- Reviewed the supplied implementation account, changed source/tests/docs, and the affected callers through planning, editing, job execution, comparison, CLI/MCP, and persistence.
- Local Windows checks: **628 tests in 67 files passed**, in **259.59 seconds**. Typecheck, lint, export checks and repository formatting passed. Lint retains three maximum-line-count warnings; export checking found 366 consumed domain exports.
- Focused executable probes used pure functions, in-memory catalogs, controlled command/service doubles, and two disposable synthetic-file fixtures. The fixtures were removed. No private music was rendered or reanalyzed, and no application source or library metadata was modified.
- Remote CI and the reported listening calibration were not independently rerun. A local green suite establishes the existing checks, not the missing scenarios below.

**Evidence:** “reproduced” identifies an executable observation in this review; “code-traced” identifies a concrete control-flow gap requiring an integration regression. P1 is correctness that should precede more automatic mixing; P2 is the next reliability/product-contract batch; P3 is optional or measurement-dependent. New IDs S1–S9 avoid confusing these findings with the prior R1–R14.

## Reconciliation of the previous findings

The following fixes should be retained:

- **R3 incoming dead-intro precedence:** the original probe now resolves an incoming entry at approximately **22,069 ms** and keeps **22,069 ms** in the final entries. The incoming half of the fix works. The outgoing half remains open, S2.
- **R5 probe coordinates:** source onsets and projected grids now use probe-local time. Preserve this correction and the extraction into `render/deck-probe.ts`. Measurement coverage and processed-output validation remain separate work, S9.
- **R8 execution hash:** hydration now performs a fresh full-content SHA read. The preserved-timestamp execution regression is valuable. Cache reuse and tolerant comparison freezing still bypass that guarantee, S8.
- **R9 frozen absence:** present canonical snapshots own null key/energy values, and absent drop/audio-end values remove live map entries. This addresses the demonstrated null-fallback case. Broader mutable validation metadata remains a scoped followup.
- **R10 shared freshness:** `dspFreshness` is used by the coordinator, workflow and stale selection. This is the right shared boundary; preserve its reason codes and pending/missing-stage coverage.
- **R7 recorded history:** artist-use counts persist across modes, replay-of-replay has a nonempty-history test, and SQL applies eligibility before paging. These specific defects are resolved. Replay still means replanning with frozen history under the supplied brief/current environment; a complete immutable planning snapshot is a separate feature.
- **R2 worker registration and error detail:** comparison now starts a worker with `--wait` and carries per-variant errors. Aggregate success and cache-hit lifecycle remain wrong, S4.
- **R13 explanation schema:** `edited` was added to the public schema. Replacement still fails to generate that marker in the reproduced case, and the repair response schema remains incomplete.
- **R12 job-row completion:** `claimed_by` and status predicates block stale terminal updates. The fence does not yet protect all analysis/enrichment writes or audio publication, S5.
- **R14 comparison:** saved-window structural eligibility and a shared request are substantial progress. The evaluated geometry and evidence still do not have a complete common contract, S7–S8.
- **R1 repair:** the diff now reports both neighboring joins, but explicit protection was removed rather than fulfilled. Treat this as adjacency-preserving replacement. Tempo correctness and honest effective-treatment diffs remain required, S3. Protected approved-join repair was not delivered, but is now deliberately deferred under the automatic-quality direction rather than a release prerequisite.
- **R11 filtering:** missing/excluded-ID filler and all-suspect supply are handled more deliberately. The alternatives predicate is still different from actual eligibility, S6.
- **Documentation/extractions:** the README entry point, policy ownership, relative links, experiment directory, inspection module and deck-probe module are useful. Completion labels need a narrower evidence basis, and some requirements disappeared from the remainder list.

## S1 — P1, reproduced: an edited transition still carries `recipeVersion: 1`

**Prior finding:** R4. **Source:** [entry rebuilding](../../packages/catalog/src/planning/timeline.ts), [editor invalidation](../../packages/catalog/src/service/plan-editor.ts), [render alignment](../../packages/catalog/src/render/coordinator.ts).

The patch conditionally omits a new `recipeVersion` property when `alignmentInvalidated` exists, but first spreads `baseTransition.parameters`. That spread already contains `recipeVersion: 1` from every normally built plan. Omitting a later assignment does not delete it. The editor removes offset/mode/period/onset-lock keys, but not this version flag. The renderer then takes its version-1 early exit and does not apply the recomputed placement.

**Observed:** a real in-memory `updateSetPlan({ setTrim: ... })` returned both `alignmentInvalidated: "window-edited"` and `recipeVersion: 1`. A separate direct rebuild reproduced the same result after moving the incoming start by 140 ms.

**Implement:** make resolved versus invalidated placement mutually exclusive. Either remove the prior resolved marker explicitly before rebuilding or replace it with a dedicated placement state that the renderer validates. Do not rely on object-spread omission. Audit trim, rate, duration/type and proposal-application edits together: several of those paths do not invalidate affected neighbor geometry at all. Once recomputed, source windows and provenance must describe the same placement.

**Acceptance:** begin with a normally generated and persisted plan, not a hand-built transition lacking the version flag. Edit the incoming trim, reload, render/preview, and assert actual manifest placement/residual. Test the no-op case, missing preexisting pins, both sides of a middle entry, and non-unit rates. Verify that already resolved generated transitions still avoid the original double-offset bug. A test that checks only that offset keys disappeared does not close this issue.

## S2 — P1, reproduced: outgoing manual cues still undo the alignment correction

**Prior finding:** R3 outgoing half. **Source:** [buildEntries](../../packages/catalog/src/planning/timeline.ts) and [bakeWindowAlignment](../../packages/catalog/src/planning/windows.ts).

The scoped rollback deliberately kept `manualMixOutMs` ahead of the resolved pair window. The original failure still reproduces: at 174 BPM, a manual mix-out at bar 64 plus 140 ms is **88,415.862 ms**. The chooser resolves **88,276 ms**, records a **140 ms** alignment correction, and places the incoming at approximately **22,069 ms**. Final entry construction restores outgoing mix-out to **88,416 ms** while retaining that incoming position and `phrase_mix` treatment.

The reported Linux first-mix failure is a reason to isolate the interaction, not evidence that this final geometry is correct. Preserving a deliberate manual cue can be valid, but its counterpart and alignment provenance must be resolved consistently.

**Implement:** define explicit manual-cue semantics. If the cue is a hard pin, preserve it and realign the counterpart or return a conflict. If it is an advisory candidate, keep the resolver’s corrected outgoing position and explain the adjustment. Carry one resolved pair result through final entry construction. Do not simply reinstate the broad precedence swap without understanding the first-mix case that motivated its rollback.

**Acceptance:** run both the 140 ms outgoing-cue fixture and the now-working dead-intro fixture through final entries and manifests. Include aligned versus crossfade joins, the last incoming entry, phrase/downbeat offsets, and unequal BPM. Preserve owner-pinned intent explicitly. Reproduce and reduce the Linux first-mix interaction with captured fixtures, versions, seed and check result.

## S3 — P1, reproduced: repair can preserve the wrong rate and stale explanations

**Prior findings:** R1/R4/F7. **Source:** [repairSetPlan](../../packages/catalog/src/service.ts), [replaceTrack handling](../../packages/catalog/src/service/plan-editor.ts), [rate propagation](../../packages/catalog/src/planning/timeline.ts).

Replacement creates an existing entry with `playbackRate: 1`. Rebuilding treats a truthy existing rate as authoritative and suppresses the newly selected incoming rate. The old chain’s other rates also remain pinned without being distinguished from deliberate manual rate overrides.

**Observed:** replacing a track in a four-entry 174 BPM plan with a 178 BPM track produced incoming target **174 BPM** but replacement rate **1.0**, rather than **174 / 178 = 0.977528...**. Its outgoing join targeted **178 BPM**. The result contained two `phrase_mix` transitions with inconsistent effective tempo. The stored explanation’s `edited` field was still absent.

The revised repair diff compares transition ID/type only. It cannot substantiate “exact treatment preserved” when source windows, rates, overlap or automation change. It computes the diff after saving. Removing `protectedTransitionIds` also means there is no operation that rejects replacement of a requested protected neighbor. Old CLI `--protect` input is no longer read; silently ignoring a formerly meaningful protection flag is especially undesirable.

**Implement:** distinguish derived rates from intentional rate pins. Resolve all affected tempo/geometry dependencies before saving, including the join after the replacement and any necessary chain propagation. Capture changed-join provenance before clearing transitions. Compute a candidate revision and an effective-treatment diff before committing. Describe the existing operation as replacement and reject obsolete protection arguments rather than ignoring them. Return stable entry/transition IDs and correct incoming/outgoing reason labels. Check whether automatic candidate replacement or backtracking shares these paths and apply the same consistency contract wherever it does; do not build a protected-recipe feature to close this correctness finding.

**Acceptance:** replacement at the start, middle and end with different native BPM; same-track no-op; incompatible constraints; and automatic replanning/reselection where it shares rate propagation. Assert effective tempo and rendered join geometry, not just transition type. A failed revision must leave the stored plan unchanged. Any claim that an unaffected join was preserved must compare its effective geometry and treatment. Persist an honest edited explanation and include rate/window/automation changes in the diff. Obsolete protection flags fail clearly. No user approval library is required for these tests.

## S4 — P2, reproduced: comparison reports success despite enqueue failures

**Prior finding:** R2 remainder. **Source:** [CLI comparison](../../apps/cli/src/commands/transitions.ts) and [comparison service](../../packages/catalog/src/service/inspection.ts).

The CLI builds `started` from variants with a job ID and evaluates success only over that list. Enqueue failures have no job ID and disappear from the calculation. `started.length === 0` also bypasses the failure branch entirely.

**Observed using the actual command handler with controlled service results:** all variants failing enqueue returned **`ok: true`, exit 0**. One successfully completed preview plus an enqueue failure also returned **`ok: true`, exit 0**.

The service discards `startPreview`’s returned status and output path. A cache hit that is already succeeded is reported as queued with a null artifact. A controlled cache-hit response reproduced this for every variant. `--wait` usually repairs the state later, but MCP and non-waiting clients see an incorrect lifecycle.

**Implement:** evaluate all attempted/failed variants; distinguish intentionally infeasible/not-started alternatives from failed attempts. Define no-runnable-variant behavior. Preserve returned status/artifact/error data on cache hits. Classify wait errors accurately instead of labelling every exception a timeout. Keep partial results available with a nonzero exit when appropriate.

**Acceptance:** real CLI dispatch/worker integration plus command-level cases for all enqueue failures, success plus enqueue failure, runtime failure, cancellation, timeout, all infeasible, and cached success, with/without `--wait`. Parse the MCP payload too. Existing service tests for per-variant error fields do not test aggregate CLI success.

## S5 — P1, code-traced: worker fences protect terminal rows after side effects have happened

**Prior finding:** R12. **Source:** [analysis execution](../../packages/catalog/src/analysis/coordinator.ts), [enrichment execution](../../packages/catalog/src/enrichment/coordinator.ts), [render execution](../../packages/catalog/src/render/coordinator.ts), [mix publication](../../packages/audio-renderer/src/mix.ts), [listen publication](../../packages/audio-renderer/src/listen.ts).

The new repository conditions correctly reject a stale `markSucceeded`. However:

- Analysis writes DSP rows, analyzed metadata, cues and stage results inside the track loop before checking owner loss at final job completion. Key analysis also persists independently. The loop checks cancellation/stopping, not whether takeover marked the job interrupted.
- Enrichment applies published metadata and writes enrichment records before its final ownership check.
- `renderMix` publishes the master/cache output before the coordinator checks its completion token. Full renders also publish the named listen file before that check. Preview paths are cache-key based, and named listen paths are shared by plan name, so stale publication can affect another job’s artifact even when the stale terminal row is rejected.
- `currentToken()` reflects the local owned flag until heartbeat detects loss; the current code passes the current token at completion rather than carrying a validated, immutable claim context through every side effect.

The fencing regression directly calls the job repository after takeover; it does not run a delayed analyzer, enrichment response, or encoder to the actual publication boundary.

**Implement:** capture a claim context at claim time and make writes conditional on its validity. Use a transaction that verifies job/owner generation alongside each persisted analysis/enrichment result, including metadata, cues, stages and key results. Abort deposed work promptly where practical. Publish audio from job-specific staging only through an ownership-aware publication step; the terminal DB fence remains a second defense. Ensure cross-process publication semantics, not only an in-process lock. Review progress/cancellation writes as well.

**Acceptance:** two runtimes with controlled delayed work. Let A start, let B take ownership/recover/retry, then let A finish. Assert B’s analysis/metadata/stages and named listen/cache files remain intact, not merely B’s terminal job status. Include close while still legitimately owning the claim, failed native subprocesses, and cancellation during publication. Never broaden cleanup patterns to compensate for orphaned stale work.

## S6 — P2, reproduced: suspect filtering still counts ineligible alternatives

**Prior finding:** R11. **Source:** [planning pool](../../packages/catalog/src/planning/pool.ts).

The replacement count filters missing files, excluded IDs, unmixable tags, rating exactly 1, and suspicion. It does not apply excluded artists, genres, BPM bounds, the actual `minRating`, descriptor filters or tempo-stability eligibility. It also rescans the catalog inside each suspect candidate’s predicate.

**Observed:** 13 otherwise usable suspect tracks produced a pool of **13**. Adding 12 non-suspect tracks whose artist was explicitly excluded changed the pool to **0**. Those rejected tracks counted as the alternative supply that caused all suspect tracks to be dropped. There is also a threshold interaction to cover: the suspect policy admits 12 alternatives as sufficient while the later pool guard rejects pools of 12 when the raw catalog is larger.

**Implement:** compute a shared base-eligibility result once per filter/relaxation level, then apply the suspect policy to that usable population. Define the minimum usable supply consistently with the later planner guard and required pins. Record relaxation/admission reasons. Keep owner exclusions distinct from advisory evidence, and specify whether explicit pins can override `unmixable`; the current “unconditional” comment and pin readmission still disagree.

**Acceptance:** excluded-artist/BPM/genre/rating/descriptor/unstable filler cannot change eligibility. Test all-suspect libraries, exactly-at-threshold supply, descriptor relaxation and pinned tracks. This remains a supply policy using a suspect flag, not confidence-aware safe intervals; label it accordingly.

## S7 — P2, reproduced/code-traced: resolved-window feasibility still validates different values

**Prior finding:** R14. **Source:** [transition proposal evaluation](../../packages/catalog/src/planning/transition-planner.ts) and [comparison context construction](../../packages/catalog/src/service/inspection.ts).

`propose` validates freshly derived playback rates **before** replacing them with saved rates. The saved rates are not subsequently validated. A direct proposal probe with saved outgoing/incoming rates **1.2**, no excessive-tempo override, and 174 BPM returned both aligned templates as **feasible with no blockers**.

Other traced inconsistencies remain:

- Missing `mixOutMs` falls back to `sourceEndMs`, rather than the outgoing overlap start derived from end, actual duration and rate.
- The saved context has a bar count but not the actual transition duration or full trimmed source bounds. Proposal duration is rederived from bars/BPM; outgoing positions are clamped/reconstructed. This can evaluate another interval for an edited or legacy join.
- Crossfade deliberately drops `savedWindow`, and a no-bar-count join uses fresh proposals while artifacts still render the saved join. Labelling the mismatch is useful but does not fulfill fixed-window feasibility.
- Feasibility is computed against live evidence before the asynchronous freeze, while each enqueue revalidates live plan/analysis. Sharing one request across variants does not make these earlier/later decisions part of that same snapshot.

**Implement:** use one immutable resolved join context across candidate evaluation, the generated plan, comparison and rendering. For an existing plan, construct it from that plan and its selected evidence first. Include exact source bounds, output overlap, rates/rate regions, cue intent, gain reference, and identity. Evaluate every treatment against those exact values; fail invalid geometry instead of quietly clamping into a different proposal. Validate saved rates after selection, including effective-tempo agreement, and keep “choose a new window” as a separate operation. Automatic search may evaluate many such contexts, but each candidate's score, feasibility and render must describe the same context. Readiness checks should distinguish live file availability from frozen musical eligibility.

**Acceptance:** saved 20% rates without an override; valid unequal native tempos; missing/stale cue parameters; non-default durations; short trimmed incoming/outgoing regions; crossfade-origin plans; and controlled live edits during freeze/enqueue. Every blocker and artifact must refer to the displayed context. Compare actual manifests and job requests, not only a 64-character identity string.

## S8 — P2, reproduced: cache hits and tolerant freezing bypass strong source identity

**Prior finding:** R8, plus the final comparison-context change. **Source:** [freeze/cache/verification paths](../../packages/catalog/src/render/coordinator.ts).

There are two distinct remaining cases:

1. **A cache hit never reaches fresh execution verification.** Queue-time `sourceHashForTrack` still caches by path, size, mtime and head/tail fingerprint. In a disposable fixture with a seeded succeeded preview cache entry, changing a middle byte while preserving size, mtime and head/tail bytes produced the same cache key. The next preview returned **succeeded**, the old artifact path, and a new cloned job ID. It never reached the corrected hydration hash check.
2. **A newly frozen comparison may have no strong hashes.** `tolerateUnreadableSources` catches any hash error and returns null. The comment promises enqueue will reject, but enqueue checks current cheap fingerprints/readiness, not completeness of the supplied snapshot. With an injected transient full-content hash failure and otherwise readable fixture files, `freezeRequest(..., { tolerateUnreadableSources: true })` followed by the actual `startPreview` queued a new job with **both source hashes null**. Hydration treats such a request as weak legacy input.

**Implement:** validate strong current source identity before cache reuse, using a cache policy that cannot equate the demonstrated interior edit. Keep strict snapshot construction separate from per-variant failure presentation: capture hash errors as failed variants without enqueuing a weakened new request. Explicitly version/mark legacy weak requests; do not infer legacy status from a missing field on a newly constructed request. Validate supplied request/plan identity at the coordinator boundary. Consider freezing only the relevant join inputs for previews, while preserving full-plan provenance separately.

**Acceptance:** unchanged cache reuse remains fast; preserved-timestamp interior changes invalidate/reject old cache reuse; transient hash failure followed by successful readiness cannot queue weak input; normal strong execution remains protected. Test identical-byte relocation and intentional legacy compatibility separately. Retain the existing NTFS whole-millisecond timestamp fixture so this regression actually exercises the cache hit.

## S9 — P2, unfinished acceptance: verify rendered audio and expose measurement coverage

**Prior finding:** R6 and the original beatmatching phase-4 requirement. **Source:** [source-deck probes](../../packages/catalog/src/render/deck-probe.ts), [audio diagnostics](../../packages/catalog/src/render/audio-diagnostics.ts), [rendering contract](../rendering.md).

The new `source-decks` label is accurate and the coordinate fix is valuable. The underlying scope remains current catalog source files, grid-locked onsets, and an idealized time conversion. It does not check the actual stretched deck output, rate-region splices, gain/filter processing or final blend. Current source files are not verified against the render’s frozen hashes before probing. Offset/drift/count/confidence data are still reduced substantially when copied into the public check result.

The reported calibration has **39 pass, 21 review, 38 unmeasured out of 98 accepted-listen joins**. Preserve that listening evidence. It does not measure rejection of deliberately bad audio, and measured review swings are not independently established ground-truth drift. The ledger’s “remaining work is naming/status, not measurement” closes a requirement that was never implemented.

**Implement in two stages:**

1. Finish source-probe provenance/coverage: verify source identity, expose intervals/counts/offset/drift and reasons, and distinguish attempted from successfully measured probes. Keep sparse/ambiguous outcomes separate from pass. Reconcile off/decode-failure/top-level-warning semantics and remove stale comments claiming whole-beat phase visibility or warnings alone gate first-mix success.
2. Build a processed-deck regression harness using the renderer’s actual preparation and time map. Add final-output boundary/dynamics measurements separately. Keep the results advisory until both positive and negative controls support a gate.

**Acceptance:** aligned controls, 40/80/140 ms shifts, half-beat versus whole-beat relationships, slow drift, sparse material, vocal-heavy cases, edited windows, unequal rates, join-only stretch and deliberately faulty splices. Report false pass, false fail, abstention, coverage and runtime on tuning and held-out cases. Do not equate “zero hard failures on accepted music” with complete beatmatching verification.

This corpus is a prerequisite for improving automatic quality, not an optional saved-join feature. Include automatically generated sets from a fresh catalog with no approved transitions or listening history. Reserve unseen ordered track pairs for evaluation, and use track-disjoint holdouts where the corpus permits. Keep technical timing/processing labels separate from musical judgments about groove, energy and vocal collisions; a correct beat residual does not establish a good musical join. Track unacceptable joins and required manual intervention alongside usable-library coverage, variety and runtime, so rejecting almost everything cannot masquerade as improvement.

## Remaining scope that should not disappear from the backlog

These are not reasons to repeat completed work. Carry them explicitly as bounded followups or deliberate deferrals:

- **Public contracts and recovery (R13):** repair’s MCP output still declares only a small plan/validation projection, omitting entry/transition IDs, windows and detailed quality needed for follow-up actions. Move feature contracts into the domain layer or reuse existing complete schemas; add response round trips. `parseStoredJson` still suggests cloning/replanning malformed explanations even though clone first uses the failing read path. Provide an executable recovery route or truthful remediation.
- **Frozen validation scope (R9):** canonical key/energy absence is fixed, but validation still consumes live track records for other properties such as identity/artist constraints and duration. Rendering also copies some live metadata, including Camelot key, into prepared segments/manifests. Decide which fields are immutable musical inputs versus intentionally live execution checks; freeze or document them. Avoid another broad “all metadata frozen” claim.
- **Scratch ownership (R12/F10):** analysis markers and unique probe filenames remain useful. Test fixture roots that register only runtime close still need removal; active output scratch needs ownership, not only age/patterns. Include cleanup after failed/deposed work with resolved-path containment checks.
- **Replay scope (R7):** frozen history is now stronger; immutable normalized brief, policy/evidence/transition context is not implemented. Name the current operation precisely, and defer full planning-context replay as an optional product feature. Preserve the internal render reproducibility contract independently. Specify whether auto history represents generated drafts or accepted listens.
- **Legacy freshness (R10):** the shared missing-stage policy trusts a completed current-version row without checking a historical input identity. Document this compatibility exception and decide whether non-default current bounds/anchors require a one-time refresh. Keep new reason codes visible in diagnostics.
- **Fair listening comparisons:** identical stored track gain is not necessarily identical final gain: the mixer applies mix-wide gain/headroom correction per output. Report per-variant `staticGainDb`, limiter use, LUFS and peak along with treatment and context. Decide whether a gain-locked comparison mode is useful before describing all audible level differences as treatment-only.

## Documentation and test-quality work

The useful onboarding structure should stay. The next documentation pass should be short and focused on truthful status, rather than another narrative ledger appended below stale conclusions.

1. Point the README/current-work link at one active plan. Mark the 10 October review as a historical snapshot with this successor. Its current header still calls the comparison identity open, while the ledger later calls everything complete.
2. Replace blanket completion rows with **fixed**, **partial**, **deferred**, or **reopened**, linked to acceptance evidence. Specifically reopen outgoing R3, R4, replacement tempo/diff correctness, publication fencing, cache identity, and rendered-output measurement. Mark protected approved-join repair as **deferred by product direction**, not completed or a prerequisite for automatic quality. Keep completed subcases and their commits visible.
3. Preserve the current policy split between mixing/scoring/rendering. Remove statements that source-deck findings never enter top-level warnings on every path, that warning presence alone determines workflow failure, or that whole-beat phase differences are measured by a beat-wrapped verifier.
4. Describe the Linux MCP first-mix issue as **intermittent, root cause unresolved**. Rerunning a previously green commit successfully does not prove a runner cause or exclude a code regression. Retain detailed failure logging; capture command/config/tool versions, seed, manifest and check details on failure. Use bounded repeated old/new runs only when investigating a recurrence; do not weaken output checks to turn CI green.
5. Attach regression evidence to the boundary promised by the fix. The existing repair test checks preserved type rather than complete treatment; the fencing test checks repository state rather than delayed side effects; comparison identity tests check hash form/repeatability rather than artifact parity; alignment invalidation tests check removed pins rather than resolved rendered placement. Strengthen these specific cases instead of adding more implementation-mirroring tests.
6. The ten additional passing tests since the last reviewed snapshot are useful. “One regression per fix, verified against pre-fix” should be backed by named tests and the acceptance they exercise, not used as a substitute for reviewing those assertions.
7. State the automatic-quality goal once in the product overview and link to it from the active plan. Use “resolved transition” or “generated plan” for internal execution records, and “approved-join library” only for the optional curated feature. Document the default flow as analyze → plan → render, with no saved-join prerequisite. Keep detailed findings in this review and current behavior in canonical docs; avoid duplicating the entire backlog across the README, ledger and architecture docs.

Keep historical listening verdicts and private-library context intact. Do not move or quarantine music, reanalyze the library, or regenerate accepted mixes as part of a documentation cleanup.

## Delivery plan for the implementation agent

### Batch A — make generated joins internally consistent

Implement **S1, S2 and S3** as separate reviewable changes with shared fixtures where appropriate. Start with the normal persisted version-1 transition in S1. Preserve the working dead-intro fix and whole-beat phase semantics. Define cue and rate pin intent explicitly. Then implement **S6** using one base-eligibility predicate and **S7** using one resolved join context. Reuse that context in the existing planner and inspector; avoid a parallel timing model. Existing edit paths remain regression coverage, not the organizing product workflow.

**Exit:** automatically generated joins and existing revisions have rates/placement that agree with their targets, feasibility results and actual render manifests. Unusable alternatives cannot empty an otherwise usable pool. Failed revisions do not mutate stored plans. These checks require no approved joins or user-created recipes.

### Batch B — make analysis and render evidence trustworthy

Implement **S5 and S8**, the remaining scratch lifecycle work, and the documented frozen-validation scope. Use actual delayed process/HTTP boundaries with two owners, not only direct repository method calls. Keep shutdown completion under a still-valid claim working. Fix **S4** as a small independent maintenance change, along with truthful public contract/recovery responses; do not expand the manual comparison UI as part of this batch.

**Exit:** an old owner cannot overwrite newer catalog evidence or publish over a newer artifact. Cache reuse verifies strong source identity, no new job enters weak legacy identity accidentally, and feasibility/snapshot/artifact provenance agree. Existing comparison clients receive honest aggregate status and cached results.

### Batch C — establish automatic-quality evaluation

Implement **S9 stage 1**, then the processed-deck/final-output corpus in **S9 stage 2** as a separate larger change. Include positive and deliberately bad controls, automatic cold-start plans, unseen-pair holdouts and listening labels. Record a baseline for technical defects, musical rejection, abstention, manual intervention, successful plan coverage, variety and runtime. Set improvement criteria from this baseline before tuning new policies; do not invent a confidence cutoff from the accepted-listen sample alone.

**Exit:** the harness detects deliberately wrong processing and reports uncertainty honestly. A repeatable report distinguishes technical correctness from musical quality and reveals whether apparent gains merely reduce output coverage. Gate promotion requires held-out evidence and listening corroboration.

### Batch D — improve automatic selection using that evidence

Extend the existing planner's candidate search and lookahead rather than introducing a second planner. Deliver this in bounded increments:

1. **Measure the candidate overlap.** Reuse available local timing, groove, energy and confidence evidence. Add missing interval evidence only where the corpus demonstrates a failure that it can address. Keep absence of evidence distinct from a measured good interval.
2. **Evaluate alternatives automatically.** Compare feasible outgoing/incoming windows, overlap lengths and supported treatments within configured rate limits. Use S7's resolved context for every candidate. Record rejection/selection reasons and bound candidate count, processing cost and search time. Establish a deterministic baseline for fixed inputs and seed.
3. **Recover automatically when a join is weak.** Try a different window or treatment, then another track or bounded sequence backtracking. Validate both neighbors after reselection and any affected tempo propagation. Use an explicit fallback policy with a termination bound; do not assume a generic crossfade makes every pair acceptable. If hard constraints leave no satisfactory plan, return an actionable limitation.
4. **Check the produced audio.** Compare rendering against the selected geometry and use calibrated output checks to detect processing failures. Introduce bounded automatic rerender/reselection only for failure classes the corpus shows can be detected reliably. Ambiguous measurements remain visible uncertainty, not automatic passes or unlimited retry triggers.
5. **Evaluate generalization.** Accept new signals or policy changes only when held-out automatic plans improve without unacceptable losses in coverage, diversity or runtime. Listening feedback should correct shared evidence/scoring/selection behavior; exact-pair approval must not become a hidden dependency.

**Exit:** a fresh catalog and brief can produce a mix without saved or preapproved joins; measured join quality improves on held-out cases, required manual intervention decreases, and unsatisfiable constraints produce an honest outcome. Persist each selected transition internally so preview, final audio and diagnostics remain reproducible. This is an evaluated quality target, not a promise that every conceivable pair is compatible.

Update canonical docs with each behavior change, then reconcile the single backlog index. Before implementation handoff run targeted regressions, the complete suite, typecheck including tools, lint, exports and formatting. Record the final SHA, exact test counts and any unresolved native/CI failures. Corpus construction can start alongside correctness fixes; automatic policy tuning follows the verified baseline. Improve modules through these tasks without a general architecture rewrite or file splitting solely to satisfy line counts.

## High-value extensions after the automatic-quality baseline

1. **Safe mix intervals with confidence and coverage.** Expand interval-level analysis where Batch D establishes value, recovering usable sections of otherwise suspect tracks without increasing known-bad joins. Start with interval selection; defer variable-tempo warping until there is evidence it is needed.
2. **Local vocal, drum and dynamics collision avoidance.** Use overlap-level evidence to select windows and treatments automatically. Demonstrate incremental benefit over existing groove/continuity signals before introducing stems, models or additional hard gates. Surface a short explanation when useful; do not require the user to inspect diagnostics for every join.
3. **More variety within a measured quality floor.** Improve discovery and sequence diversity while retaining the same join-quality checks. Evaluate repeated fixed-brief runs for artist/track repetition, musical flow and quality rather than using a bank of approved pairs as the default route to reliability.
4. **A concise automatic mix-quality report.** Explain meaningful uncertainty, fallback choices and brief constraints, backed by the actual rendered artifact. Give users useful feedback when a request cannot be satisfied, without presenting an approval checklist as the normal completion flow.

**Optional later controls:** a join workbench, revision undo, approved-treatment recall, protected-join repair and full planning-context replay can serve creative preferences or precise recall. They are not prerequisites for automatic quality and should not lead the next feature wave. Revisit them only with a concrete user need and evidence that the automatic path is already dependable.

The intended outcome is a crate that chooses and produces good joins on its own. Shared transition geometry and trustworthy evidence make that testable; the corpus and automatic selection work turn it into a repeatable product capability.
