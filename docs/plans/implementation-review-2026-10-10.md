# Implementation review and next handoff — 10 October 2026

## Start here

The implementation substantially improves the repository, but several advertised guarantees stop at a helper or service boundary. Prioritize five integration failures: protected repair does not enforce protection; final entry construction undoes the dead-intro fix; edited windows are not realigned as promised; fast deck verification mixes two time origins; and the comparison CLI never starts a worker. Then finish frozen evidence, replay, freshness, and worker publication semantics before expanding automatic musical policy.

This document is the next implementation backlog. It reconciles the [8 October review](C:/Users/arild/repos/dnb-crate/docs/plans/repository-review-2026-10-08.md) with the [implementation ledger](C:/Users/arild/repos/dnb-crate/docs/plans/implementation-ledger-2026-10.md). It does not authorize implementing every feature at once. Land small changes with the acceptance checks below; preserve the owner’s listening decisions and the existing fidelity safeguards.

## Snapshot and validation

- Reviewed HEAD: `98847dadc54ff392ccd0cf094ff471395d2acdc9`, “exact replay from a frozen planning context,” 10 October 2026.
- Comparison baseline: `8dc011001a187a0ef326fb7f99d7209dc56c8334`. Git reports **52 commits**, **91 changed files**, 8,097 insertions and 391 deletions. The ledger header’s 50 commits / 14 parallel-agent commits needs reconciliation.
- Scope: architecture and changed paths across domain/contracts, catalog/persistence, analyzer, planner/editor, renderer/mixer/checker, workers/workflows, CLI/MCP, tests, scripts, and operational documentation. This is a source and regression review, not a fresh listening evaluation of the private library.
- Local Windows validation: **618 tests in 67 files passed**, in 362.62 seconds; typecheck passed; lint passed with three existing maximum-line-count warnings; export checking passed for 365 exports.
- `format:check` failed **only** on the supplied, untracked `docs/plans/implementation-ledger-2026-10.md`. That file was left untouched. The ledger’s remote CI claims were not independently rechecked.
- Focused read-only/in-memory probes reproduced protected-repair loss, the dead-intro override, fast-verifier coordinate loss, missing CLI worker policy, replay context loss, and the full-hash cache weakness. No application implementation, library metadata, or music files were changed by this review. The small disposable hash fixture was removed.

**Evidence labels:** “Reproduced” means an executable probe demonstrated the stated behavior; “code-traced” means the control/data flow supports it and the implementation task must start with a failing regression. A passing helper test does not establish the corresponding end-to-end guarantee. P1 addresses immediate correctness or misleading quality guarantees; P2 is the next reliability/maintainability batch; P3 is optional or dependent on measurement.

## What is complete, and what remains from the original plan

- **F1, placed-coordinate checking: substantially complete.** The offset is now provenance, and `placedIncomingOverlapStartMs` avoids applying it twice. Preserve the whole-beat equivalence tests. Do not restore the old whole-beat tripwire.
- **F2, honest audio QC: partially complete.** Inconclusive diagnostics no longer erase a stored-grid failure. There is now a useful source-deck measurement, but its fast-mode integration is broken and it does not verify the actual rendered deck processing. See R5–R6.
- **F3, overlap-local evidence: core fix complete.** The structural gate uses the actual outgoing overlap and the chosen bar count; local beat profiles improve template selection. Remaining window-authority and saved-window comparison gaps are R3–R4 and R14. Some soft scoring still uses broader head/tail summaries; keep that distinction explicit.
- **F4a/F4b, immutable jobs: partially complete.** Full-content hashes and canonical snapshots are valuable additions. The hash cache and frozen-null/live-fallback behavior leave holes; R8–R9.
- **F5, descriptor contracts: complete for the identified fields.** Exact key guards and round-trip fixtures cover the descriptor omissions. The same class of bug has already recurred in explanation/feature contracts; R13.
- **F6, proposal feasibility: core gate fix complete.** Proposals run the shared structural gate on their proposed windows. This does not establish feasibility on a different, saved window; R14.
- **F7, structural editing: partially complete.** Pair stamps and move invalidation prevent old-neighbor recipe reuse. Trim alignment, rates, replacement explanations, and protected repair remain incomplete; R1/R4.
- **F8, history: partially complete.** Auto/explicit/off modes and recorded references are useful. Artist-history persistence is incomplete, the eligibility scan remains bounded before filtering, and “exact replay” freezes only part of the planning context; R7.
- **F9, analyzer freshness: partially complete.** Input identity, explicit force, reference-lock handling, and anchor feature stripping are real improvements. Workflow and missing-stage selection still disagree; R10.
- **F10, temporary resources: partially complete.** Analysis ownership markers, unique checker filenames, safer containment checks, and FFmpeg fixture cleanup help. Other fixture roots and long-running render scratch still lack a complete ownership lifecycle; R12.

