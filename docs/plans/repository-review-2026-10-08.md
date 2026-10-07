# Repository review and implementation handoff — 8 October 2026

## Recommendation

Keep the current local-first architecture. The largest quality gains now come from making timing, evidence, and verification agree across the analyzer, planner, renderer, and checker. More threshold tuning should follow that work, not precede it.

The first implementation batch should fix three reproduced problems: the checker can apply an alignment offset twice; its rendered-audio path cannot independently verify beat alignment and treats an inconclusive result as an override; and the structural groove gate examines the wrong outgoing interval. These affect the reliability of the feedback used to tune everything else.

This document is a handoff plan, not an implementation. No application source, tests, configuration, catalog, or music files were edited for this review. Existing uncommitted analyzer work belongs to the parallel implementation agent.

## Scope, baseline, and evidence

Reviewed baseline: `8dc011001a187a0ef326fb7f99d7209dc56c8334`. The checkout also contained six modified files implementing DSP 3.12 diagnostics: the DSP analyzer, its two test files, the catalog analysis test, domain analysis types, and domain constants. Findings about that work are explicitly marked provisional.

The review covered package boundaries, domain contracts, configuration, catalog storage and scanning, enrichment, evidence selection, DSP and key analysis, plan selection and timing, transition editing and recall, rendering and QC, worker/workflow ownership, CLI/MCP entry points, native tooling, CI, tests, and the existing architecture/beatmatching/debt plans. It traced the highest-risk paths and used focused reproductions; it is not a claim that every line was exhaustively verified.

Validation on this working tree:

- `pnpm test`: **62 test files, 525 tests passed**, 328.80 seconds, including native integration tests enabled in this environment.
- `pnpm typecheck`, `pnpm lint:exports`, and `pnpm format:check`: passed.
- `pnpm lint`: passed with three existing maximum-file-length warnings: DSP analyzer, render coordinator, and catalog service.
- Local runtime: Node 24.11.0, pnpm 11.25.0; the repository pins pnpm 11.24.0. This was local validation, not a new CI run.
- Additional in-memory probes reproduced the offset error, wrong groove interval, inconclusive rendered-audio alignment result, descriptor-schema field loss, and preservation of an old transition after reordering. These probes did not add test files.

No new listening audition, whole-library reanalysis, dependency vulnerability audit, or external-provider live test was performed. Historical listening results below come from repository notes and the user's update, not new listening in this review. A green test suite therefore does not resolve the musical regressions described below.

Priority convention: **P1** should precede new automatic mixing policy; **P2** is the next correctness/maintainability batch; **P3** is optional or measurement-dependent. “Reproduced” means a focused executable probe demonstrated the behavior. “Code-traced” means the control/data flow supports the finding but an end-to-end failing fixture still needs to be added.

## Recent work and coordination boundary

- `5c50e5e`: cleans the large FFmpeg fixture in `finally` and adds stale `dnb-*` directory sweeping. The original leak fix is already delivered. Remaining cleanup/ownership issues are a separate followup, F10.
- `4b042d3`: changes checker projection to include the stored offset and removes the whole-beat tripwire. Removing the tripwire is consistent with beat-phase equivalence. The projection change still violates the placed-source-coordinate contract in a reproducible case; see F1. The reported improvement on historical joins is useful evidence, but does not cover both alignment-placement paths.
- `8dc0110`: snaps section-derived phrase origins to actual downbeats. The phrase-mode snap followup in the user's backlog is **already committed**. Do not implement it again; extend regression coverage around its invariants.
- `54d64d9`: introduces automatic recent-plan variety and artist rotation. Useful behavior, but its input history is not fully frozen or explained; see F8.
- Recent DSP 3.9–3.11 work adds backbone syncopation, per-bar groove evidence, sparse-head holds, bass-swap glides, and reference-BPM rescue. These are sensible incremental improvements. They need a stable regression corpus and correct source-window selection before further calibration.
- **In progress, not a separate assignment:** DSP 3.12 grid-phase scan, suspect flag, and beat-phase histogram. Let the existing agent finish. Coordinate integration of schema coverage and diagnostic confidence after it lands; do not reset, overwrite, or duplicate those files.

Before implementation, re-read HEAD and the dirty-file list. Line references in this document describe the reviewed snapshot and will move. Preserve the user's existing auditions and approvals; a new code finding is not evidence that every approved mix must be redone.

## Architecture assessment

### Domain and contracts

The domain package provides a useful common vocabulary for timing, musical policy, persisted plans, and public schemas. Strict TypeScript, package dependency rules, and export checks are good foundations. The main weakness is duplicated representations: hand-written types, Zod schemas, persisted JSON, and recipe parameter records can disagree while typechecking remains green. F5 addresses a demonstrated instance. Resolve timing into explicit source/output intervals rather than passing ambiguous numeric fields and relying on comments to distinguish provenance from operations.

### Catalog, scanning, persistence, and evidence

