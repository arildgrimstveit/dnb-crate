# Repository review and automatic mix quality roadmap — 12 October 2026

> **Status: ACTIVE HANDOFF PLAN.** Reviewed HEAD: `cb8986c549b1cabc7bf3a4faec6cb6bc8996e4f2`. This is the successor to the [earlier 12 October implementation review](implementation-review-2026-10-12.md), reconciled against its four delivery tranches and the latest renderer fix, `06371da`. This review changes documentation only. The implementation ledger remains historical evidence, not the current task list.

## Direction

Make a fresh checkout and an ordinary eligible DnB folder produce a good mix without collecting approved pairs, manually nudging phases, or iterating seeds by hand. Preserve deterministic planning, local processing, source-file immutability, honest uncertainty, and the existing native-body/join-only stretch approach.

The highest-value musical work is **section-aware loudness matching, local timing confidence, and joint selection of overlap windows and treatments**. Vocal awareness belongs in that same selection system. It should initially choose where and how to mix the original recordings; stem manipulation can follow if measured benefits justify the extra installation and artifact risks.

Before expanding that system, close two correctness holes found in this review: an asynchronous publication transaction can roll back unrelated edits, and the scan fingerprint can leave analysis current after source audio changes. Finish the resolved-join contract and evaluation harness alongside them. Do not reinterpret a green unit suite as proof that every generated join sounds good.

## Scope and evidence

Reviewed all six application/package roles, their boundaries, the scan/analysis/planning/render/workflow paths, public CLI/MCP contracts, native dependencies, CI, operational scripts, the October review sequence, the implementation ledger, and recent committed corpus reports. Source inspection concentrated on the production paths behind the findings below; this is an architecture-wide review, not a claim that every line or possible interleaving was exhaustively audited.

- The worktree was clean at the start. No production code, tests, source music, owner catalog, tags, ratings, saved plans, or generated mixes were changed by this review.
- **Reproduced:** a disposable in-memory SQLite probe invoked the actual `RenderJobRepository.publishUnderClaim`. An unrelated transaction wrote one row during a paused publish. After a simulated publish error, the row count changed from **1 to 0**. This was not a native rename failure test; it isolates the shared-connection transaction behavior.
- **Reproduced:** a 262,144-byte disposable file was changed at its midpoint. Its full SHA-256 changed; `fingerprintFile` returned the same identity even with a different supplied mtime. The stale-analysis consequence is code-traced through scan upsert and stage freshness.
- **Reproduced:** `levelMatchGainDb(-16, -10, -0.1)` returns **+0.1 dB** with `true-peak-headroom`; the −10 LUFS comparison track gets 0 dB. The planned difference remains **5.9 LU**. This is a policy limitation demonstrated by a helper, not a new audible measurement.
- Fresh local typecheck, ESLint and export-consumer checks passed. ESLint reports four existing source-size warnings: DSP analyzer 1,708 effective lines, timeline 1,060, render coordinator 2,182, service facade 1,275. All 366 domain barrel exports have consumers. Repository formatting passed before this document was added.
- Fresh full suite: **653 tests across 68 files passed**, reported duration **341.65 seconds**. Remote CI was not independently checked. Committed reports were inspected, not rerun against the private library. No new listening judgments were made.

Evidence labels below distinguish **reproduced**, **code-traced**, **reported** (committed artifacts), and **proposal**. P1 means a correctness/reliability issue to address first; P2 means the next quality or maintainability batch. Feature priorities are product sequencing, not bug severity.

## Architecture assessment

### Domain and contracts

The dependency direction is sound: CLI/MCP → catalog orchestration → audio/domain. ESLint enforces boundaries, and the domain already centralizes tempo conversions, rate regions, harmonic policy, schemas, presets, and version identities. Keep this structure; a rewrite or more packages is unnecessary.

The pressure point is the join contract. Source windows, output positions, rates, alignment provenance, automation and quality evidence are spread across typed entries and free-form `TransitionPlan.parameters`. `recipeVersion: 1` also controls whether the renderer skips alignment for ordinary automatically generated joins. That is too consequential to depend on a loosely typed parameter bag. Q03 gives this state an explicit owner.

### Catalog, scanning and persistence

The catalog has useful separation between filesystem traversal, import reconciliation and repositories. Traversal handles junctions, escaping links, overlapping roots, and incomplete scans conservatively. Metadata provenance and batch hydration are strengths. Keep the source library read-only.

Two identities need separating: a quick fingerprint useful for move detection is not an analysis-content identity (Q02). Also, repositories with synchronous SQLite operations need synchronous transaction boundaries; waiting on the filesystem inside a transaction on their shared connection creates cross-service coupling (Q01). Do not proliferate scattered ownership callbacks as the final solution.

### Analyzer

The custom DnB DSP already has tempo folding/reference evidence, beat/downbeat grids, structure, local bar/drum features, groove diagnostics, and whole-track measured loudness. KeyFinder has a separately tracked, versioned stage. Streaming the STFT avoids the former large frame matrix. These are substantial foundations.

Missing pieces are local confidence/coverage, genuine time-indexed loudness, vocal activity, and a consistent decode contract. Whole-track “suspect” and key-confidence scalars lose information needed at a particular join. KeyFinder's 0.7 confidence is explicitly a heuristic, not a calibrated probability. The DSP still runs synchronously inside the catalog process; large files can stall status/cancellation and ownership heartbeats. See Q02, Q04, Q05, Q06 and Q10.

### Planner and mix policy

This is already more than a greedy playlist builder: there are phrase-window candidates, continuity scoring, deterministic lookahead, opener retries, required-chain search, bounded `repairSequence`, and limited structural-conflict window recovery. Preserve those assets.