The new inspector, comparison, repair, and replay surfaces are useful foundations. Safe mix zones are **not implemented** by whole-track suspect filtering or quarantining. Worker takeover detection is **not completion fencing**. Those distinctions should replace blanket “complete” labels.

## Findings and implementation requirements

### R1 — P1, reproduced: protected repair changes protected joins and underreports the diff

In [repairSetPlan](C:/Users/arild/repos/dnb-crate/packages/catalog/src/service.ts:1153), `protectedTransitionIds` is consulted only after `updateSetPlan` has saved the replacement. It counts surviving IDs; it never prevents changing a protected transition. Replacing B in A→B→C necessarily changes both neighboring pairs, whereas the comment and returned invalidation list describe only A→B. `protectedJoins: [protectedCount]` returns a one-element count array rather than identifying preserved joins.

An in-memory four-entry plan with all three transitions protected lost **two protected transition IDs**, reported only **one invalidated join**, and returned `protectedJoins: [1]`. Its explanation had no `edited` marker: replacement clears transitions before the later changed-adjacency loop can observe them.

**Implement:** build a candidate revision and compute its complete dependency diff before persistence. Reject protection conflicts without saving, unless the caller explicitly requests a defined override. Compare effective pair/window/rate/treatment identity, not only transition UUID. Return changed, preserved, and invalidated joins with stable IDs, orders, before/after values, and reasons. Capture replacement provenance before clearing transitions. Draft edits may remain permissive elsewhere; protected repair must fulfill its stronger contract.

**Acceptance:** protect the target, the following join, and an unaffected join; test a middle replacement, early-chain rate consequences, unknown protection IDs, a no-op replacement, and invalid replacement constraints. A rejected repair leaves the stored plan byte-for-byte unchanged. A successful repair reports every affected adjacency and preserves every protected effective treatment. Add an actual protected-repair test, not only an unprotected replacement example.

### R2 — P2, reproduced: `transition:compare --wait` queues work without a worker

[CLI worker policy](C:/Users/arild/repos/dnb-crate/apps/cli/src/worker-policy.ts:4) omits `transition:compare`. Both waiting and non-waiting comparisons resolve to `none`; ordinary `render:preview --wait` resolves to `process`. The [command](C:/Users/arild/repos/dnb-crate/apps/cli/src/commands/transitions.ts:104) nevertheless queues previews and waits up to 600,000 ms per job. In a standalone CLI session with no MCP worker, jobs remain queued until the wait times out. Without `--wait`, it also bypasses the normal missing-worker guidance.

The waiting branch copies an output path and then prints `ok: true` without exposing each terminal job’s failed/cancelled state. The service also reduces enqueue failures to “preview render failed,” losing the actionable domain error.

**Implement:** register comparison as an enqueue/process command; preferably keep dispatch and worker requirements in one command registry. Return per-variant lifecycle state, error code/message, job ID, and artifacts. Define partial-success CLI exit behavior and preserve useful failure details.

**Acceptance:** invoke the real CLI with no other runtime, with and without `--wait`; verify completion versus immediate worker guidance. Include one failed variant alongside a successful variant, cancellation, timeout, and cached success. Handler-only service tests cannot catch this integration failure.

### R3 — P1, reproduced: final timeline construction undoes resolved cue placement

[resolveManualMixIn](C:/Users/arild/repos/dnb-crate/packages/catalog/src/planning/windows.ts:593) correctly ignores a manual zero cue in a quiet introduction when there is a better musical entry. But [buildEntries](C:/Users/arild/repos/dnb-crate/packages/catalog/src/planning/timeline.ts:709) prioritizes `manualMixInMs` over the resolved previous pair window, both in `plannedStart` and the final `musicalWindow` call. It then rewrites transition `mixInMs` from the resulting source start.

A synthetic 174 BPM incoming track with quiet bars 0–16, a build at 16–48, a drop from bar 48, and manual cue zero produced **22,069 ms** from both the window helper and chooser. `buildEntries` changed the incoming source start and final transition parameter back to **0 ms**. The selected template remained `phrase_mix`.

The outgoing side has the same precedence problem. With a manual mix-out at bar 64 plus 140 ms, the chooser resolved **88,276 ms** and recorded a 140 ms alignment correction. Final entry construction restored **88,416 ms** from the manual cue while leaving the incoming entry at **22,069 ms**. Thus the outgoing grid-placement fix can also be undone after the window helper succeeds. This is directly relevant to the original phrase-mode snap backlog, not just the newer dead-intro behavior.