SQLite repositories, migrations, selected rhythm/structure/key evidence, canonical metadata precedence, and missing-file/move handling are appropriate for a local music library. The architecture does not need a service split. The weak boundary is the transition from mutable catalog state to frozen jobs: canonical facts are incompletely captured, and execution checks the live rather than queued file fingerprint. F4 separates these concerns. Validate high-impact persisted JSON at read boundaries with explicit version handling rather than treating TypeScript casts as runtime validation.

### Analyzer and native key stage

The DSP engine is deterministic and exposes useful intermediate evidence. Separating KeyFinder from rhythm analysis, preserving rejected-grid status, and using hints without promoting them into accepted grids are good choices. The greatest needs are dependency-aware freshness, invalidation of grid-indexed features after anchor changes, better confidence/coverage reporting, and cross-format regression data. Avoid replacing these explainable heuristics with a larger model before measuring their errors.

### Planner, timeline, and repair

Candidate scoring, bounded lookahead/search, constrained repair, phrase windows, onset lock, chain-tempo policy, and approved recipe handling are substantial capabilities. However, feasibility, feature extraction, template choice, and source-window placement are spread across paths. The full-plan chooser, standalone transition proposer, and editor can disagree. F3, F6, and F7 suggest a shared resolved-join result, introduced through correctness fixes rather than a broad rewrite. Keep source-window identity attached to every local score and rejection reason.

### Mixer and renderer

Float intermediates, Rubber Band R3 identity checks, join-only stretch, head/body/tail rate regions, original-pair rendering, consistent crossover reconstruction, static loudness gain, encoded true-peak verification, and staged listen-file publication are valuable safeguards. Preserve these. The important gaps are coordinate semantics, frozen source identity, checker independence, and scratch ownership. The existing pairwise-stitch performance work was deliberately parked after measurement; there is no review evidence that it should outrank correctness now.

### Feedback, recipes, and human review

The approval registry and hour/transition feedback offer a strong basis for safe improvement. Approval applicability should remain tied to pair, source, analysis, and recipe identity. Current notes sometimes imply unconditional recipe recall, while `chooseTransition` only invokes recipe reuse when the lookup requests `reuseForPair === "recipe"`. Clarify that policy before building recommendation UX. Reordering/editing must not quietly carry approval or transition settings to a different pair.

### Jobs, workers, and workflows

Persisted queues, resumable workflows, cancellation, a single catalog worker owner, and heartbeat recovery are suitable for the workload. Synchronous DSP still blocks the event loop; a sufficiently long pass can outlast the five-minute ownership window. The old owner also keeps an in-memory `owned` flag after a takeover. Treat this as a stress-test/fencing task, not evidence of a normal-duration failure. Use owner tokens to fence job claims and completion before adding more concurrency.

### CLI, MCP, enrichment, and developer tooling

Thin CLI/MCP adapters and shared service contracts are a good direction. Public analysis output schemas lag the stored descriptors. Keep errors and “unmeasured” states explicit in tool output so an implementation agent or host model cannot mistake missing evidence for success. Enrichment has useful timeouts, cache TTL, rate limiting, and provenance; cancellation during provider waits and crash-safe cache publication merit targeted hardening, not a provider rewrite. CI covers Linux with native dependencies, while this review ran on Windows. Add a bounded Windows smoke lane for paths, native process execution, locks, cancellation, and cleanup.

## Findings and required changes

### F1 — P1: checker can apply an already-baked alignment offset again

**Reproduced.** [Checker projection](C:/Users/arild/repos/dnb-crate/packages/catalog/src/render/coordinator.ts:664) uses `incoming.sourceStartMs + outgoing.downbeatOffsetMs`. But [bakeWindowAlignment](C:/Users/arild/repos/dnb-crate/packages/catalog/src/planning/windows.ts:383) already changes the source window, and [recipe version 1 handling](C:/Users/arild/repos/dnb-crate/packages/catalog/src/render/coordinator.ts:1105) deliberately skips another application. The legacy renderer branch also mutates the prepared segment before the manifest is produced. The manifest's `sourceStartMs` is the placed source coordinate, not an unadjusted cue.

A focused checker probe used outgoing beats `10000 + n*345`, incoming beats `80 + n*345`, an outgoing overlap beginning at 10000 ms, and an already-placed incoming start of 80 ms with recorded offset 80 ms. Projection from the actual starts yields **0 ms**. `checkRender` reports **−80 ms** and the stored-grid failure when the optional PCM diagnostic is unavailable.

Alignment may move the outgoing window instead, so “always add/subtract the offset on incoming” is not a sufficient correction.

**Implement:** define the manifest coordinate contract, distinguish applied transforms from historical alignment metadata, and project each deck from its actual placed interval and rate map. Handle legacy manifests explicitly. Preserve the removed whole-beat tripwire's removal; do not restore it to compensate.

**Acceptance:** baked incoming shift, baked outgoing shift, negative-start fallback, zero shift, whole-beat-equivalent shift, non-unit rates, legacy recipes, preview/full render parity, and three-track head/body/tail cases. Include rendered click fixtures, not only assertions against the same projection helper.

### F2 — P1: rendered-audio verification is inconclusive but can clear a failure