The missing capability is evaluating complete, resolved **track pair + outgoing window + incoming window + overlap length + treatment + gain** candidates against the same local evidence. Today decisions are staged, and several later operations can change the geometry that earlier evidence described. The generic crossfade fallback is then rejected by strict selection unless explained, so it is not a general automatic quality escape hatch. Q03–Q07 turn existing search into a coherent quality system without weakening strict mode silently.

### Mixer and renderer

Three-band phrase/bass handovers, phase-matched reconstruction, native bodies, R3 preparation, float intermediates, a final static master gain, true-peak enforcement, and verified dithered listen output are valuable. Preserve the final peak ceiling and the accepted listening regressions.

Placement still has multiple owners: planned timeline, prepared-file lengths, graph delay/fade origins, and accumulated pairwise stitching. The last commit fixes one important band-graph branch; acrossfade and stitch parity still need dedicated proof. Track gain exists, but is chosen from entire-track loudness. A final −14 LUFS target cannot repair relative loudness differences or vocal competition. Q04, Q06 and Q08 address these separately.

### Verification, feedback and evaluation tools

The code now distinguishes stored-grid checks, source-deck probes, mixed-audio diagnostics and listening feedback. Coverage is more honest than in the earlier review. Source and processed-output synthetic suites caught real defects; keep them.

The deliverable is still an evaluation scaffold rather than evidence of generalized musical success. Source probes do not measure processed decks. Mixed-master onsets can hide one deck behind the other. Current script exits do not consistently enforce corpus assertions. Real-library holdouts are assigned after observed pairs are generated and are not a protected experiment split. Q07/Q08 make evaluation an engineering gate while keeping uncertain musical diagnoses advisory.

### Workflow, CLI and MCP

The persistent first-mix workflow, request-token idempotency, resumable stages, child-job tracking, strict readiness, output verification, passive reporting runtimes and JSON/stdout discipline are strong. These should remain the default user journey.

The first-run experience still assumes too much native-tool knowledge. README calls Rubber Band optional, yet newly generated version-2 rate-region plans require its standalone CLI; `mix:preflight` checks it only later through `checkPlan`, after scan/analysis/planning. Windows instructions do not provide a complete reproducible bootstrap. Public repair schemas also lag richer service results. Q09/Q11 cover these gaps.

### Tests, CI and developer tools

Generated audio, actual compressed-format/native acceptance tests, Linux CI and a Windows smoke lane are good foundations. Tests must continue to assert source → saved plan → frozen request → prepared audio → output invariants, not only that expected parameter names exist.

Large coordination files have regrown since the completed cleanup plan. Refactor along ownership boundaries while adding the new contracts, rather than doing another cosmetic file split. Operational reports need stable schemas, unique run identities, retention policies and meaningful exit codes. Owner-specific session rules must not become general product requirements.

## Reconciliation of recent plans and commits

The earlier review's T1–T8 are neither wholly open nor wholly finished. Carry forward only the remaining acceptance work:

- **T1, source-time window recovery — core fix landed (`929f29e`).** Incoming phrase shifts now convert output time to source time, require measured compatibility, and rebake alignment. The local recovery still clears continuity rather than fully recomputing a comprehensive resolved candidate; broaden only through Q03/Q05. Preserve unequal-rate and missing-evidence regressions.
- **T2, stale analysis/key/enrichment writes — improved, incomplete (`8bd6d76`).** Post-computation checks now reach real result writes. They are still separate check/write operations across several tables, without one claim-conditioned transaction. Q01 completes that boundary.
- **T3, shared listen publication — cross-process race improved (`81f18ec`, `32be9b9`).** A database write lock now prevents another connection from interleaving takeover between claim check and rename. Q01 identifies its new same-connection rollback problem. Preview cache publication remains outside that guard. Cross-process success does not settle process-local concurrency or crash consistency.
- **T4, applied-transition incoming rate — core fix landed (`8c2bf01`).** Pair identity is stamped on application. Preserve it and add the complete middle-entry proposal → reload → render acceptance as Q03 is introduced.
- **T5, exact saved-window fit — first tranche landed (`6b8f23e`).** Overrunning windows are rejected rather than silently moved. Comparison still computes feasibility before freezing, uses incomplete saved entry bounds, and falls back to fresh context for some crossfade/legacy cases. Q03 remains open.
- **T6, abstention coverage — identified defect fixed (`6b8f23e`).** Abstentions no longer count as measured joins. Keep this invariant through all new metrics and reports.
- **T7, processed-output corpus and unequal-rate bug — material progress (`d85b86e`, `c8b20f9`, `2dd32fb`, `06371da`).** A fixture phase error was corrected, and a real band-graph placement bug was fixed with a failing-first graph regression. The newest six-case report has 3 true positives, 3 true negatives and no defect escapes. That does not close per-deck attribution, boundary/dynamics checks, crossfade/stitch parity, or general musical evaluation. Earlier claims that stretch latency caused this defect are superseded; do not add a universal atempo offset from one fixture.
- **T8, real-library baseline — build, WAL snapshot and provenance fixes landed (`f63be76`, `25e4d2c`, `5ee9ddb`).** Report identity, normalized-plan determinism, artist accounting, genuine holdouts, label routing and retention remain open under Q07. The reported pilot timing failures remain a Q05 input.
- **Earlier R/S followups still visible:** frozen musical validation metadata; fair comparison gain; repair response completeness; corrupt-explanation recovery; legacy freshness policy; scratch lifecycle. These are included in Q02/Q03/Q07/Q11, not forgotten beneath a blanket completion label.
- **Batch D remains in progress.** Structural window recovery is a useful slice. Broader local measurement, joint candidate evaluation, bounded automatic recovery after verification, and held-out generalization remain the main product work. Existing chain repair is not equivalent to a closed loop that fixes an observed weak rendered join.