**Implement:** resolve cue precedence once and carry the chosen source window through entry construction, preview, and manifest generation. Record whether a manual cue was accepted, explicitly overridden by the caller, or rejected as stale. Do not silently restore a rejected cue in a later layer.

**Acceptance:** extend the dead-intro and off-grid manual mix-out fixtures through `buildEntries` and a render/preview manifest; assert the intended audible entry, outgoing grid position and landing position. Cover valid manual cues, a deliberately forced cue, absent section evidence, non-unit rates, and first/middle entries. Existing window-helper tests are insufficient.

### R4 — P1, code-traced: edited windows lose alignment pins but do not regain valid placement

[The editor](C:/Users/arild/repos/dnb-crate/packages/catalog/src/service/plan-editor.ts:62) claims that stripping alignment pins lets rendering rederive alignment. It removes offsets/mode/period/onset lock but retains `recipeVersion`. [Entry construction](C:/Users/arild/repos/dnb-crate/packages/catalog/src/planning/timeline.ts:801) stamps `recipeVersion: 1` again regardless. The [renderer](C:/Users/arild/repos/dnb-crate/packages/catalog/src/render/coordinator.ts:1435) computes alignment metadata but skips applying the result when that version is present. A changed window can consequently acquire new provenance without the matching source placement.

Structural edits also retain prior playback rates. The ledger acknowledges this, but it was part of the original downstream consistency requirement. Source trims, overlap duration, playback rate, and neighboring joins form a dependency chain; deleting a few parameter keys is not enough.

**Implement:** distinguish unresolved edits from resolved placement with an explicit invariant/version. Resolve and validate affected join geometry before marking it render-ready. Preserve intentional absolute trims as user intent; return an explicit unresolved/conflict result when alignment cannot honor them. Recompute affected rates, overlaps, continuity/automation, recipe validity, and explanation provenance together. Do not “fix” this by restoring the old double application of offsets to every stored recipe.

**Acceptance:** exercise trim, transition duration/type, playback-rate change, proposal application, move, and replacement through saved plan → render manifest. Use three tracks with different native tempos and an off-grid incoming trim. Assert actual windows and residuals, not merely absence of parameter keys. Unchanged approved joins retain their complete effective treatment.

### R5 — P1, reproduced: fast verification compares midpoint onsets with start-of-overlap grids

In [the deck-probe integration](C:/Users/arild/repos/dnb-crate/packages/catalog/src/render/coordinator.ts:980), fast mode decodes a 10-second midpoint probe. Onsets are shifted by `probeOffsetMs` into overlap-relative time, but grids are filtered to `[0, probeMs + 500)` from the overlap start. `verifyDeckAlignment` receives `overlapMs: probeMs`, so its half-window drift calculation also uses the wrong origin.

A dense aligned 174 BPM probe retained 29 onsets per deck for 8 bars, only 13 for 16 bars with the first half unavailable, and **zero for 32 bars**. The 32-bar midpoint starts about **17,069 ms** into the overlap, beyond the retained grids. Normalizing both streams to probe-local time made the same control pass. This explains some abstention mechanically; historical “unmeasured” results cannot all be attributed to sparse music.

**Implement:** choose one coordinate system for probe bounds, projected grids, onsets, and drift halves. Return the probe’s source/output intervals, retained counts, offset, drift, dispersion/confidence, and abstention reason; the current integration discards much of the verifier result.

**Acceptance:** test the coordinator path at 8/16/32 bars and unequal playback rates, using dense/sparse onsets and known positive/negative offsets. Fast and full must agree on a constant-shift control; fast must measure both halves when coverage exists. Re-run the calibration report after the fix before drawing conclusions from its prior pass/review/unmeasured counts.

### R6 — P2, code-traced: the independent verifier’s guarantee is still narrower than the plan

The new verifier decodes **current catalog source files**, applies a kick-band filter, and divides onset timestamps by playback rate. It does not inspect the renderer’s actual Rubber Band output, join-only rate regions, splice boundaries, gain/filter automation, or final blend. It also does not verify those current files against the render’s frozen content hashes. It is useful evidence of source-deck compatibility; it is not independent verification of the rendered processing.

Beat-locking within ±100 ms of each stored grid is a sensible way to reject irrelevant onsets, but it deliberately discards strong disagreements with that grid. A genuinely shifted backbone can become “unmeasured.” Median nearest-onset residuals and a pass-derived confidence also need negative controls for sparse/unrelated patterns. Stored residual zero can skip the mixed-audio diagnostic path, leaving another blind spot. Preserve whole-beat phase equivalence; bar-phase judgment needs a different signal.