**Reproduced and code-traced.** [diagnoseRenderedMix](C:/Users/arild/repos/dnb-crate/packages/catalog/src/render/audio-diagnostics.ts:215) supplies the same mixed PCM for both decks and empty expected beat arrays. The resulting path has no independent deck-grid evidence; it does not implement the documented kick/snare coincidence-versus-shift verifier. Synthetic aligned clicks and clicks with 100 ms and approximately half-beat offsets all returned `advisory`, a null worst residual, and “insufficient onsets for independent grid fit.”

[checkRender](C:/Users/arild/repos/dnb-crate/packages/catalog/src/render/coordinator.ts:738) only attempts this scan for joins already failing the stored-grid residual. It then allows **advisory** to suppress that failure. A wrong grid that reports zero is not checked at all. The decoded eight-second window is centered on the overlap **start**, despite the comment saying midpoint; it misses most of a long overlap. Diagnostic reasons and measurement coverage are not propagated into the join report.

**Implement in two steps:**

1. Make reporting honest immediately: distinguish measured pass, measured fail, review, and insufficient/unmeasured evidence; inconclusive diagnostics must not act as proof of corrected alignment. Preserve explicit user override semantics and legacy “no evidence” handling.
2. Add an independent verifier using actual placed/stretched deck probes and the final blend. Report kick/snare timing, ambiguity, confidence, and coverage across start/middle/end of the overlap. A mixed waveform alone cannot reliably identify which deck owns a transient. Run coverage on aligned joins, not only already-red geometric checks; provide an explicit fast/full mode if decoding cost requires it.

Keep geometric and audio residuals separate. A confident audio contradiction can become actionable only after calibration; absence of evidence cannot silently cancel either measurement. Treat PCM decode/measurement failures as unavailable with a reason, and clean diagnostic files in `finally`. Also check native exit codes in silence measurement. The measured local level step is currently informational while the gate uses planned LUFS; name those separately. The error text says 3 LU although the constant has moved to 5 LU.

**Acceptance:** synthetic aligned/shifted/drifting decks, a wrong-but-self-consistent stored grid, a whole-beat phase-equivalent shift, sparse builds, offbeat hats, syncopated kicks, triplets, clipping, an intentional bass breather, decode failure, and a defect in the middle/end of a 32-bar overlap. A known bad case must never pass solely because evidence is missing. Use the historical praised joins to measure false positives before changing production gates.

### F3 — P1: the local groove gate reads the outgoing pre-overlap material

**Reproduced.** [chooseTransition](C:/Users/arild/repos/dnb-crate/packages/catalog/src/planning/timeline.ts:377) reads from `mixOutMs - 16 * outgoingBarMs`. Elsewhere, `mixOutMs` is the **start** of the outgoing overlap: the source end is derived by adding the overlap duration. [localSyncopation](C:/Users/arild/repos/dnb-crate/packages/catalog/src/planning/shared.ts:178) then measures 16 bars from the supplied start.

A fixture with an explicit outgoing overlap at bar 64 demonstrates the reversal. A syncopation conflict only in bars 48–63 produces `crossfade`, while the same conflict only in actual overlap bars 64–79 produces `phrase_mix`. Existing groove fixtures use constant per-bar syncopation, so they cannot expose this indexing error. The fixed 16-bar span also does not represent both 8- and 32-bar overlaps.

There is a related locality gap: `grooveCompatibility` and `sparseOverlapPenalty` use file-tail/file-head slices. They can score different material from the selected internal phrase window, including when groove compatibility triggers automatic bass swap.

**Implement:** derive both feature slices from the final, aligned source intervals and actual output duration/rates. Carry sampled intervals, measurable-bar counts, and confidence into the explanation. Evaluate complete long overlaps or documented subregions, without reading unheard bars for shorter windows. Make missing/sparse evidence an explicit abstention.

**Acceptance:** distinguish conflict before, within, and after the overlap; cover 8/16/32 bars, nonzero bar origins, fractional source boundaries, onset slips, unequal rates, and sparse regions. Recalculate the existing labeled calibration pairs using the corrected intervals before retaining or changing the 0.58 threshold. Do not tune a threshold to preserve a bug's measurements.

### F4 — P1: frozen jobs still depend on mutable source and canonical metadata

**Code-traced; missing-analysis snapshot behavior reproduced.** Two separate defects should be implemented as separate commits.

**F4a — source identity:** [hydrateSegment](C:/Users/arild/repos/dnb-crate/packages/catalog/src/render/coordinator.ts:1565) hashes the current file and compares it with the **live track** fingerprint. It does not compare with the fingerprint captured in the queued request. Replacing a file and rescanning can therefore make the live check pass while an older queued plan and old evidence render different audio. The [catalog fingerprint](C:/Users/arild/repos/dnb-crate/packages/catalog/src/fingerprint.ts:12) hashes size plus first/last 64 KiB; same-size edits in the interior are invisible even without a rescan.

Use frozen source identity as an execution precondition. Separate cheap move-detection identity from a strong render-input identity. Decide and document when full content hashes are computed/cached; a head/tail fingerprint must not be described as proving byte identity. Define an explicit legacy-job policy and allow path relocation when content identity is preserved.

