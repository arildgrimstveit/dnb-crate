# Architecture

How DnB Crate is put together: the layers, what each module owns, how the
pipelines flow, and where to add things. Companion docs: [README](../README.md)
(usage), [analysis](analysis.md) / [scoring](scoring.md) / [mixing](mixing.md) /
[rendering](rendering.md) (behavior), [tool-contracts](tool-contracts.md) (MCP
surface), [cli](cli.md) (commands), [first-mix](first-mix.md) (onboarding).

## Layers

```
apps/cli          administration: same services as MCP, prints JSON envelopes
apps/mcp-server   thin MCP adapters: 45 tools -> CatalogService, 4 resources, 1 prompt
  |
packages/catalog  services + persistence + orchestration (no audio math)
  |
packages/audio-analysis   DSP: grids, sections, descriptors   \
packages/audio-renderer   FFmpeg/Rubber Band graphs            > domain contracts only
  |
packages/domain   types, zod schemas, scoring, tempo/keys math, config, constants
```

Dependencies point strictly inward. ESLint enforces it: `domain` may not
import catalog/audio code, `audio-*` may not import each other or catalog,
`catalog` may not import the apps. The CLI and MCP server are adapters — all
behavior lives in `packages/catalog` and below, which is why both surfaces stay
in lockstep (the MCP handler list and CLI command set are each pinned by tests).

**One rule of thumb:** if logic needs SQLite, it belongs in `catalog`; if it
needs samples or FFmpeg, in an `audio-*` package; if it is a type, schema, or
pure calculation used by more than one of those, in `domain`.

## packages/domain

| Module                                                          | Owns                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `constants.ts`                                                  | every named number in the system: score weights, timing windows, planner tuning, render targets (docs quote these) |
| `tempo.ts` / `keys.ts` / `rate-regions.ts`                      | BPM folding (160–190 default, configurable), pair-tempo/chain-lock math, Camelot relations, playback-rate regions  |
| `contracts/` (common/track/planning/prompts) + `*-contracts.ts` | the entire MCP wire surface as zod schemas; `tool-result.ts` is the response envelope                              |
| `planning.ts`                                                   | plan/transition/explanation **types** (mirrors of the schemas)                                                     |
| `mix-presets.ts`, `recipe.ts`, `approved-recipe.ts`             | phrase/bass-swap automation expansion, recipe fingerprints and applicability                                       |
| `type-mirror-checks.ts`                                         | compile-time guard: hand-written types may never drift from their schemas                                          |

Analysis metadata provenance is ordered **manual > published > analyzed > tag**
and that ordering is enforced at every write site (`provenance.ts`).

## packages/audio-analysis

`dsp-analyzer.ts` is the only analysis engine (`dnb-crate-dsp`). One streaming
STFT pass (`forEachStftFrame`) derives onset/snare/kick series, grids, sections,
cues, and descriptors without materializing the frames×bins matrix; chroma/key
evidence is collected per frame (`chroma.ts`) and scored once. `DSP_ANALYZER_VERSION`
in `domain/constants.ts` gates staleness: bump it and `analysis:run --scope stale`
re-analyzes the library. The analyzer never invents values — rejected grids
expose a `bpmHint` at most.

## packages/audio-renderer

`filter-graph.ts` compiles FFmpeg filter graphs (phrase-mix/bass-swap band
templates, crossover reconstruction, limiter); `mix.ts` drives a full render
(decode → joins → stitch → one static gain toward −14 LUFS (bidirectional,
true-peak capped) → conditional limiter → 24-bit master + dithered 16-bit
listen); `rubberband-cli.ts` owns R3 fidelity stretch (frozen path + SHA-256 at
queue time, refused if replaced). Renders **fail closed**: missing loudness or
over-ceiling measurements fail the job rather than ship.

## packages/catalog

Persistence is one SQLite database per config (`db.ts` opens, migrations run
additively on open — `migrations/001..023`). Repositories own SQL, nothing else
does:

| Module                                                                                            | Owns                                                                                                 |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `repository.ts` + `repository-search.ts` / `repository-stats.ts` / `provenance.ts`                | tracks CRUD/hydration, the search SQL compiler, whole-library stats, field-source/provenance writers |
| `analysis-repository.ts`, `analysis/` (coordinator, key-engine)                                   | analysis rows + stages; the KeyFinder WAV CLI stage                                                  |
| `set-plan-repository.ts`                                                                          | plan rows; stored JSON is schema-validated on read and fails closed                                  |
| `render-job-repository.ts`, `render/` (coordinator, check-metrics, audio-diagnostics, temp-sweep) | render jobs, frozen evidence/settings, post-render checks, stale temp cleanup                        |
| `enrichment/`                                                                                     | optional MusicBrainz/Deezer/AcoustID matching (off by default; response cache with TTL)              |
| `feedback-repository.ts`, `hour-feedback-repository.ts`, `approved-recipe-repository.ts`          | listen ratings, whole-render verdicts, reusable recipes                                              |