**Implement in stages:** first fix R5 and name the source-probe scope accurately. Then share renderer preparation so tests/probes can inspect each processed deck before summation, with frozen source identity and the same time mapping. Add final-output boundary/dynamics checks separately. Keep uncalibrated audio findings advisory, with coverage distinguishable from success. Replace the stale “not implemented” default reason and make off/skipped/decode-failed statuses consistent across join rows and top-level warnings. At this HEAD, workflow success is `check.ok && masterValid && listenValid`; warnings alone do not make it false, despite the ledger’s warning rationale.

**Acceptance:** a versioned local corpus with correct placement, known 40/80/140 ms shifts, half-beat and whole-beat relationships, gradual drift, variable-rate regions, silent/drop-sparse windows, vocal-heavy false positives, and deliberately bad output splices. Measure false pass, false fail, abstention, coverage, and decode time separately. Do not promote a hard audio gate based only on accepted-listen positives.

### R7 — P2, reproduced/code-traced: replay drops artist history and does not freeze a full planning context

[History resolution](C:/Users/arild/repos/dnb-crate/packages/catalog/src/service.ts:774) can replay stored track IDs, pairs, artist counts, and seed. However, [finalization](C:/Users/arild/repos/dnb-crate/packages/catalog/src/planning/finalize.ts:94) persists `recentArtistUses` **only in auto mode**. Explicit-history plans use counts without storing them; a replay consumes counts but omits them from its own saved context. An in-memory probe carried six artist-history keys into replay and saved zero. The fixture happened to select the same tracks; a changed selection was not needed to demonstrate lost scoring inputs.

“Exact replay” also leaves the caller responsible for supplying the same brief. Strength/descriptor normalization, recording identities, current analysis, feedback/approved recipes, and algorithm policy remain live; recorded `policyVersion` is not an execution selector. State that scope clearly rather than implying snapshot replay. Separately, fetching 64 plans before filtering eligibility still allows enough short drafts to hide older qualifying history.

**Implement:** persist every actually used history field for every mode, and make replay-of-replay stable. Choose and document two distinct operations: replan using frozen history under current policy, and true context replay. The latter needs the normalized brief, policy/evidence identities, resolved recording/pair/artist history and applicable recipe/feedback context, or an explicit unsupported-version result. Define whether history means generated drafts, rendered plans, or accepted listens; do not imply one while using another. Query/page by eligibility before applying the history window.

**Acceptance:** nonempty eligible history, non-default strength, explicit references, replay-of-replay, more than 64 short drafts, deleted/edited references, and changed policy/evidence. The current [replay test](C:/Users/arild/repos/dnb-crate/packages/catalog/test/planning.test.ts:2911) produces short plans below the eight-entry auto-history threshold; its “interloper changes history” comment is not exercised. Assert the history changed before asserting replay immunity.

### R8 — P2, reproduced: the execution SHA check can reuse a stale enqueue hash

[sourceHashForTrack](C:/Users/arild/repos/dnb-crate/packages/catalog/src/render/coordinator.ts:628) caches SHA-256 by path, size, mtime, and the cheap head/tail fingerprint. Queueing and execution call the same cache. A same-size interior edit that preserves/restores mtime therefore reuses the old full hash. A disposable 256 KiB file with one middle byte changed reproduced `cachedHashUnchanged: true` while a fresh SHA confirmed different bytes. The existing interior-edit test changes ordinary metadata and misses this case.

Hash errors also return null, allowing a newly frozen request to fall back silently to the weaker legacy identity behavior.

**Implement:** make execution verification independently read the bytes, or use a clearly justified identity mechanism that cannot equate this case. Keep queue-time caching only within its proven guarantees. A new request that requires a full hash must surface hashing failure; weak legacy compatibility should be explicit, observable, and limited to legacy requests. Check for file changes during hash/decode preparation as appropriate.

**Acceptance:** preserve size, timestamp, and head/tail bytes while changing the interior; execution rejects and cache reuse does not hide it. Test hash-read failure, unchanged-byte relocation, legacy request policy, and source changes between prepare/execute. Do not weaken cache identity to improve throughput without measuring the correctness tradeoff.

### R9 — P2, code-traced: frozen absence still falls through to live evidence

[qualityForPlan](C:/Users/arild/repos/dnb-crate/packages/catalog/src/service/quality-evidence.ts:65) initializes maps from the live catalog and overwrites only numeric/present frozen values. A frozen absent audio end/drop/energy can therefore acquire later live analysis. Expressions such as `canonical?.musicalKey ?? row.musicalKey ?? track?.musicalKey` treat a deliberately frozen null as permission to use current metadata. Validation and parts of quality reporting still receive live `Track` records.

