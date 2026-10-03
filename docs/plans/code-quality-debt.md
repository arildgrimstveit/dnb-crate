# Implementation plan: code-quality debt

Companion to the October 2026 full-repo review. Every item here is a **move,
dedup, delete, or guard** — no behavior changes. The regression oracles are the
existing suites (494 tests) plus the planner's pinned expectations; anything
that changes a score, a cue, a render, or a persisted shape is out of scope and
belongs in the beatmatching plan instead.

Ordering is by risk: dead code first (nothing depends on it), then
deduplication, then contract hygiene, then the god-file splits. Each phase
ships separately with `pnpm typecheck`, `pnpm lint`, `prettier --check`, and
the full `pnpm test` green. The beatmatching phases
(`plans/beatmatching-automation.md`) proceed after this plan completes.

## Known accepted debt (do not "fix")

- `double_drop` stays in the transition-type union and quality counting: stored
  recipes/plans may carry it; nothing new creates it. Documented as reserved.
- `hourAuditionWindow` stays in the quality contract (always null today).
- Stored descriptor JSON keys (`shortTermLufsMean/Max` etc.) keep their names —
  they are persisted in analysis rows. The TS symbols get doc comments stating
  they are RMS-dBFS, not K-weighted LUFS.
- Crate-calibrated descriptor stretch constants (583-track run) stay.
- Type↔schema dual maintenance (`planning.ts` types vs `contracts.ts` schemas)
  is reduced where it has already drifted; a full `z.infer` migration is a
  breaking-change project and is explicitly deferred.

## Phase Q0 — dead code and no-op removal (S) — COMPLETE

Remove, after verifying zero importers (production, tests, tools):

- domain barrel: `grid-metrics.ts` whole module (`bpmDisagrees`,
  `downbeatPhaseAgreement`, `periodStats`, `PeriodStats`), `analysisScopeValues`
  - `AnalysisScope`, `MOOD_PRESETS`, descriptor-filter internals
    (`continuousEnergy`, `descriptorValue`, `valueInRange`, `hasDescriptorFilters`,
    `moodPresetScore`, `DescriptorValues`), `MIN_HARMONIC_CONFIDENCE`,
    mix-preset internals (`landingIncomingDropBar`, `outgoingHoldBars`,
    `SEQUENTIAL_*` constants), `sourcePositionToOutputMs`, `toolErrorSchema`,
    `approvedPairKey` alias, tempo internals not imported outside domain
    (`beatPeriodMs`, `barDurationMs`, `barIndexForBeat`, `foldedIntegerBpm`,
    `playbackRateDriftMs`, `snapPlaybackRate`, `shouldSkipAtempo`,
    `effectivePlaybackRate` — keep in module, drop from barrel).
- catalog: no-op ternary (`quality.ts:134`), always-true guard
  (`timeline.ts:705`), dead `method = method ?? "isrc"` (enrichment
  coordinator), deprecated `alignmentResidualMs` re-export (update the test
  that uses it), `readAudioTags` re-export (metadata.ts).
- `estimateKeyFromPitch` and `stftMagnitude` were already removed (analysis
  batch).

**Acceptance:** suite green; `git grep` for each removed symbol returns nothing.

## Phase Q1 — deduplication within packages (S–M) — COMPLETE except noted

Done: shared nowIso; domain clamp/finiteNumber; parameterized field writer;
recordingKeyOfRow; generic frozen-evidence collector; shared artistKey;
pairConstraintKey rename; single camelotNumberDelta. Remaining: the
approved-recipe applicability/feasibility merge and the DESCRIPTOR_KEYS single
source (both deferred with Q4 steps 3–5, which touch the same files).

- One `nowIso()` util in catalog; the five repository copies import it.
- Domain exports one `clamp`; `mix-presets.ts` local copy goes. One
  `paramNumber`/`num` helper replaces the approved-recipe and check-metrics
  copies.
- `repository.ts`: parameterize `applyTagFields`/`applyPublishedEnrichment`
  into one field-writer (literal `"tag" | "published"` + bpm extras); extract
  the canonical identity chain shared by `refreshRecordingIdentity` and
  `hydrate`.
- `evidence.ts`: one generic frozen-field collector replaces the three
  structurally identical extractors.
- `approved-recipe.ts`: shared check sequence under `recipeApplicability` /
  `recipeFeasibility` (they duplicate ~60% of their bodies).