Services and orchestration:

| Module                           | Owns                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.ts`                     | the `CatalogService` facade both apps call; logic delegated to `service/` modules (analysis-report, compatible-tracks, plan-editor, quality-evidence)                                                                                                                                                                                                                                    |
| `planning/`                      | the deterministic planner: `pool.ts` (filters/relaxation/pins) → `planner.ts` (selection loop, lookahead, retries) → `finalize.ts` (plan + explanation); `selection.ts` holds the shared quality gates and entry rebuilder; `timeline.ts`/`windows.ts`/`handoff.ts`/`onset-lock.ts` choose joins; `quality.ts`/`validate.ts` gate render readiness; `recall.ts` replays approved recipes |
| `mix-workflow.ts`                | the first-mix state machine (preflight → scan → analysis → plan → validate → render → check); cancellation can never be resurrected by an in-flight step                                                                                                                                                                                                                                 |
| `worker-owner.ts`                | single local job owner per database: PID + heartbeat (5-minute staleness covers the pid-reuse wedge); all runtimes else submit-only                                                                                                                                                                                                                                                      |
| `library-scan.ts` + `scanner.ts` | directory traversal and import/move/missing reconciliation                                                                                                                                                                                                                                                                                                                               |

## Pipelines

**Ask → mix.** `start_mix_workflow` freezes the brief under a request token,
then stages run idempotently: analysis children are chunked (100/transaction)
and re-checked on resume; the plan transaction shares its checkpoint; render
ids are reserved before enqueue. Success requires strict plan readiness, green
render checks, and verified master+listen files.

**Plan determinism.** Same catalog + brief + seed → same plan. All tie-breaks
are explicit (`id.localeCompare`), exploration is a seeded hash, and the retry
layers (chain search, opener attempts, bounded repair search) are recorded in
the plan's explanation. The regression oracle for any planner change is the
pinned expectations in `planning.test.ts`.

**Render freezing.** A queued render snapshots the plan, selected evidence,
source fingerprints, engine ids, and the Rubber Band hash. Editing the live
plan or re-analyzing never changes what an already-queued job renders; an
incompatible engine or replaced binary fails the job instead. Frozen evidence
owns its absences (a value recorded null at queue time stays null), and
execution verifies source content by reading the actual bytes — not the
queue-time hash cache.

**Worker ownership.** One process owns background work per catalog
(`worker_owner`, heartbeat-stale takeover). Claims stamp the owner token on
the job (`claimed_by`); completion writes are fenced to the claiming owner, so
a deposed worker finishing after takeover cannot overwrite recovery state or
publish over the winner. In-flight jobs may still finish during a graceful
close before the token is released.

**Determinism, qualified.** Planning is deterministic for the same brief,
seed, catalog state, resolved history, policy version, and evidence — not
unconditionally: current analysis, feedback, approved recipes, and the
algorithm policy remain live inputs, and variety history is resolved from the
plan store at planning time. "Exact replay" replans under current policy from
the referenced plan's frozen history context (tracks, pairs, artist uses,
seed); it is not a whole-context snapshot replay.

## Stored data

Tables: `tracks` (+ cue points, moods/subgenres/tags/genres relations),
`track_analyses` (+ sections, `analysis_stages` per dsp/key), `set_plans` (+
entries; constraints and transitions as validated JSON), `render_jobs`
(+ manifests, frozen requests), `approved_recipes`, `track_feedback`,
`hour_feedback`, `mix_workflows`, `worker_owner`. JSON columns are written by
the code that owns their schema and validated on read where corruption would
silently lie (plans, in particular).

## Where to add things

- **New MCP tool:** schema in `domain/src/contracts/*`, handler in
  `apps/mcp-server/src/tools/*`, method on `CatalogService`; add the name to
  the handlers test's pinned list.
- **New CLI command:** module in `apps/cli/src/commands/`, line in `usage()`,
  row in `docs/cli.md`.
- **New analysis output:** extend the analyzer, **bump `DSP_ANALYZER_VERSION`**
  (one-time `--scope stale` re-analysis), migrate stored JSON if keys change
  (see migrations 019/020 for the pattern).
- **New persisted shape:** additive migration in `catalog/src/migrations/`,
  registered in `migrate.ts`, plus a validating read if it is JSON.
- **New scoring/planner behavior:** constants into `domain/constants.ts`,
  update `docs/scoring.md`, and keep `planning.test.ts` expectations explicit
  about the change.