**Implement:** branch on snapshot version/presence, not value truthiness. A present canonical block owns its nulls. Remove live map entries when the snapshot records absence. Freeze the metadata actually needed for musical validation, and separate live execution preconditions such as file availability from frozen musical judgment. Specify whether later recipe approval/revocation can intentionally change a queued job; capture applicable context if the contract promises immutability. Include individual analyzer identities where reproducibility depends on them.

**Acceptance:** queue with unknown key/energy and absent analysis; later add key, energy, first drop, and audio end. Queued musical quality remains stable. Repeat with manual/published precedence and changed track metadata. Live missing-file checks still fail clearly. Test old snapshots separately rather than applying new fallback rules implicitly.

### R10 — P2, code-traced: workflow freshness still uses the old identity rules

The coordinator and repository gained `dspInputIdentity`, but [needsMixAnalysis](C:/Users/arild/repos/dnb-crate/packages/catalog/src/mix-workflow.ts:215) still compares stage identity with bare `DSP_ANALYZER_VERSION` and does not compare reference-BPM inputs. Changing configured tempo bounds can leave a default-identity row apparently current to the workflow; an already current custom identity can cause redundant analysis scheduling. The coordinator may then skip the unnecessary job, so this is not necessarily an infinite loop.

[Stale-scope selection](C:/Users/arild/repos/dnb-crate/packages/catalog/src/analysis-repository.ts:541) returns false for a missing stage and checks failed, but not pending, analysis status. A rescan/legacy row can retain an analysis row while losing its stage and escape the stale selection that should refresh it.

**Implement:** one freshness decision shared by scope selection, coordinator, and first-mix workflow. Include source fingerprint, status, stage/version, tempo configuration, manual anchor, and canonical reference lock. Give legacy missing-stage rows an explicit migration/freshness policy. Keep force behavior separate from freshness.

**Acceptance:** first-mix and explicit stale analysis agree after tempo-range changes, anchor edits, reference changes/removal, pending rescans, and missing stages. Repeating a workflow with unchanged custom inputs schedules no redundant DSP work. Preserve the exclusion of analyzed-BPM writeback from reference inputs.

### R11 — P2, code-traced: suspect filtering depends on unrelated catalog size

[The pool](C:/Users/arild/repos/dnb-crate/packages/catalog/src/planning/pool.ts) excludes `gridPhaseSuspect` tracks when the raw catalog has at least 24 rows. Missing/excluded/unusable rows count toward that threshold. Adding one irrelevant row can change eligibility of otherwise identical candidates. Contrary to the comment, a sufficiently large all-suspect library does not get a deliberate fallback; it can lose the whole pool. This is a size switch, not local confidence assessment.

The supposedly unconditional `unmixable` exclusion is also bypassed by pin readmission. An explicit pin may reasonably override a default, but that needs an explicit product contract and visible reason. DSP phase zero currently also covers cases outside the trusted offset/confidence range; unknown and measured zero should not be treated interchangeably.

**Implement:** separate owner exclusions, advisory diagnostics, and validated hard constraints. Base any supply-aware relaxation on eligible alternatives and measured confidence, with recorded reasons. Define pin overrides deliberately. Add phase coverage/confidence/unknown status before using a scalar to drive stronger automation. Keep the owner-approved unrated-pass `minRating` behavior; search may intentionally have different semantics.

**Acceptance:** 23 versus 24 rows with identical usable candidates; large all-suspect and mixed-confidence pools; missing/excluded filler; explicitly pinned unmixable/unstable/suspect tracks; ambiguous and genuinely zero phase. No unexplained eligibility change caused by irrelevant catalog rows. Do not broaden exclusions solely from a handful of tuning listens.

### R12 — P2, code-traced: takeover stops claims, but does not fence completion or all scratch

[WorkerOwner](C:/Users/arild/repos/dnb-crate/packages/catalog/src/worker-owner.ts:80) detects loss on heartbeat, but `stillOwned` is unused by production callers. Existing jobs continue. A new owner recovers running jobs as interrupted, while [markSucceeded](C:/Users/arild/repos/dnb-crate/packages/catalog/src/render-job-repository.ts:230) updates by job ID without a status/owner-generation condition. A late old owner can overwrite recovery state and publish output. SQLite’s serialization of writes does not establish ownership of those writes. The current tests cover ownership-row replacement, not competing in-flight completion.

Scratch ownership is wired into analysis decode, while rendering/checker files and marker-less legacy `dnb-*` roots still rely substantially on age/patterns. Several [planning](C:/Users/arild/repos/dnb-crate/packages/catalog/test/planning.test.ts:45) and [render](C:/Users/arild/repos/dnb-crate/packages/catalog/test/render.test.ts:36) fixtures register runtime close without deleting their roots. The original large FFmpeg cleanup fix remains valid; these are residual lifecycle gaps.