- `constraints.ts` local `pairKey` renamed `pairConstraintKey` (name collision
  with domain `pairKey`, different separator).
- One `DESCRIPTOR_KEYS` list in domain; repository search/percentiles and
  `descriptorValue` consume it.
- planning/ dedup: `artistKey` (planner + quality) and `mean` (handoff,
  descriptors) move to a shared `planning/shared.ts`; `sectionAt`/
  `sectionAtMs` consumers unified on the domain helper where shapes allow.
- `keys.ts` computes harmonic number-distance once; the three call sites use it.

## Phase Q2 — contract hygiene (M) — PARTIAL

Done: feedback drift fixed; transition-type enums hoisted. Remaining: the
contracts.ts file split, requiredTransitionSchema/renderReadiness/issue-schema
hoists, set-plan-repository validating parses, uuid idiom unification.

- Fix the live drift: `scoreBreakdownSchema.components.feedback` becomes
  required (matches `ScoreComponents`).
- Hoist shared sub-schemas: `transitionTypeSchema` (replaces five inline
  enums), one `requiredTransitionSchema` (set-plan + create-input copies),
  `renderReadiness` imported from render-contracts instead of re-declared,
  `validationIssueSchema` shared with render-contracts, artist-gap object
  deduplicated, `getSetPlan`/`validateSetPlan` input schemas unified.
- Split `contracts.ts` into `contracts/common.ts`, `contracts/track.ts`,
  `contracts/planning.ts`, `contracts/prompts.ts`; the barrel re-exports the
  same names, so no external imports change.
- `set-plan-repository.ts`: validating parse for stored JSON (sections,
  explanation, constraints, transitions) on the `parseFieldSources` pattern;
  stop fabricating `handoffPolicy` on read.
- `z.uuid()` idiom unified on the `z.string().uuid()` form used elsewhere.

## Phase Q3 — planner constants and documentation (S) — COMPLETE

- Name the magic numbers in `constants.ts`: shortlist size (12), lookahead
  continuations (8), lookahead weight (0.35), variety costs (−8/−4), opener
  attempts (3), minimum pool estimate (16), required-progress bonuses.
- Sync the numbers into `docs/scoring.md` (already partially done in the
  contradictions batch).
- onset-lock `SCORE_MARGIN` / channel weights and `windows.ts` thresholds get
  names with their evidence comments.

## Phase Q4 — god-file splits (M–L, mechanical moves only)

**Progress (October 2026):** steps 1–2 complete (CLI commands split, MCP server
split into per-domain registration modules). Steps 3–6 remain.

Order within the phase is by independence (apps → service → persistence →
planner):

1. `apps/cli/src/main.ts` (681) → per-domain command modules plus a shared
   arg-parsing helper; `usage()` generated from the same table.
2. `apps/mcp-server/src/create-server.ts` (1155) → registration functions per
   domain (catalog, analysis, enrichment, planning, render, workflow) plus
   resources/prompt module; the 45-tool list test stays the gate.
3. `packages/catalog/src/service.ts` (1706) → facade keeps its public methods;
   logic moves to `analysis-report.ts`, `plan-editor.ts` (update/clone),
   `compatible-tracks.ts`, `quality-evidence.ts`.
4. `packages/catalog/src/repository.ts` (1367) → `repository/` CRUD + cues,
   `stats.ts` (stats/coverage incl. percentiles), `provenance.ts`
   (field-source writers), search SQL compiler module.
5. `packages/catalog/src/planning/planner.ts` `draftSetPlan` (~1040 lines) →
   `pool.ts` (filtering/relaxation/pin readmission), `selection.ts`
   (scoring/lookahead/chain search), `finalize.ts` (trim/pad/repair/opener
   retries); `draftSetPlan` orchestrates. Determinism review: no closure state
   may change hands mid-loop.
6. `analysis-repository.ts`: `descriptors_json` parsed once per row;
   `PREFERRED_ORDER` derived from engine constants.

## Phase Q5 — guardrails (S)

- CI job step or repo script that fails on unused domain-barrel exports
  (knip or ts-prune, devDependency only).
- Optional: file-length lint rule warning past ~800 lines to keep the splits
  from regrowing.

## Acceptance bar (every phase)

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, full `pnpm test` green.
- No public API change beyond the documented Q0 removals; the MCP 45-tool list
  and CLI command set are byte-identical.
- No planner output changes: `planning.test.ts` expectations (deterministic
  oracles) untouched.
- One commit per phase with the phase tag in the subject.