**F4b — canonical evidence:** [snapshotTrackEvidence](C:/Users/arild/repos/dnb-crate/packages/catalog/src/evidence.ts:127) takes analysis rows but not canonical track metadata. Manual/published keys can be absent or replaced by analyzed keys in the snapshot. [Frozen quality evaluation](C:/Users/arild/repos/dnb-crate/packages/catalog/src/service/quality-evidence.ts:65) then mixes frozen keys/confidence with live key source and live validation inputs. A snapshot with no analysis has `present: false`, null key, and null confidence even when the catalog has a valid manual key. A plan can pass live quality and fail queued quality, or change its result after later metadata edits. The existing lean-codebase plan already identifies part of this debt.

Freeze canonical BPM/key/energy and relevant provenance separately from rhythm-grid presence; use a coherent frozen quality context. Preserve “absent analysis” without interpreting it as “absent canonical metadata.” Freeze independent selected-engine identities and versions, not only the merged rhythm analyzer version.

**Acceptance:** enqueue → change file → rescan → execute must reject incompatible source identity; an interior-only edit must be covered by the chosen strong identity; moving identical content must remain supported. Manual/published keys without analysis, conflicting analyzed keys, split engine selections, and post-enqueue metadata/reanalysis changes must yield the intended stable quality result. Preview identity must change whenever effective frozen inputs change.

### F5 — P2: public descriptor schema drops implemented fields

**Reproduced.** [SonicDescriptors](C:/Users/arild/repos/dnb-crate/packages/domain/src/analysis.ts:70) includes committed `grooveSyncopation`, `backbeatConcentration`, and `bars.syncopation`; [the Zod contract](C:/Users/arild/repos/dnb-crate/packages/domain/src/analysis-contracts.ts) omits them. The in-progress phase fields are also missing. Parsing a descriptor through that schema demonstrably removes these fields. MCP advertises the schema; this review does not assume its SDK necessarily strips the raw response on the wire, but schema-driven clients cannot depend on the omitted data.

[type-mirror-checks](C:/Users/arild/repos/dnb-crate/packages/domain/src/type-mirror-checks.ts:1) covers only selected planning/feedback pairs. Its bidirectional structural assignability assertions do **not** catch every added optional property, contrary to the comment. Simply adding another assignment pair is insufficient.

**Implement:** reconcile the descriptor schema and public types, retain optional/backward-compatible semantics, add key-set or appropriate exact-type guards, and add populated runtime round-trip fixtures. Prefer one authoritative representation where practical; avoid a repository-wide type rewrite for this fix.

**Acceptance:** every committed descriptor, plus the finalized 3.12 fields, survives API/schema serialization; legacy descriptors lacking optional fields remain valid; a deliberately added unmatched optional field fails a contract guard. Coordinate with the existing diagnostics agent.

### F6 — P2: standalone transition proposals can bypass the shared groove fallback

**Code-traced.** [propose](C:/Users/arild/repos/dnb-crate/packages/catalog/src/planning/transition-planner.ts:140) calls `chooseTransition`, but primarily consumes its rates and window. When that chooser returns a structural-conflict crossfade with no window, the proposer can calculate a new phrase window and still return the requested aligned template as feasible. `validateTransition` inherits this proposal logic. The ordinary `preferredType: "any"` path is affected; this is not only an explicit unsafe override.

**Implement:** separate template eligibility from template preference. Reuse the same resolved-window feasibility and rejection reasons in set planning, transition proposals, validation, previews, and editing. Explicit override modes must be distinguishable from ordinary feasible suggestions. Preserve valid manual treatments and recipe policy.

**Acceptance:** the same pair/window has the same structural eligibility in all entry points, with consistent reasons. Include a pair the full planner rejects, sparse unknown evidence, tempo mismatch, a permitted recipe, and explicit override behavior. Do this after F3 corrects the evidence window.

### F7 — P2: moving an entry preserves transition settings for its old neighbor

**Reproduced.** [moveEntry](C:/Users/arild/repos/dnb-crate/packages/catalog/src/service/plan-editor.ts:174) reorders entries and rebuilds with existing entries keyed by track ID. [buildEntries](C:/Users/arild/repos/dnb-crate/packages/catalog/src/planning/timeline.ts:619) reuses any existing outgoing transition without checking its former incoming track. Moving `[A,B,C,D]` to `[A,C,B,D]` retained A's `A -> B` parameter marker and `B-specific-cue` on A → C in a focused probe. Numeric validation cannot establish that these are still the intended musical settings. Edited plans also save the old explanation.

**Implement:** identify transitions by ordered pair plus effective recipe/evidence context. Invalidate changed adjacencies and affected rate/window dependencies; preserve genuinely unchanged approved joins. Recompute explanations or mark their selection rationale stale, rather than presenting old rankings as current.

**Acceptance:** moves at the beginning/middle/end, swaps, insertion/replacement, and removal preserve only unaffected adjacencies. New pairs receive newly validated cues/automation. Test chain-tempo dependencies beyond immediate neighbors. Update approval hashes and explanations consistently.

### F8 — P2: automatic freshness adds unrecorded planning inputs