The [latest committed library report](../../tools/reports/library-baseline-2026-10-12.json) contains three 15-minute plans and 14 aligned joins: 9 source-probe passes, 4 reviews, 1 fail, and zero window-shift recoveries. All three renders completed; **only one of the three passed `checkOk`**. These are reported technical outcomes, not independently auditioned mixes or a population quality estimate. The `coldStart` counts describe rows removed from the snapshot, not feedback retained for selection.

The [source corpus report](../../tools/reports/audio-regression-2026-10-12T11-11-36-366Z-4yg.json) still records one defect escape and one failed offset assertion. The [latest processed-output report](../../tools/reports/processed-deck-2026-10-12T11-56-26-945Z.json) records a spurious failed numeric assertion on `sparse-incoming`: its fixture has no placement shift but retains `injectedErrorMs: 80`. Correct that case contract before interpreting the assertion as an audio defect.

## Implementation work packages

### Q01 — P1: make persistence and artifact publication safe at the actual boundary

**Evidence: reproduced + code-traced.** [publishUnderClaim](../../packages/catalog/src/render-job-repository.ts) starts `BEGIN IMMEDIATE`, awaits publication, then commits/rolls back on the runtime's shared connection. Other repository operations on that same connection are not excluded. The review probe demonstrated an unrelated acknowledged write disappearing on rollback. A same-process cancellation can also run inside the open transaction. Analysis/key/enrichment still check claims before a series of separate writes. Preview paths and their intermediate filenames use shared cache keys.

**Implement, in separate reviewable changes:**

1. Remove async work from shared-connection transaction scopes. Choose a short synchronous claim-check/publication boundary or immutable generation artifacts with an authoritative claim-conditioned pointer. Merely adding a process mutex around `publishUnderClaim` does not protect the other repositories. A dedicated connection held across async work also needs care: synchronous writers can block the event loop that must release it.
2. Stage each render/preview under a job/generation-owned path. Publish verified artifacts under the same protocol, including cache entries. Define recovery if the process exits after a rename but before terminal metadata is saved; SQLite rollback cannot roll back a filesystem rename.
3. Compute analysis/key/enrichment results first, then commit the result, canonical fields, selection/cues, stage state and relevant progress under one synchronous transaction which checks both claim and expected input identity. Handle pre-work status writes and failure writes too.
4. Keep cancellation, takeover and graceful close semantically distinct. Use a small shared claim-context type rather than optional callbacks which callers may forget.

**Acceptance:** same-connection unrelated edit survives failed publication; same-process cancellation cannot publish stale output; two-process takeover still preserves winner bytes; crash recovery has no ambiguous authoritative artifact; preview collisions cannot share intermediate files; delayed DSP/key/HTTP jobs cannot alter winner rows; injected write failure leaves no partial evidence. Tests must use actual coordinator/repository boundaries. Keep the existing cross-process regression.

**Size:** M–L. **Dependencies:** none. This is the first correctness PR, before new background analysis stages.

### Q02 — P1 for stale musical evidence; P2 for decode consistency: bind analysis to the bytes and preprocessing used

**Evidence: reproduced fingerprint limitation; code-traced freshness consequences.** [fingerprintFile](../../packages/catalog/src/fingerprint.ts) hashes size and first/last 64 KiB, deliberately excluding mtime. [scan upsert](../../packages/catalog/src/repository.ts) invalidates stages only on that fingerprint changing. [DSP freshness](../../packages/catalog/src/analysis/dsp-identity.ts) trusts that identity. Fresh render SHA-256 protects queued audio against later changes, but cannot prove old beat/key/loudness evidence describes the newly hashed bytes.

The [PCM loader](../../packages/catalog/src/analysis/load-pcm.ts) also treats 16-bit WAV differently: it returns its native sample rate, whereas other formats are decoded to mono 22,050 Hz. Fixed FFT/hop sample counts then represent different time/frequency resolutions. This is a reproducibility risk, not a demonstrated musical failure in this review. The hand-written [WAV reader](../../packages/audio-analysis/src/wav.ts) does not fully validate format code/chunk bounds before interpreting 16-bit data.

**Implement:**

- Retain the fast fingerprint for move matching, but add a strong content identity to analysis-stage records. Reuse streaming decode/hash work where possible; distinguish stat-assisted cache checks from a strong verification guarantee. Include decode profile, analyzer/model version and configuration in stage identity.
- Check that source identity is stable across analysis and its commit. Freeze references to evidence whose source identity matches the render source, not just whichever analysis row is currently selected. Define legacy evidence as unknown until upgraded or explicitly validated.
- Canonicalize DSP sample rate/channel policy across supported formats, with a separate stereo loudness path. Version this change and reanalyze stale evidence. Validate unsupported/malformed WAV inputs and fall back to the known decoder rather than interpreting their bytes as PCM.

**Acceptance:** middle-byte change with unchanged size/head/tail invalidates DSP/key/loudness; preserved mtime does not fool the strong check; unchanged-byte relocation preserves usable identity; source replacement during analysis prevents publication; equivalent WAV/FLAC/MP3/Opus fixtures retain timing within documented format tolerances and descriptor differences within justified tolerances. Include 44.1/48/96 kHz WAV and malformed chunk cases. Do not require exact lossy/PCM descriptor equality.

**Size:** M. **Dependencies:** Q01 commit boundary; can prepare migrations/fixtures alongside it.

### Q03 — P1 timing foundation: one immutable resolved join for planning, comparison and rendering