**Implement:** carry a claim generation/token into job state transitions and final publication. Abort deposed work where possible and reject stale writes regardless. Own active output scratch as well as analysis scratch, and clean test roots in `finally`/teardown after handles close. Preserve strict resolved-path containment for every recursive cleanup; do not broaden deletion to solve leaks.

**Acceptance:** two runtimes, deliberately expired heartbeat, an old job completing after takeover, and cancellation during publication. The old owner cannot resurrect interrupted/cancelled work or replace the winner’s artifact. Include long-lived scratch with stale timestamps, dead-owner cleanup, concurrent checker calls, failed native processes, symlinks, and an end-of-test assertion that owned roots are gone.

### R13 — P2, code-traced: new public contracts repeat the schema drift problem

`PlanExplanation.edited` exists in [the type](C:/Users/arild/repos/dnb-crate/packages/domain/src/planning.ts:179) but is absent from [planExplanationSchema](C:/Users/arild/repos/dnb-crate/packages/domain/src/contracts/planning.ts:476). Schema parsing strips the new provenance field. Repository validation currently returns the raw parsed object after checking, which masks this for database reads but does not fix schema-driven clients.

The new [repair tool schema](C:/Users/arild/repos/dnb-crate/apps/mcp-server/src/tools/planning.ts:113) describes only a small projection of its returned plan and validation: entry/transition IDs, source windows, and validation detail are not represented. Inline schemas in the MCP layer introduce another source of truth. Handler-name coverage does not prove payload round trips.

The improved [persisted-shape error](C:/Users/arild/repos/dnb-crate/packages/catalog/src/set-plan-repository.ts:61) suggests cloning/replanning a malformed plan, but cloning first calls the same failing `requirePlan`. Its remediation can be impossible through the public API.

**Implement:** shared domain contracts for inspector/comparison/repair/replay and complete explanation provenance. Add focused type/key/round-trip guards at these public boundaries. Return a full declared plan or intentionally versioned summary with enough IDs for follow-up actions. Provide a narrowly validated recovery route for corrupt explanation data, or replace the misleading recovery instruction. Do not silently accept malformed executable plan fields.

**Acceptance:** actual CLI/MCP request→service→response parsing preserves edited markers, IDs, windows, protection diffs, lifecycle errors, and quality detail. Legacy optional fields survive. A corrupt explanation produces a recovery action that can really be executed. Add version-aware validation for high-impact frozen requests/manifests when extending those formats.

### R14 — P2, code-traced: comparison feasibility is evaluated on newly chosen windows

[compareTransitionVariants](C:/Users/arild/repos/dnb-crate/packages/catalog/src/service.ts:1035) asks `planTransition` for current proposals using the pair and target BPM, without supplying the saved source windows, rates, or bar count. It uses those proposals’ feasibility to decide which variants to render against the saved join. Thus F6’s shared gate can correctly reject/accept the proposed window while the comparison renders a different interval. Each preview also freezes separately, so there is no single comparison-context identity spanning the variants.

**Implement:** resolve a saved-join comparison context once: source hashes, evidence, coordinates, rates, overlap, gain reference, and variant-specific treatment. Evaluate each treatment against that same context. Clearly separate “change treatment on this window” from “propose a different window.” The inspector can show both stored and current recommendations, but must label their evidence/window identities. Preserve failures rather than silently dropping alternatives.

**Acceptance:** a saved overlap with conflict while the chooser’s preferred overlap is clean, and the reverse; non-default bar counts/rates; a changed catalog during enqueue; and a manually edited join. Every artifact and blocker refers to the displayed common context. Document whether comparable loudness means identical gain staging or measured loudness matching; report measured loudness/headroom when meaningful for listening.

## Architecture and code quality: improve boundaries through the fixes

Keep the local SQLite + TypeScript packages + native audio tools architecture. A service split, wholesale DSP rewrite, or new infrastructure layer would not solve these defects. The strongest next abstractions are small, explicit shared results:

1. **Resolved join context**, introduced through R3/R4/R14: source and output intervals with units, pair identity, rates/rate regions, alignment placement versus provenance, automation, selected evidence identity, and eligibility reasons. Entry building, inspection, variants, editor validation, and rendering should consume the same resolved values.
2. **Frozen render preparation**, through R6/R8/R9: stable content/evidence context, verified source access, and the same deck preparation for preview/full render/processed-deck QC. Keep mutable file availability separate from musical evidence.
3. **Freshness decision**, through R10: one reasoned result used by all schedulers. Avoid three subtly different booleans spread across workflow, coordinator, and repository.
4. **Candidate plan revision and dependency diff**, through R1/R4: calculate before commit; separate reversible draft editing from protected repair promises. A transition UUID is not an effective-recipe identity.
5. **Command/job lifecycle contract**, through R2/R12/R13: worker requirements, ownership generation, status and error mapping, and public payload schema should agree across adapters.