**Code-traced.** [createSetPlan](C:/Users/arild/repos/dnb-crate/packages/catalog/src/service.ts:594) automatically picks history when explicit references are absent. It fetches 12 recently updated plans before filtering for at least eight entries and taking six. Thus short drafts can hide older qualifying history; merely generating/editing a candidate can change future planning. There is no explicit distinction between auditioned mixes and discarded drafts.

[finalize](C:/Users/arild/repos/dnb-crate/packages/catalog/src/planning/finalize.ts:88) only includes variety explanation when `brief.variety` was supplied. Auto-selected history and artist-use counts are not fully persisted. “Same catalog + constraints + seed → same plan” is no longer a sufficient reproducibility contract.

**Implement:** add explicit `auto`, frozen-reference, and off semantics; freeze the resolved history inputs, policy version, normalized brief, and relevant analysis identities for replay. Define eligibility/order deliberately, applying filtering before limiting. Explain artist and recording penalties in auto mode. Keep the useful fresh-mix default unless the user changes it.

**Acceptance:** replay with frozen context remains stable despite added/edited/deleted reference plans; auto mode deliberately changes with eligible history; drafts and short plans follow documented policy; an explicit off mode is unambiguous. Verify artist normalization for collaborations before strengthening artist penalties.

### F9 — P2: analysis freshness omits inputs and anchor edits leave stale features

**Code-traced.** [dspCurrent](C:/Users/arild/repos/dnb-crate/packages/catalog/src/analysis/coordinator.ts:281) checks analyzer version, fingerprint, and canonical reference BPM, but not all analysis inputs such as configured tempo range and anchor. Explicit IDs or `scope: "all"` still pass through the current-row skip. Documentation tells users to rerun after changing the tempo range, but that can perform no DSP work.

[setBeatAnchor](C:/Users/arild/repos/dnb-crate/packages/catalog/src/analysis/coordinator.ts:110) rebuilds beats/downbeats while spreading the existing analysis row, retaining grid-indexed sections, kick/snare arrays, per-bar syncopation, and other descriptors. They now describe the previous grid. The row can still appear current. Freshness decisions also exist separately in scope selection, workflow readiness, and key-stage logic.

**Implement:** introduce a versioned analysis-input identity and shared freshness resolver, with explicit force/recompute semantics. Include effective tempo bounds, reference BPM/source, anchor, decoder policy, source identity, and engine identity as applicable. An anchor edit must recompute dependent features or invalidate them until recomputation; preserve independent measurements where valid. Align scope selection and execution so requested work is not silently skipped.

**Acceptance:** changing tempo range, beat anchor, reference BPM, source contents, selected evidence, or native key executable triggers the right stages. Cover manual/published-key tracks after rescan, failed/pending stages, and idempotent unchanged reruns. Old descriptors must never be interpreted against a new grid origin.

### F10 — P2: cleanup now needs ownership, not just age and naming

**Code-traced risk plus remaining cleanup omissions.** [temp-sweep](C:/Users/arild/repos/dnb-crate/packages/catalog/src/render/temp-sweep.ts:21) recursively deletes any old OS-temp directory starting `dnb-`, using directory mtime and a one-hour threshold. Directory mtime is not proof that children are inactive, and multiple catalogs/tests share the namespace. No active-work loss was observed in this review, but a long-running job can meet the deletion predicate.

Some catalog fixtures still register only catalog closure rather than removal of the fixture root, for example [render tests](C:/Users/arild/repos/dnb-crate/packages/catalog/test/render.test.ts). The new Phase 4 PCM path has no `finally` cleanup on decode/read failure, uses a deterministic per-output filename, and is absent from the sweeper patterns. Concurrent checks can also collide on that filename.

**Implement:** provide owned, uniquely named scratch scopes for production and tests, with unconditional cleanup and explicit retained-debug output. Sweep only recognized abandoned work, excluding active leases/owners and validating containment. Keep the already-delivered large-fixture fix. Do not broaden wildcard deletion to chase every leak.

**Acceptance:** successful/failed/cancelled jobs and tests clean their own files; concurrent checks use distinct scratch paths; a live job older than the age threshold survives; stale abandoned owned scratch is removed; unrelated and symlink-escaped paths are preserved. Test fake time and owner state rather than waiting an hour.

## Beatmatching plan audit

Source plans: [beatmatching automation](C:/Users/arild/repos/dnb-crate/docs/plans/beatmatching-automation.md) and [listening evidence/followups](C:/Users/arild/repos/dnb-crate/docs/beatmatching-followups.md).

### Phase 0: foundational timing and onset lock

Implemented, with useful tests for anchoring, sub-beat composition, feasibility, and provenance. The new phrase-origin snap is a natural correction. Extend it with an end-to-end invariant: the planner's final source windows, renderer's actual placement, manifest, and checker must describe the same two deck timelines. Regressions should include a section boundary 204 ms off-grid, non-unit rates, fractional beat periods, a window near audio bounds, and accepted onset-lock slips. Checking only the origin helper is insufficient.

### Phase 1: held incoming fades

