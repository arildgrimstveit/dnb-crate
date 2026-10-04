# Implementation plan: lean-codebase cleanup and architecture documentation

October 2026 decision: everything currently parked as accepted or deferred debt
gets fixed. Breaking changes to MCP clients are acceptable (single-user
deployment), and a one-time full library re-analysis is acceptable. The goal is
a lean codebase with clear separation of concerns and documentation that
explains the architecture, so future work (starting with the beatmatching
phases) lands on clean ground.

**Status: COMPLETE (October 2026).** R0–R3, R5, R6 shipped; R4 (pairwise
render I/O) parked on measurement per its own go/no-go — a 40-join render
takes ~5.3 minutes, under the 10-minute threshold. Two follow-up candidates
are recorded in the R4 section: the manual/published-key evidence-freezing
gap, and re-measuring before any tree-stitching work if multi-hour mixes
become a real request.

Companion history: `code-quality-debt.md` (Q0–Q5, complete) and
`beatmatching-automation.md` (the follow-on feature work). Ordering below is by
risk and dependency; each phase ships separately with the standard acceptance
bar (typecheck, lint, lint:exports, prettier, full `pnpm test` green) and one
commit per phase. Estimated sizes: R0 S, R1 S, R2 M, R3 M, R4 L, R5 S, R6 M.

## Phase R0 — hygiene and correctness batch (S)

Eleven small fixes, no design questions:

1. **Crash-consistency transactions.** Wrap `upsertFromScan` and
   `updateScanFields` (`repository.ts`) each in one `withTransaction`; wrap
   analysis-repository `upsert` + `replaceSections` into a single transaction so
   a crash between them cannot leave an analysis row without sections.
2. **`updateMetadata` single sources write.** Fold the `sources.genres` update
   into the main `UPDATE` (compute before, write once).
3. **Dead surface removal.** Delete `service.getTrackEvidence` (verified: no
   callers). Remove the `catalogNumber` field from the tag-parsing return shape
   (`metadata.ts`) — persistence drops it and enrichment sources its own from
   MusicBrainz releases.
4. **`decodeCursor` enum validation** (`pagination.ts`): reject cursors whose
   `sort` is not a `SortField` or `direction` not asc/desc with the existing
   `INVALID_CURSOR` error shape.
5. **PATH-walk dedup:** `analysis/key-engine.ts` reuses `which.ts` instead of
   its own directory scan.
6. **`MixIntent` dedup:** `render/audio-diagnostics.ts` imports the domain type
   and extends with `| null` locally instead of re-declaring.
7. **Enrichment BPM-fold consistency** (`enrichment/coordinator.ts`): compute
   the genre list once (`track.genres ?? recording.genres`) and use it for both
   the fold decision and the write.
8. **Empty analysis selection error code:** `startTrackAnalysis` with nothing
   to do throws `INVALID_METADATA` (input error) instead of `ANALYSIS_FAILED`;
   update `docs/tool-contracts.md`.
9. **Hour-feedback output schemas:** add `recordHourFeedbackDataSchema` /
   `listHourFeedbackDataSchema` to `hour-feedback-contracts.ts` and register
   `outputSchema` on the two MCP tools (consistency with the other 43).
10. **`db:migrate` envelope** (`apps/cli`): print the standard
    `{ ok: true, data }` envelope.