**Evidence: code-traced, continuing T5/R9/R14.** [comparison](../../packages/catalog/src/service/inspection.ts) calculates `planTransition` feasibility before `freezeRequest`. Saved context omits full entry bounds, and missing bar counts use fresh proposals. [timeline](../../packages/catalog/src/planning/timeline.ts), [window alignment](../../packages/catalog/src/planning/windows.ts), [transition proposals](../../packages/catalog/src/planning/transition-planner.ts), and [renderer](../../packages/catalog/src/render/coordinator.ts) each reconstruct parts of musical state.

**Implement:**

- Add a versioned `ResolvedJoinContext` to domain contracts: pair/entry IDs; content/evidence identities; exact source intervals; output anchor; head/body/tail rate map; duration and phrase length; alignment decision and confidence/coverage; local evidence intervals; treatment parameters/automation; gain decision; resolution/policy version.
- Use explicit unresolved/resolved states. A resolved state is constructed only after bounds, local evidence and geometry validation. Preserve readable legacy plans through a deliberate upgrade path; `recipeVersion` must not remain the generic alignment-validity flag indefinitely.
- Freeze before evaluating comparison feasibility. Use the frozen context for every supported treatment, including crossfade and legacy entry bounds. Separate “change treatment on this exact window” from “search for a better window.” Live file availability can still fail at execution without changing frozen musical decisions.
- Recompute all dependent fields after a shift, trim, rate change, replacement or proposal application. Gain needs derived/pinned provenance just as rate does; a previous numeric gain is currently retained regardless of why it was chosen. Define which downstream entries require re-resolution.
- Compare variants at common playback loudness/headroom, retaining a clearly labeled production-master mode. Independent per-preview normalization can otherwise bias listening comparisons.

**Acceptance:** proposal → apply → reload → freeze → manifest describes the same interval, tempo, gain and automation for first/middle/last entries. Include unequal tempos, both neighbors, manual trims, 8/16/32 bars, crossfade-origin and legacy cases. An edit during asynchronous freezing cannot mix old feasibility with new evidence. Unknown values stay unknown. If exact bounds cannot be honored, return a reason rather than silently move them.

**Size:** L, split contract introduction from migrations/caller adoption. **Dependencies:** Q01/Q02 identities; basic shape can start earlier.

### Q04 — highest musical priority: match loudness over the sections that will actually play

**Evidence: code-traced + reproduced policy limit.** [levelMatchGainDb/buildEntries](../../packages/catalog/src/planning/timeline.ts) uses median whole-track integrated LUFS, clamps gain to −6/+3 dB and limits boost by source true peak. [render checks](../../packages/catalog/src/render/coordinator.ts) compute `levelStepLu` from rendered windows but gate on `plannedLevelStepLu`, with a 5 LU limit. [SonicDescriptors](../../packages/domain/src/analysis.ts) correctly labels existing short-term fields as RMS dBFS, not LUFS.

**Implement:**

1. Add cached time-indexed loudness measurements on the original stereo signal: momentary/short-term loudness, validity/silence coverage, and selected-window peak/headroom summaries. Store their hop, units, source/model identity and validity. Derive representative featured-body and overlap values; do not substitute normalized per-track RMS for perceptual loudness.
2. Solve gains for the selected set jointly. Prefer attenuating loud tracks to forcing quiet, highly peaked tracks upward. Select a feasible common body reference within declared gain/headroom limits; report residual mismatch when limits conflict. Model overlap summation and band automation headroom. Keep one final master gain/ceiling stage.
3. Preserve intentional musical dynamics: exclude silence, builds and breakdowns from body-reference estimation; use section-relative targets and slow, bounded gain movement only when a static entry gain cannot satisfy the policy. Keep manual pins explicit. Avoid a default full-track automatic compressor which flattens drops or pumps with bass.
4. Measure pre-overlap body, overlap trajectory and post-overlap body from the rendered artifact in one reusable pass. Treat sparse/short/clipped windows as unmeasured. Initially report the new metrics; calibrate before making them automatic recovery/hard-failure inputs. Keep the old planned metric as a prediction with an explicit name.

**Starting acceptance targets to validate, not claims about current behavior:** for comparable steady bodies, median absolute level difference ≤1 LU and p95 ≤2 LU; report exceptions and measured coverage. Separate intended breakdown/drop transitions from unintended jumps. Preserve the configured true-peak ceiling on master and listen. Compare the reproduced 5.9 LU case against a feasible attenuation-first solution; test quiet/dynamic versus hot/limited masters, long intros, missing loudness, both tracks active, and middle-entry gain continuity.

Listen blind at matched playback loudness to confirm that smaller numerical differences improve transitions without erasing the requested arc. Keep −14 LUFS as the existing export default unless a separate product decision changes it; “all tracks equally loud” is not “all music equally energetic.”

**Technical basis:** FFmpeg's `ebur128` exposes momentary/short-term loudness and metadata, so a first implementation can reuse the existing dependency. The choice of representative section statistic and gain optimization is proposed here and must be evaluated on DnB. [FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html#ebur128).

**Size:** L. **Dependencies:** Q02/Q03 and Q07 measurement baseline. Deliver measurement first, gain solver second, calibrated recovery third.

### Q05 — P1 known timing failures, then P2 broader local confidence and candidate search

**Evidence: reported failures + code-traced policy.** The committed pilot still has two stored-grid residuals above 40 ms and source-probe flags. The ledger attributes the two original cases to sub-bar geometric offsets without onset-lock corroboration; this review has not independently established an audible root cause. [bakeWindowAlignment](../../packages/catalog/src/planning/windows.ts) falls back to geometry when onset lock abstains. Whole-track grid-phase summaries in [DSP](../../packages/audio-analysis/src/dsp-analyzer.ts) and [pool policy](../../packages/catalog/src/planning/pool.ts) do not describe which intervals are trustworthy.