Implemented in the handoff policy. The plan still says a dedicated before/after sparse-head audition is pending, while the followup notes broadly declare the overall plan auditioned. Link an actual before/after acceptance to this specific behavior if it exists; otherwise perform one targeted preview comparison. Do not repeat unrelated full-hour auditions. Include a preserved good dense-out/sparse-in join to ensure the policy distinguishes quiet pads from a conflicting sparse groove.

### Phase 2: feel-conformance analysis

Backbone syncopation and local series exist. The decision to reject a whole-track hard gate was supported by counterexamples and should be retained. However, F3 means the current “overlap-local” implementation is not measuring the claimed outgoing material. Treat the existing threshold as provisional after that correction. The historical corpus contains useful labels, but a large library distribution is not a large labeled validation set. Separate tuning cases from a held-out set and cover tempos/grooves beyond the mostly 174 BPM calibration material.

### Phase 3: automatic bass swap plus glide

Implemented. The followup records five groove-triggered bass-swap/glide joins passing audition, so the older “pending audition” phase status should be reconciled with those references. Keep `lowFadeBars` and the praised recipes. Fix the local evidence used to trigger the treatment before expanding automatic selection. Evaluate the intended treatment against the same source windows; changing windows and fades together makes attribution difficult.

### Phase 4: post-render audio verification

**Implemented only partially; the claimed independent beat-verification acceptance is not met.** The source has audio diagnostics, but the current production call cannot substantiate the documented onset-coincidence claim. A historical green `render:check` and good listening report do not validate its ability to reject deliberately bad joins. Reopen this phase with F1/F2 and negative controls. Avoid presenting all former green checks as proof of alignment, while preserving their listening evidence.

### Phase 5: recipes, tempo lock, label-swap research

Recipe storage and deliberate recall are present; “similar previous approval” UX remains useful. Chain-tempo lock is implemented and documented; gradual tempo walking remains an optional later experiment.

Keep label-swap correction in research until an independently labeled case establishes the phenomenon. The notes currently mix “±2 beats” with “±172 ms”: at 174 BPM, one beat is approximately 345 ms, half a beat 172 ms, and two beats 690 ms. Define each hypothesis in beat units and converted milliseconds. A whole-beat offset, offbeat groove, wrong downbeat label, and time-varying drift are different problems. Do not infer a label swap merely because a join gallops.

### DSP 3.12 diagnostics: integration review for the existing agent

The proposed stored phase scan and histogram are valuable diagnostic outputs. Keep them advisory initially. The reviewed implementation measures a dominant phase from a broadband tempo envelope, samples at most six 30-second regions, and exposes an aggregate maximum rather than the measured region list and per-region confidence. A synthetic correctly gridded signal with stronger offbeat pulses produced approximately 172 ms of apparent phase error. That demonstrates ambiguity between rhythmic content and a wrong grid, not that the feature should be discarded.

After the current work lands:

- Complete F5 schema integration and round-trip coverage.
- Store region bounds, phase candidates, confidence/ambiguity, and measurement coverage alongside any aggregate; preserve null for insufficient evidence.
- Consider separate kick/snare evidence before promoting a broadband suspect flag to an automatic grid veto or correction. Offbeat hats, chopped drums, triplets, and sparse intros need explicit fixtures.
- Distinguish constant phase offset, steady tempo error, local drift, and content disagreement. A max-error scalar cannot choose the right repair.
- Connect diagnostics to analysis reports and join inspection. A whole-track histogram is useful triage, but local compatibility should eventually use the actual overlap's histogram.

## Additional code-quality and operational work

These are smaller confirmed inconsistencies or measurement-dependent risks, not equal in urgency to F1–F4.