The lint hotspots have grown to roughly 1,708 lines in DSP, 2,144 in render coordination, and 1,383 in the service. Extract responsibilities while changing them, behind failing integration fixtures. Do not create a broad “reduce line count” project. Move pure alignment diagnostic math out of catalog orchestration when R6 gives it a clear audio-analysis boundary.

The DSP 3.13 tonal-power melodicness change and phase histogram/scan are useful research outputs. Keep units, supported interval, coverage and confidence explicit; add a held-out, manually labeled corpus across tempos, codec formats, sparse intros, breaks and vocal-heavy tracks before further threshold tuning. Preserve native musical key precedence, Rubber Band R3 fidelity checks, join-only stretch semantics, phase-equivalent whole-beat shifts, and the owner’s preference for phrase mixes when they work.

Recording-family exclusion is an intentional owner policy, and final validation now checks it. Add collision/alias tests and an explicit override path for ambiguous artist/title normalization rather than removing the policy. Keep reproducibility comparisons about musical output and context, excluding generated UUIDs/timestamps.

## Documentation reconciliation and onboarding

Documentation needs consolidation before another large implementation wave. Preserve historical evidence; remove ambiguity about which text governs current behavior.

1. **One short entry point.** Add a “Start here” section to the README linking in order to `docs/architecture.md`, `docs/first-mix.md`, `docs/cli.md`, and this active plan. Include runtime/native prerequisites, local config/data locations, safe test commands, worker ownership, and current known limits. Avoid adding a parallel long onboarding guide.
2. **One active backlog.** Mark the 8 October review and ledger as historical snapshots with links here. Reconcile `code-quality-debt.md`, `lean-codebase.md`, and `beatmatching-automation.md`: retain still-open requirements by ID, close proven ones, and point duplicated task lists to this plan. Archive session chronology separately from current guidance; keep links or redirects when moving files.
3. **Correct architecture claims.** Update migrations `001..020` to include 021; qualify deterministic planning with resolved history/policy/evidence inputs; qualify immutable queued quality until R8/R9 land. Document ownership recovery versus publication fencing accurately. Types and schemas are not universally drift-proof because descriptor key guards exist.
4. **One owner for musical policy.** Put current template thresholds, constraints, pin overrides, and confidence rules in `docs/mixing.md`; let `docs/scoring.md` explain scoring and refer to those defaults. Scoring still says the set planner never auto-picks `bass_swap`, contrary to the decisive-conflict implementation and mixing defaults. Mixing’s blanket low-coexistence→16-bar swap advice also needs separation from the stricter current trigger and case-specific listening evidence.
5. **One owner for verification semantics.** `docs/rendering.md` should distinguish stored-grid checks, source probes, processed-deck measurements, final-mix diagnostics, readiness, advisory findings, and listening approval. Explain fast/full/off and coverage. Link the beatmatching status document to this contract; do not use “verified” for unmeasured audio.
6. **Reconcile analysis/followups with current consumers.** `beatmatching-followups.md` still says phase suspicion is advisory-only and no planner path consumes it, while the pool does. Mark shipped diagnostics as shipped, safe intervals as pending, and phase-4 completion as partial. Correct the old two-beats/172 ms label-swap wording: beat-phase equivalence and half-beat kick/snare hypotheses are different concepts.
7. **Lean agent rules.** `.cursor/rules/dnb-mix-sessions.mdc` mixes personal-library operations, hypotheses and product rules. Its 0.65/0.85 screening advice differs from implemented thresholds; its “strip recipeVersion to realign” advice is ineffective through the normal entry builder; two minRating bullets are accidentally joined. Keep short invariant rules with links to canonical docs. Preserve audition-specific judgments in dated notes. Do not make a personal absolute quarantine path or an untracked `data/session-offenders.json` a universal setup requirement.
8. **Reconcile the ledger.** Correct counts and validation scope; mark partially fulfilled acceptance separately from shipped commits. Record the reviewed SHA/date and local test result, and format the supplied file in the documentation batch. Do not erase the historical owner verdicts or imply this source review re-auditioned them.
9. **Triage scripts.** Move one-off ID/title/path-specific experiments into a dated experiments area, with purpose and required local data. Promote only useful repeatable tools into parameterized commands. `quarantine-unmixable.mts` should not become a generic operation without exact IDs, configurable destination, collision handling, a reviewable dry-run and recovery. Prefer a logical exclusion workflow before adding physical file moves. Keep calibration/listening manifests with content hashes, windows, engine versions and verdict provenance, so prose counts can be regenerated.