**Implement:**

- Preserve the two original failed-check cases as immutable diagnostic cases before reanalysis. Trace exact source identities, original grids, local onsets, applied offsets, rate maps and final output. Add synthetic equivalents and correct the responsible transform/selection policy. Do not assume every large bar offset is wrong: distinguish whole-beat/bar equivalence from sub-beat error.
- Emit per-interval phase/drift confidence, measured onset counts, coverage, ambiguity and rejection reason. A quiet interval with no drums, missing evidence, and a measured compatible groove are three different states. Recover usable intervals from an otherwise suspect track, while continuing to honor explicit owner exclusions.
- Generate bounded combinations of outgoing exits, incoming entries, 8/16/32-bar lengths and current treatments. Score the actual aligned intervals using timing trust, local kick/snare compatibility, continuity, loudness feasibility, vocal conflict when available, harmony, native-body feasibility and the brief. Keep hard feasibility separate from soft preference.
- Reuse existing window generation/lookahead/chain repair. Cache resolved pair/window evaluations by immutable context. Expose candidate rejection reasons and search budget. Recompute evidence after alignment shifts; do not clear stale continuity and then treat its absence as proof of quality.

**Acceptance:** known failed-check cases are explained and corrected without loosening the residual gate. Fixtures cover offbeat bass, triplet feel, sparse passages, inaccurate downbeat labels, tempo drift and reference-locked grids. Three-track tests verify both joins and the native body. Fixed seed/context produces identical normalized resolved candidates. Held-out selection improves with bounded runtime and without selecting only a tiny safe subset of the crate.

**Size:** L. **Dependencies:** Q03/Q07; interval analysis uses Q02. Fix the known timing cases before broad policy tuning.

### Q06 — feature priority 2: vocal-aware mixing without requiring stems

**Evidence: capability gap.** There is no time-local vocal-activity series in [analysis contracts](../../packages/domain/src/analysis.ts), and current [preset automation](../../packages/domain/src/mix-presets.ts) controls low/mid/high bands, not isolated voices. `melodicness`, midrange energy and full-band onsets are not reliable vocal labels. Phase-locking beats does not align lyrics or prevent two lead lines competing.

**Implement progressively:**