1. **Extract by responsibility after regression tests exist.** The analyzer, render coordinator, and service are the current lint hotspots. Good boundaries are analysis-input identity, feature extraction, resolved join geometry, immutable render preparation, and QC result aggregation. Move PCM diagnostic math out of catalog orchestration into the audio-analysis package when revising F2. Keep the catalog responsible for persistence and process coordination. Avoid splitting solely to satisfy a line count.
2. **Make persistence boundaries explicit.** Render requests/manifests, analysis descriptors, recipes, and portions of saved plan metadata use JSON parsing/casts. Introduce versioned runtime validation for these high-impact objects, with a deliberate legacy migration policy. Report a useful corrupt/unsupported-data error. Do not use a new schema that silently strips previously stored fields, and do not revalidate every internal object at every call.
3. **Centralize coordinate contracts.** Use small domain value types or named records for source milliseconds, output milliseconds, beat index, bar index, and interval boundaries. A resolved join should include both deck ranges, rate regions, the selected template, evidence windows, and transform provenance. Use the same result for preview, full rendering, explanations, and QC. This addresses the repeated integration defects without replacing the planner algorithm.
4. **Normalize or explicitly support decoder differences.** [loadPcmForAnalysis](C:/Users/arild/repos/dnb-crate/packages/catalog/src/analysis/load-pcm.ts:13) decodes supported WAV directly at its native sample rate, while other formats pass through 22.05 kHz mono PCM. Fixed DSP window/hop sizes can therefore change time/frequency resolution by input container/rate. Add same-audio WAV/FLAC and 22.05/44.1/48 kHz parity fixtures, choose a documented normalization policy or make resolution sample-rate aware, and include that policy in freshness. Harden WAV format/chunk validation so malformed or unsupported data falls back or fails predictably.
5. **Fence worker ownership.** In [worker-owner](C:/Users/arild/repos/dnb-crate/packages/catalog/src/worker-owner.ts), detect a token-scoped heartbeat update affecting no row and stop claiming/completing work under a lost token. Use a deterministic two-owner takeover test. Profile long-file DSP memory and event-loop stalls; introduce worker-thread isolation only if measured stalls justify it. Do not simply increase the stale timeout indefinitely.
6. **Record effective engine and policy identity.** Rubber Band path/hash freezing is strong. FFmpeg identity is recorded in output but is not frozen with the same guarantees; renderer/checker policy changes can also occur without a corresponding semantic version bump. Document which version changes invalidate new preview cache identities and which queued jobs must refuse execution. Separate checker-version provenance from immutable render provenance so later rechecks remain interpretable.
7. **Improve native failure/cancellation coverage.** Exercise cancellation during decode/stretch, provider backoff, and output publication. Keep provider response-cache writes recoverable under interruption. Verify no partially published output is reported as a successful measurement. Use short deterministic process fixtures where possible.
8. **Update living documentation as part of fixes.** Mixing/scoring docs still say the planner never automatically selects bass swap; rendering docs and error messages still describe a 3 LU limit; beatmatching notes describe a stronger audio verifier than exists; the determinism statement omits automatic history. Replace stale status assertions with links to exact tests/auditions and versioned behavior. Keep old experiment results as dated evidence rather than current policy.
9. **Add focused cross-platform CI.** Preserve the full Linux/native lane and add Windows smoke coverage, given Windows is an active development/runtime platform. Cover spaces/non-ASCII paths, argument handling, file-lock behavior, rename/publication, process cancellation, and temp cleanup. No new platform support promise is necessary for this lane.

The existing [lean-codebase plan](C:/Users/arild/repos/dnb-crate/docs/plans/lean-codebase.md) should remain the record of completed cleanup. Its measured pairwise benchmark was 108.3 seconds/269 MB for 20 joins and 317.7 seconds/523 MB for 40. Those historical synthetic measurements justify leaving the stitching rewrite parked until user workloads or a refreshed benchmark show a problem. They are not a guarantee for every real library.

## Implementation sequence

Suggested sizes describe scope, not elapsed-time commitments: S is a focused change, M spans a few boundaries, L needs new measurement/calibration infrastructure. Each numbered batch should remain independently reviewable; split source identity and canonical metadata into separate changes.

1. **Establish trustworthy coordinate checks — M.** Implement F1 with regression fixtures that fail on the current snapshot. Include phrase-snap integration coverage for the already-shipped fix. Document placed coordinates and offset provenance. This is the first task.
2. **Stop inconclusive QC from masquerading as verification — S/M.** Implement F2's status/coverage/exit-code/cleanup corrections. Update misleading docs and messages in the same change. Do not claim the independent verifier is complete yet.
3. **Correct local musical evidence and feasibility parity — M.** Implement F3, then F6; recalibrate labeled windows and audition only changed decisions. Record old/new source intervals and reasons. Avoid mixing threshold changes with unrelated template redesign.
4. **Close immutable-job gaps — two M changes.** Implement F4a source identity and F4b canonical evidence. Specify legacy behavior before changing job persistence. Extend preview-cache tests with frozen effective inputs.
5. **Land the existing diagnostics, then contracts/freshness — S plus M.** Integrate, rather than duplicate, the active DSP 3.12 work. Implement F5; implement F9 separately so anchor/config invalidation can be reviewed as a behavioral change. Keep new suspect diagnostics advisory pending calibration.
6. **Make editing and replay reliable — two M changes.** Implement F7 pair-aware invalidation, then F8 persisted planning context. Preserve unchanged approved joins. These are prerequisites for dependable “repair just this join” and fresh/replay UX.
7. **Build the independent audio quality harness — L.** Complete F2's measurement work after geometry and evidence are trustworthy. Establish a synthetic regression suite and a local, labeled listening corpus with positive and negative controls. Use separate tuning and holdout sets. Measure false-pass, false-fail, abstention, coverage, and decode cost. Promote only sufficiently calibrated signals into gates.
8. **Harden operations — M, divisible.** Complete F10, worker fencing, persisted-input validation, and Windows smoke coverage. Profile before undertaking thread isolation or stitch optimization. Fold small extraction work into the relevant batches instead of creating a large refactor first.
9. **Build one user-facing feature from the shortlist below.** Start with join inspection or surgical repair, depending on whether diagnosis or iteration is the larger pain after the fixes.

Parallelizable work, if the implementation owner chooses to delegate: contract coverage after diagnostics stabilize, source freezing, and isolated fixture cleanup. Geometry, groove-window calibration, and independent QC should be sequenced because they share semantics. This review did not start additional agents or send work to the existing agent.