**Documentation acceptance:** a fresh implementation agent can identify the active backlog, current musical policy, verification limitations, required commands and local-only data in ten minutes. No active document contradicts those contracts. Run link/command checks and formatting; retain historical labels and provenance rather than rewriting past conclusions as current facts.

## Recommended delivery sequence

1. **Contract containment — small changes:** R2 CLI lifecycle and R13 public-schema omissions; update misleading feature descriptions immediately. Add the missing protected-repair regression from R1 before relying on repair in further experiments.
2. **Plan correctness — separate medium changes:** R1 transactional protected repair, then R3 resolved cue precedence, then R4 alignment/rate dependency handling. Reuse fixtures through actual saved plans/manifests. Keep musical threshold changes out of these fixes.
3. **Measurement correctness — medium:** R5 probe coordinates and result visibility. Re-run existing calibration and distinguish changed measurement from changed audio. Keep advisory behavior.
4. **Immutable context and replay — separate medium changes:** R8 fresh source verification, R9 frozen absence/metadata semantics, then R7 history persistence/replay scope. Add legacy policy and version handling with the changes, not afterward.
5. **Operational consistency — medium:** R10 shared freshness, R12 completion fencing and remaining cleanup, R11 explicit screening/pin policy. The new Windows lane is valuable; keep native Linux coverage and exercise the new lifecycle cases on Windows.
6. **Complete the comparison workbench — medium:** R14 common saved-join context and full CLI/MCP contract tests, using R1/R4/R8/R9 rather than duplicating their logic.
7. **Independent audio measurement — larger, staged:** R6 processed-deck/final-output harness and held-out evaluation. Tune or promote gates only with coverage and negative-control evidence.
8. **Documentation consolidation — alongside each batch, then one final pass:** update the relevant canonical contract in the same change; finish the index/archive reconciliation once behavior settles.

Each correctness change should have a regression that fails on this reviewed HEAD and passes after the change. Run targeted tests during development, then the full suite, typecheck including tools, lint, exports and formatting once before handoff. For changes to audible behavior, compare identical source windows and explicitly request/record owner listening verdicts; do not infer approval from metrics. Do not repeatedly regenerate the private library or delete existing artifacts to make tests pass.

## Future work with the highest value

These extend current capabilities; they should not distract from the failed guarantees above.

- **A trustworthy join workbench — highest immediate product value.** Finish inspector + fixed-window comparison + protected dry-run repair as one coherent workflow. Show source/probe coverage, actual status, before/after windows, loudness/headroom, and preview artifacts. Add plan revisions/undo so an accepted mix can be repaired without losing its known-good revision. Dependencies: R1–R5, R13–R14.
- **Versioned audition regression corpus — highest engineering value.** Replace scattered one-off listening scripts with a repeatable local corpus runner and compact report. Separate tuning from holdout cases and measure false passes as well as false alarms. This makes analyzer, planner, mixer and renderer changes comparable without retuning against whichever joins were heard most recently. Dependencies: R5–R6, R8–R9.
- **Confidence-aware safe mix intervals — high musical value.** Store local timing confidence, drift/phase evidence and usable interval coverage; select stable entry/exit regions instead of excluding an entire track. Unknown is a first-class outcome. Demonstrate recovering usable music without increasing known-bad joins. Begin with interval selection, not variable-tempo warping. Dependencies: R3–R6, R10–R11.
- **Explicit replay, fresh and discovery modes — useful continuation.** Expose frozen-history replanning versus immutable context replay and current-policy replanning distinctly. Show which history, feedback and policy inputs differ; make catalog/evidence changes explainable. Dependencies: R7–R9.
- **Approval recall and catalog health — contained followups.** Suggest an existing approved exact-pair treatment with its window/content identity, never transfer approval silently. Provide family-key collision overrides, suspect-evidence reasons, stale-analysis reasons and logical quarantine. Cross-pair recipe suggestions should come later, once exact-pair identity is dependable.
- **Local vocal collision and dynamics-aware planning — experimental.** Start with observable per-window energy/overlap diagnostics and auditioned suggestions. Validate their incremental benefit over existing groove/continuity features before committing to vocal models, stems or new automatic templates.

Defer broad architecture rewrites, stronger uncalibrated exclusion thresholds, automatic promotion of advisory audio verdicts, and large DSP/model features until the above boundaries are trustworthy. The repo already has enough capability to produce a strong mix; the next gains come from making the planner’s intent, the saved recipe, the rendered audio, and the checker’s evidence agree.