11. **`redactInvocation`** (`filter-graph.ts`): also redact bare relative
    filenames (arguments without `/`, `\`, or drive letters that look like
    paths, e.g. contain an extension).

Behavior notes: `resume()` clearing issues and the `wait()` loop stay as they
are — resume semantics are deliberate freshness, and `wait()` timeouts belong
to the CLI flags that already exist where they matter. If we want an opt-in
`wait(id, { timeoutMs })` later it is a three-line addition, not debt.

**Acceptance:** full suite green; no planner/render output changes.

## Phase R1 — type↔schema drift guard (S)

Add `packages/domain/src/type-mirror-checks.ts`: compile-time, both-directional
assignability assertions between every hand-written mirror type and its zod
inference, e.g.

```ts
import type { z } from "zod/v4";
import type {
  createSetPlanInputSchema,
  setPlanV1Schema,
  planQualityReportSchema,
} from "./contracts.ts";
import type { CreateSetPlanInput, SetPlanV1, PlanQualityReport } from "./planning.ts";

export const _createInputMatchesSchema: CreateSetPlanInput = null as unknown as z.output<
  typeof createSetPlanInputSchema
>;
export const _createInputMatchesType: z.output<typeof createSetPlanInputSchema> =
  null as unknown as CreateSetPlanInput;
// …same pair for SetPlanV1, PlanQualityReport, ScoreComponents (via the score
// breakdown schema), RateTransitionInput, TransitionFeedback, TrackMetadataPatch.
```

Any optionality drift becomes a typecheck error (this exact check would have
caught the `feedback` drift fixed in Q2). The file is typechecked but not in
the barrel, so the export guard ignores it. Full `z.infer` derivation stays
rejected: it churns public type ergonomics for no additional safety over this
guard.

**Acceptance:** guard compiles; then deliberately break one mirror in a scratch
branch and confirm typecheck fails (do not commit the break).

## Phase R2 — remove `double_drop` and `hourAuditionWindow` (M, breaking)

Removing reserved/public contract surface. Stored data must keep reading, so
this ships with data migration **019**.

1. **Migration 019 (`009_double_drop_retired.ts` numbering continues at 019):**
   rewrite `"type":"double_drop"` → `"phrase_mix"` in
   `set_plan_entries.transition_json` and approved-recipe payload JSON
   (`track_recipes` / wherever `reusable_payload` lives — check the exact table
   in `approved-recipe-repository.ts`). Both rewrite in JS inside the migration
   (SELECT → transform → UPDATE). Ancient double_drop rows were hand-made; the
   rewrite is documented in the migration header.
2. **Type/schema removal:** drop `double_drop` from `transitionTypeSchema`
   (`domain/src/transition-type.ts`), which leaves it identical to
   `activeTransitionTypeSchema` — collapse the two into one
   `transitionTypeSchema` and update the ~4 import sites. Remove
   `double_drop` from the `TransitionType` union (`domain/src/planning.ts`),
   the quality counting branch (`planning/quality.ts`), and the recall allowlist
   (`planning/recall.ts`).
3. **`hourAuditionWindow`:** remove from `planQualityReportSchema`, the
   `PlanQualityReport` type, and the always-null assignment in
   `planning/quality.ts`.
4. **Docs:** update `docs/tool-contracts.md` (quality report fields), any
   mention in `docs/mixing.md`, and the MCP tool descriptions if they reference
   either name. The handlers test's expected tool list is unchanged.

**Acceptance:** migration test extension (insert a double_drop transition row,
run migrations, read plan → phrase_mix); full suite green; `pnpm lint:exports`
green.

## Phase R3 — rename stored `shortTermLufs*` keys (M, analyzer bump + migration)

Rename to what the values are: `shortTermRmsDbfsMean` / `shortTermRmsDbfsMax`.

1. Rename in `domain/src/analysis.ts` (`SonicDescriptors`), the descriptor
   computation (`audio-analysis/src/descriptors.ts` pack input and output), the
   analyzer result assembly (`dsp-analyzer.ts`), and any contracts that expose
   them (`trackAnalysisSchema` / descriptor views). Search JSON paths in
   `repository-search.ts` do not reference these keys — verify with grep.
2. Bump `DSP_ANALYZER_VERSION` → 3.5.0 (stale scope will re-analyze).
3. **Migration 020:** rename the keys inside every stored
   `track_analyses.descriptors_json` (JS transform: parse, rename, stringify,
   UPDATE). Old rows stay readable (they are stale until re-analyzed anyway,
   and the user re-runs `analysis:run --scope stale` once).
4. Remove the "historical key" doc comment added in Q-fix; the name now tells
   the truth.
5. Tests: update the descriptor fixtures that pin the old keys
   (`descriptors.test.ts`, `catalog/test` fixtures that use
   `shortTermLufsMean`).

**Acceptance:** full suite green; `analysis:get` on a migrated (pre-re-analysis)
row returns the new keys; after `stale` re-analysis values are unchanged from
3.4.0 (rename only — no computation change, so pre/post values must match).

## Phase R4 — pairwise render I/O rework (L, engineering) — PARKED WITH DATA (October 2026)

Baseline (this machine, real FFmpeg, synthetic 174 BPM phrase_mix plans, DSP
3.5.0; harness kept at `tools/scripts/measure-pairwise-io.mts`):

| joins | wall time          | output tree |
| ----- | ------------------ | ----------- |
| 20    | 108.3 s            | 269 MB      |
| 40    | 317.7 s (≈5.3 min) | 523 MB      |

Growth is ~2.9× for 2× the joins — superlinear as expected, but a 40-join
(~2-hour) mix renders in well under the 10-minute park threshold, so the
rework is **parked**. Extrapolation puts the crossing at roughly 55–60 joins
(3-hour mixes), which no current use case asks for. If that changes: re-measure
with the harness, then implement the balanced-tree stitching below. The design
and gates stay recorded for that day.

Problem being solved: N-join mixes run N pairwise renders plus N−1 stitches,
and each stitch re-encodes the whole accumulated prefix → O(N²) bytes. Fine at
~15 joins (60-minute mix), punishing at 100+ joins (multi-hour).

1. **Measure first** — done, above.
2. **Design: balanced-tree stitching.** Keep per-join pairwise rendering and
   the shared-deck crossover guarantees exactly as they are; change only how
   partial results combine. Instead of `acc = stitch(acc, join_i)` linearly,
   combine segments in a balanced merge tree (depth ⌈log₂ N⌉): each merge
   xfades only the real seam it creates, so every original seam is xfaded
   exactly once (same as today), but total I/O drops to O(N log N). Temp-file
   naming gains a merge-level marker so the existing startup sweep covers it.
3. **Gates:** duration must match the plan within the existing 1000 ms bound;
   `render:check` green on the fixture; one real audition A/B (linear vs tree)
   on a 20-join plan before default.
4. Explicit non-goals: no single-graph whole-mix filter (it would re-derive the
   phase-equality guarantees), no changes to per-join audio.

**Found while measuring (follow-up candidate, not fixed here):**
`snapshotTrackEvidence` (`catalog/src/evidence.ts`) copies `musicalKey`/
`keyConfidence` only from analysis rows, so a catalog whose keys are
**manual/published** (never analyzed) freezes `keyConfidence: 0` into render
evidence — the render-time gate then rejects plans the live gate accepted.
Catalogs with analyzed keys are unaffected. A proper fix (resolve the canonical
key into the snapshot the way `resolveCanonicalKeyConfidence` does, and extend
`analysisFromFrozen` to carry it) is a small, testable change that belongs in
its own commit with render tests, not inside this perf phase.

## Phase R5 — README command reference (S)

Add a compact grouped table of all 41 CLI commands (workflow, library, tracks,
analysis, enrichment, planning, transitions, feedback, render, maintenance) to
the README (or a `docs/cli.md` linked from it, if the README stays lean).
Commands, flags, and the enqueue-vs-`--wait` distinction come from
`apps/cli/src/usage.ts` so the table and usage text are written together.

## Phase R6 — architecture documentation (LAST, per decision)

Write `docs/architecture.md` — the map a new contributor (or a future session)
needs after all the splits. Contents:

1. **Layering:** apps (CLI, MCP) → catalog (services, persistence,
   orchestration) → audio-analysis / audio-renderer → domain; the ESLint
   boundary rules that enforce it.
2. **Module map:** one-line responsibility for every meaningful module as it
   exists after R0–R4 — `catalog/src/service/*`, `repository-*`, `provenance`,
   `planning/{planner,pool,selection,finalize,timeline,windows,handoff,
onset-lock,quality,validate,transition-planner,recall,repair-search,
constraints,applied-recipe,shared}`, `render/{coordinator,check-metrics,
audio-diagnostics,temp-sweep}`, `analysis/`, `enrichment/`,
   `mix-workflow.ts`, `worker-owner.ts`; the domain and audio package shapes.
3. **Pipelines and lifecycles:** scan → analyze (DSP + key stage) → plan →
   render → check, with the mix-workflow stage machine and the worker-owner
   job/heartbeat model (including the 5-minute staleness trade).
4. **Stored data:** tables, the JSON columns, the provenance model
   (manual > published > analyzed > tag), frozen evidence and why renders
   snapshot it.
5. **Principles:** determinism (same catalog + brief + seed → same plan),
   fail-closed rendering, analysis is advisory, cues are never invented, no
   absolute paths across the tool boundary.
6. **Where to add things:** new MCP tool (contracts → server module → service
   facade), new CLI command (commands module + usage), new analyzer feature
   (version bump policy + stale re-analysis contract), new migration.
7. README's "Layout" section links to it.

## Explicitly still leaving (with reasons, revisited)

- **Descriptor stretch recalibration** — research task, owned by beatmatching
  Phase 2 when groove metrics re-open `descriptors.ts`.
- **Stats/`toView` full-table scans** — invisible at single-user scale.
- **Heartbeat 5-minute staleness window vs. a pathological >5-minute
  synchronous stall** — deliberate documented trade; revisit only if observed.

## Acceptance bar (every phase)

- `pnpm typecheck`, `pnpm lint`, `pnpm lint:exports`, `pnpm format:check`,
  full `pnpm test` green.
- R0–R3 change no planner output; R3 changes only the renamed descriptor keys
  (values identical); R4 changes render splice order only behind its gates.
- One commit per phase, phase tag in the subject.