## Features worth building

### 1. Join inspector and preview comparison — highest near-term value

Produce a persistent review artifact for a selected join: both source windows on one output timeline; beat/downbeat markers; kick/snare evidence; local groove and level estimates; phase/drift confidence; selected template and why alternatives were rejected. Offer two or three bounded variants, such as current treatment, alternate safe window, and bass-swap glide, with comparable loudness and frozen inputs. Capture approval or a reason-coded rejection on the exact variant.

Start with structured CLI/MCP output plus preview artifacts; add an interactive view only where it helps. Prerequisites: F1–F3, F5, and honest QC status. Success means the user can identify the evidence behind a bad join and compare a treatment without manually reconstructing source positions. This also gives the implementation agent a much better debugging surface.

### 2. Surgical repair with protected approved joins — high value

Support “repair join 7, preserve these approved joins” and “replace this track while retaining the rest of the hour.” Reuse the current bounded repair search and recipe registry. Explicitly represent protected pairs/windows and surface any chain-tempo or duration consequence before changing them. Return a small plan diff and previews of affected joins.

Prerequisites: F4, F7, and stable pair/window identity. Success: unrelated approved joins keep their effective recipes, while every changed adjacency and timing dependency is revalidated. The historical manual rescue that kept 24 of 26 entries is a useful product example; it should not require bespoke scripting.

### 3. Confidence-aware safe mix zones — promising analyzer/planner extension

Instead of declaring an entire track mixable/unmixable, describe intervals with reliable phase, stable tempo, measurable groove, and usable dynamics. The planner can avoid a drifting outro or triplet passage while using a clean introduction. Explain whether rejection came from grid uncertainty, content conflict, or lack of usable overlap length.

Prerequisites: F3/F9 and local diagnostic confidence. Begin with selecting stable regions; defer variable-tempo warping until a separate, auditioned need exists. Success: retain usable music currently excluded wholesale, without reducing the rejection rate for known bad windows.

### 4. Replay/fresh/discovery controls — useful, relatively contained

Expose exact replay, fresh against selected listening history, and deliberate discovery modes. Explain the tradeoff between familiarity, artist rotation, constraints, and transition quality; do not reduce safety thresholds merely to find unheard artists. Distinguish generated, rendered, auditioned, and accepted history.

Prerequisite: F8. Success: replay is reproducible, fresh mode's history is visible, and discovery increases selected underused recordings/artists within the same quality constraints.

### 5. Similar approved treatment suggestions — useful after identity fixes

At review time, surface a prior successful pair/window or a structurally similar treatment with its applicability and confidence. Offer explicit reuse or a preview; do not automatically generalize one liked transition into a universal policy. Present separate reasons for stale source, changed analysis, changed tempo, and incompatible window.

Prerequisites: F4/F7 and an explicit recipe recall policy. Start with exact ordered-pair matching before cross-pair similarity. Success: fewer repeated manual edits with clear provenance and no approval carried to an unintended pair.

### 6. Vocal-overlap and local dynamics awareness — experimental

A local vocal-activity estimate could avoid two lead vocals colliding; regional loudness and low-band occupancy could improve handovers that global LUFS cannot describe. First collect labeled examples and expose advisory diagnostics. Use them for window ranking and bounded gain/envelope choices only after validation. Neither requires immediate source separation or a stem-based renderer.

These are worthwhile experiments after timing verification, not prerequisites for a reliable release. Defer automatic phase correction, automatic downbeat relabeling, continuously variable-tempo mixes, stem mixing, and learning-driven policy replacement until an evaluation harness can demonstrate that they help.

## Acceptance and handoff rules

- Add failing regression coverage for reproduced defects before modifying behavior. Tests should assert audible/timeline invariants and public contracts, not reproduce the implementation formula as their oracle.
- Run targeted tests during each change, then the existing type/lint/export/format/full-test gates for the completed batch. Keep synthetic/native fixtures bounded and ensure cleanup. Do not rerun the whole music library for every edit.
- For policy/template changes, use short before/after previews and the existing praised-join guards. Preserve the user's approval requirements in the beatmatching plan. A measurement-only change should not silently alter mixing policy.
- Version changed analysis inputs, persisted contracts, planning policy, and render/check semantics where required. State explicitly what must be reanalyzed, replanned, rerendered, or merely rechecked. Avoid unnecessary invalidation of expensive artifacts.
- Keep a fixture manifest with source identity, relevant analyzer/renderer versions, source ranges, rates, expected property, and label provenance. Repository CI should use redistributable/synthetic audio; private listening clips remain local and are not committed by default.
- Deliver each implementation batch with the original failure, changed behavior, regression evidence, remaining uncertainty, and any required targeted audition. Do not describe a full mix as audio-verified when some joins are unmeasured.

**Ready-to-start brief:** Fix F1 first, then F2's inconclusive-result override, then F3's outgoing interval. Preserve the current phrase-snap commit and the parallel agent's DSP diagnostics. Keep the current architecture and rendering fidelity safeguards. Use the remaining findings as ordered followup work, not a reason to combine everything into one large patch.