1. Define an optional, separately versioned vocal stage with source-time activity probabilities, confidence/coverage, sustained-phrase intervals and boundary uncertainty. Cache by source content and model/preprocessing identity; expose unavailable/unknown explicitly. No ASR or lyric transcription is required for collision avoidance.
2. Benchmark a locally runnable singing-voice detector on vocal-heavy DnB, rap/MC passages, chopped samples, reverb tails, synth leads and instrumental controls. A music-trained voice/instrumental model is a candidate baseline, not proof of phrase-boundary accuracy. Evaluate frame/segment inference and threshold calibration before choosing a runtime/model. Essentia documents voice/instrumental models that could be evaluated; verify their deployment and model terms before adopting them. [Essentia model documentation](https://essentia.upf.edu/models.html).
3. Project both activity series through the resolved rate/time maps. Score simultaneous **audible** vocal activity, weighted by the treatment envelope and confidence. Prefer a clean outgoing phrase ending, an incoming instrumental entry, a shorter blend, or a different candidate track. Preserve good call-and-response passages instead of categorically banning all overlap.
4. Add bounded, smooth deck-level or mid-band ducking only after window/treatment alternatives, with an explicit lead-deck handover. A mid-band dip also removes snare/synth content; it must not be presented as clean vocal isolation. Match overall output loudness when auditioning this change.
5. Keep detection optional until quality and install/runtime costs are known. Unknown vocal evidence should lower confidence or favor conservative treatment; it must not silently count as instrumental. A fresh install without the model must still complete its supported baseline workflow with clear capability reporting.

**Acceptance:** time mapping remains correct at unequal rates and splices; a detector miss cannot become a claimed vocal-safe join; sustained lyric-on-lyric collisions decrease on labeled held-out joins; chopped hooks and instrumental controls do not suffer excessive false avoidance; phrase endings remain intact; no audible pumping or excessive spectral thinning. Record detection precision/recall, accepted vocal overlaps, planning success, runtime and artifact ratings separately. Promotion requires blind listening evidence, not just a lower overlap score.

**Later optional experiment:** stems for vocal ducking or transition-only vocal/instrumental handovers. Run only on selected overlap regions if practical, retain the untouched native body, account for separator latency and leakage, and reject artifacts. Do not make a GPU, model download or stem library mandatory for a first mix.

**Size:** L, with a small contract/detector evaluation first. **Dependencies:** Q02/Q03/Q05/Q07; ducking also depends on Q04.

### Q07 — P2 prerequisite for tuning: make the corpus a trustworthy quality gate

**Evidence: code-traced + reported.** [Library runner](../../tools/scripts/library-corpus-baseline.mts) now uses consistent SQLite backup and clears copied jobs/history, but determinism compares only track-ID sequences; artist counts split track titles; date-only files overwrite earlier runs; labels are not automatically routed to the isolated catalog. `probeFlagged` is grouped under `manualIntervention` although nobody necessarily intervened. [Processed corpus](../../tools/scripts/processed-deck-corpus.mts) reports failures without a final assertion-based nonzero exit, recalibrates from the aligned control with a zero fallback on calibration failure, and retains the inconsistent sparse-case injection field noted above. These scripts are not mandatory CI corpus gates.

**Implement:**

- Version a common report schema for source probes, processed-output tests and real-library evaluation, with distinct scopes. Store commit/policy/dependency identities, normalized brief/resolved plan, source/evidence hashes, random seed, exact windows, actual stretch engine, measurements, confidence, coverage and timings.
- Fix fixture truth first. Fail calibration explicitly; retain raw and calibrated measurements so calibration cannot erase a systematic placement regression. Assertions must have defined applicability. Make infrastructure errors, unexpected escapes/false alarms and numeric failures produce documented nonzero exits, with explicitly enumerated known failures rather than globally accepting red outcomes.
- Expand processed verification with distinguishable per-deck test signals or optional prepared-deck capture. Inject mutations after preparation as well as at plan geometry; a loud correct deck must not conceal a quiet broken one. Add final-blend clicks, splice placement, drop/energy loss, loudness jumps and peak controls. Keep musical uncertainty separate from hard technical failures.
- Freeze tuning and held-out sets before changing thresholds. Partition by recording/variant family, with track-disjoint and artist-disjoint evaluation where feasible. Pair-only holdouts may be reported but must not be described as unseen-track generalization. Do not repeatedly tune against the holdout aggregates.
- Evaluate multiple durations, seeds and brief types, including low-supply and failing cases. A practical initial target is ≥100 tuning joins and ≥100 held-out joins across diverse strata where supply permits; state scarcity and uncertainty rather than manufacturing independence. Do not use this count as statistical certification.
- Compare complete normalized plans, including windows/rates/gains/treatments, ignoring only UUIDs/timestamps. Use artist/recording IDs, unique run directories, executable artifact links, isolated label storage, explicit retention and safe cleanup. Keep private audio out of committed reports/fixtures.

**Acceptance:** a deliberately corrupted processed deck and a broken numeric assertion fail CI; missing calibration fails clearly; all requested plans appear in denominators; replay produces the same normalized plan; source checks, rendered checks and musical ratings are separately inspectable. Report successful verified mixes per request, listening repair rate, source/processed coverage, defects/escapes, loudness distribution, vocal collisions, variety, runtime, peak disk use and failed attempts. The current 14 joins are a pilot, not the release benchmark.

**Size:** M–L. **Dependencies:** none for harness fixes; new features add fixtures to this gate. Use generated fixtures in ordinary CI and opt-in private/local corpora for music judgments.

### Q08 — P2: prove renderer parity and make automatic recovery affordable

**Evidence: code-traced; audible consequences require focused integration tests.** [Band graph](../../packages/audio-renderer/src/filter-graph.ts) now honors `timelineStartSec`; `buildAcrossfadeFilter` still joins at a file-length boundary, and [pairwise stitching](../../packages/audio-renderer/src/mix.ts) derives its prefix point from outgoing playable duration. A common plan must have consistent placement through all these branches. Keep the latest fix, but do not infer full cross-template parity from its two-deck graph test.

Pairwise processing removes old temporary files, bounding retained accumulation, but repeatedly rewrites an increasing prefix. For similarly sized entries, aggregate I/O still grows approximately quadratically with entry count. [measure-pairwise-io](../../tools/scripts/measure-pairwise-io.mts) currently counts remaining output files, not total bytes read/written. That can understate the cost of repeated automatic attempts.

**Implement:**

- Adopt Q03's source/output map in band joins, crossfades, rate splices, edge fades and stitching. Assert timeline and duration consistency instead of silently capping incompatible geometry. Capture prepared-deck attribution in diagnostics only when requested.
- Test 3+ tracks, unequal rates on a middle entry, every adjacent template combination, nonzero origins, pinned and derived placement, previews and full output. Measure onset placement, splice discontinuities, duration, gain and reconstruction continuity from real audio.
- Version/cache prepared decks and candidate join previews by their full context. Store immutable body/join chunks and concatenate once where possible; verify phase reconstruction and stitch boundaries before replacing the accepted algorithm. Instrument actual temporary I/O/peak scratch and render time for 15/60/120-minute sets.
- Treat atempo measurements as engine/version/rate/fixture-specific evidence. Choose whether fallback is supported and calibrated or rejected for a given quality mode; do not hardcode the earlier +12.8 ms claim, which later attribution revised. Report the actual engine used.

**Acceptance:** same resolved join has equivalent placement and appropriate loudness across preview/full/template paths; post-preparation negative controls are caught; no new clicks/flams or repeated filtering; clean-up survives cancellation/takeover. Optimization must reduce measured total I/O while preserving the established fidelity fixtures.

**Size:** M–L. **Dependencies:** Q03/Q07; chunk optimization follows correctness.

### Q09 — high product priority: make first mix setup complete, early and actionable

**Evidence: code-traced/docs mismatch.** [README](../../README.md) calls standalone Rubber Band optional; [first-mix](../first-mix.md) requires it; [preflight](../../packages/catalog/src/preflight.ts) checks it only for an actual plan, although [timeline](../../packages/catalog/src/planning/timeline.ts) stamps new joins as rate-regions v2. Users can do expensive analysis before learning their default mix cannot render.

**Implement:**

- Provide one primary sequence: clone → install → initialize configuration → doctor/preflight → short first mix → final listen path. Put the first-mix guide before architecture in README. Provide copyable PowerShell and POSIX examples and a complete Windows native build/install path, not only “build with CMake/MSVC.”
- Extend preflight to show capabilities for the default requested workflow before analysis: FFmpeg/ffprobe versions and required filters/encoders, R3 availability, key detection and model availability, writable isolated output/database locations, estimated scratch space and resumable next actions. Distinguish a hard default-workflow requirement from a conditional/optional feature.
- Add a config initializer which respects existing files, validates library/output separation and explains resolved config/data paths. Native dependency acquisition should use documented versions/checksums and deliberate commands; do not silently download models or enable enrichment.
- Keep `mix:create --wait` as the obvious first command. On failure return the workflow ID and resume command in structured output as well as the message, with a concrete reason and affected supply count. On success print an accessible listen path and brief quality/limitations summary. JSON stays on stdout; human progress stays on stderr.
- Add a tiny generated demo crate/smoke path so setup can be tested independently of whether a user's music folder meets strict selection requirements. Avoid promising that arbitrary folders satisfy DnB tempo/key/duration constraints.

**Acceptance:** clean environment with missing R3 fails early with the exact next action; missing KeyFinder is either handled by sufficient valid existing keys or explained before expensive planning; paths with spaces and non-ASCII names work; restart/resume does not duplicate analysis or renders; Linux and a complete Windows first-mix recipe are tested. Record time to first successful demo mix and the number of user actions, not just tool count.

**Size:** M. **Dependencies:** none for docs/early capability fixes; richer quality summary follows Q07. Can ship alongside correctness work.

### Q10 — P2: isolate expensive analysis and bound resource use

**Evidence: code-traced performance risk.** [Analysis coordinator](../../packages/catalog/src/analysis/coordinator.ts) invokes `dspAnalyzer.analyze` synchronously; [runtime polling/heartbeat](../../packages/catalog/src/index.ts) shares its event loop. The WAV decoder loads whole files, and native measurement calls have uneven deadline coverage. No throughput or starvation benchmark was run in this review.

**Implement:** move CPU DSP behind a bounded worker-thread/process interface, transferring PCM buffers or streaming features where appropriate. Keep SQLite writes in the owner process under Q01. Propagate cancellation and stage progress; limit concurrent decode/model memory, add duration/size policy, and handle worker crashes. Share the decode profile and stage cache from Q02 so vocal/loudness work does not repeatedly decode the entire catalog. Use size-aware native deadlines and bounded captured stdout where needed.

**Acceptance:** status/poll/cancel stay responsive during a long/high-rate analysis; heartbeats do not stall past ownership policy; abort cleans scratch; source changes discard results; repeat current analysis does no expensive work. Benchmark representative 100-track cold/warm batches and long-file behavior with memory/CPU/runtime, then set budgets from measured baselines.

**Size:** M. **Dependencies:** Q01/Q02. Prioritize before enabling heavier optional vocal models by default.

### Q11 — P2: finish contracts, recovery and maintainability at touched boundaries

**Evidence: code-traced.** The [MCP repair schema](../../apps/mcp-server/src/tools/planning.ts) exposes a narrower plan/diff than the service returns and promises treatment preservation too broadly. [Stored-plan parsing](../../packages/catalog/src/set-plan-repository.ts) suggests clone-with-replan for an invalid explanation, but clone first needs to load that explanation. The [pool](../../packages/catalog/src/planning/pool.ts) still uses per-suspect `catalog.find`. Four large modules exceed the repo's warning threshold.

**Implement:**

- Define repair/result schemas in domain and reuse them in CLI/MCP; include stable entry/transition IDs, complete effective before/after changes, validation and explanation. Include gain and automation when asserting treatment equality. Test actual wire results, not only registered tool names.
- Provide a tested recovery/export route for a corrupt legacy explanation that does not require successfully parsing the same field first. Preserve the original row and distinguish recoverable diagnostics from invalid essential geometry.
- Split the render coordinator into request freezing, execution, publication and verification services as Q01/Q03/Q08 land; split timeline into resolution, gain planning and entry serialization; separate DSP feature extraction from estimation/structure/diagnostics. Keep the facade thin. Avoid a flag-filled universal helper or a wholesale rewrite.
- Replace quadratic lookup/report loops with maps on touched paths. Consolidate command metadata/worker requirements/help where useful; stop hand-maintained counts and drift-prone descriptions from acting as behavioral guarantees.
- Document layer exceptions: planning currently imports pure alignment math from audio-renderer, and catalog audio diagnostics contain sample-processing math despite the architecture's “no audio math” description. Move shared pure time/phase calculations to domain and reusable sample diagnostics to an audio layer when touched, without a circular dependency.
- Consolidate completed/historical plan status and preserve one active pointer. Add evidence + remaining acceptance to each implementation-ledger entry; a commit title saying “complete” must not erase open contracts. Keep private/session-specific actions out of generic setup.

**Acceptance:** CLI/MCP/result schemas agree; malformed diagnostic JSON has a working safe recovery; no automatic source-library moves; unchanged behavior has unchanged normalized plan/fidelity fixtures. Typecheck, lint, formatting, export audit and relevant suites pass. Each extraction has a defined contract reason, not only a target line count.

**Size:** M spread across feature PRs, plus a small recovery/schema PR. **Dependencies:** follows touched Q01/Q03/Q04 boundaries; avoid a separate large cleanup branch.

### Q12 — feature priority 3: bounded automatic quality recovery and a useful final report

**Evidence: workflow capability gap.** [First-mix workflow](../../packages/catalog/src/mix-workflow.ts) can resume/retry stages, but failed output checks do not trigger a calibrated search for a better join. Manual comparison and replacement tools exist; ordinary users should not have to orchestrate them.

**Implement after measurement is credible:**

- Resolve and rank candidate joins before rendering. Preview only ambiguous/high-risk candidates when cheap evidence cannot decide. Reuse cached prepared audio from Q08.
- On a confidently detected, supported failure, try in order: a better window/length, a different existing treatment, bounded gain/headroom adjustment, then neighbor-aware track reselection. Revalidate both neighbors, affected rates and the global brief. Do not repeatedly retry an unchanged context.
- Start with explicit configurable limits, for example three alternative joins per failed join and two full-render attempts per workflow. These are proposed budgets to benchmark, not universal quality settings. Record attempts and stop with a concrete limitation when music/evidence cannot satisfy the request.
- Keep low-confidence vocal/phase advice advisory until calibrated; never transform an abstention into an automatic pass. Support an internal revision/attempt history so the output can be reproduced and diagnosed without exposing a manual repair checklist to the user.
- Produce a compact final mix report: listen/master links, track timestamps, checks actually performed and their coverage, relevant unresolved limitations, and a short explanation of successful automatic choices. A report should not claim “vocal-safe” when vocal detection was unavailable.

**Acceptance:** known fixable joins improve automatically without manual cue changes; irreparable/uncertain cases terminate honestly; constraints and diversity remain respected; retry history is reproducible; failed attempts stay in evaluation denominators. Compare blind musical acceptance and successful verified mixes per request against the frozen baseline, with runtime and supply loss reported.

**Size:** L. **Dependencies:** Q03–Q08, Q09 workflow UX. Build stage-specific recovery before a generic optimization loop.

## Suggested delivery order

1. **A — correctness and easy onboarding wins:** Q01, Q02 identity, Q09 early capability/docs. Fix the Q07 fixture/exit/calibration defects. Keep the existing audio behavior otherwise stable.
2. **B — shared context and known timing cases:** Q03, the known-failure portion of Q05, Q08 placement parity, Q11 wire/recovery fixes. Freeze a reproducible baseline before policy changes.
3. **C — audible consistency:** Q04 local loudness measurement and gain solver, then Q05 joint window/treatment scoring. Q10 can proceed as the analysis boundary is touched. Run ablations to attribute benefits to each feature.
4. **D — vocal intelligence:** Q06 detector evaluation → advisory scoring → candidate selection → carefully evaluated ducking. Stem experiments remain optional.
5. **E — hands-off improvement:** Q12 bounded recovery, Q08 caching/I/O optimization and the final user report. Promote only the diagnostic classes whose escape/false-alarm rates justify automation.

Sizes are relative engineering scope, not calendar promises. Split L items into independently reviewable commits. Prefer work that improves output at fixed or increased eligible-library coverage; rejecting more music is not automatically a quality improvement.

## Release and evaluation contract

Use one versioned baseline and change one policy at a time. Evaluate fixed briefs and seeds under both old/new versions; store source/evidence/engine identities. Keep silent, sparse, uncertain and failed cases in the accounting.

Required release evidence:

- Deterministic normalized plan and full coordinate/gain/treatment provenance.
- Known injected timing/processing/peak defects caught; no unexplained regression in false alarms or abstention.
- Master and listen meet current peak/duration/decodability contracts; section-level loudness targets have explicit applicability and coverage.
- Listening evidence supports reduced objectionable flams, energy holes and vocal collisions, with playback loudness matched between variants.
- Success per requested mix, mixable-library coverage, variety and runtime are reported alongside join quality. Do not report only the surviving joins.
- Fresh-checkout CLI/MCP first-mix acceptance with no saved recipes, previous feedback or manual cues; generated-fixture CI plus held-out musical evaluation.
- Cancellation, crash/takeover, source changes and disk/dependency failures preserve source files, database integrity and already-published winning artifacts.

Automatic success can mean “technically verified with these measured capabilities”; it cannot honestly guarantee every musical transition is ideal. The product should quietly use the best available evidence, improve supported failure classes automatically, and surface the rare limitations that actually need user attention.

## Features worth exploring after the core roadmap

- **Phrase-complete vocal handovers:** let one lyric phrase finish while the next instrumental phrase enters, then release the new lead. This is the most direct extension of the requested vocal awareness.
- **Quality-preserving alternate takes:** different seeds explore varied sequences/windows subject to the same measured quality budget, with reproducible comparisons.
- **Local harmonic-change awareness:** identify tonal changes within selected overlap regions instead of relying exclusively on a global key. Benchmark before adding another heavyweight analysis dependency.
- **Automatic spectral headroom/bass ownership:** use the existing three-band architecture to choose when each bassline owns the overlap; evaluate clutter and energy continuity rather than blindly reducing bass everywhere.
- **Transition-only stems:** an opt-in advanced mode for the few joins where good windows and envelope choices cannot solve a vocal clash. Require artifact-aware fallbacks and explicit cost/capability reporting.
- **Portable mix recipe/report export:** content identities, brief, timestamps and resolution decisions allow diagnosis/recreation on another checkout without sharing copyrighted audio. This is reproducibility, not a required user-curated join library.

Defer an expanded manual workbench, larger approved-pair library, lyric transcription, broad genre support, and flashy effects until the default DnB path reliably makes better mixes. The user goal is fewer repairs, not more ways to perform them.

## Instructions for the implementation agent

Start from the current HEAD and reconcile any newer commits with this plan. Do not assume a historical finding still reproduces. For each Q item, state its scope and write the failing boundary-level regression before the fix when it describes a defect. Preserve the strong parts of the existing architecture and accepted fidelity regressions.

Do not modify the owner's audio files or reorganize the library, use approved joins as a requirement, disable checks to improve the pass count, or tune against exposed held-out results. Use isolated catalogs and generated fixtures for development. Keep private listening artifacts intentional and locally addressable.

Deliver each batch with the final SHA, changes to policy/schema/version identities, exact verification results, performance/evaluation evidence, and explicitly remaining acceptance work. Update the ledger and active-plan status only to the extent supported by those results. This document authorizes no implementation in the review session; it is the handoff for a subsequent implementation request.

## Validation note

Repository-wide typecheck, lint (four existing size warnings), export audit and formatting passed during review. The full suite passed **653 tests in 68 files**, duration **341.65 seconds**, on the reviewed application code. The review's three focused probes ran against disposable data and left no application changes. Documentation and the companion review canvas were checked separately after writing; no production code or test changes were needed.
