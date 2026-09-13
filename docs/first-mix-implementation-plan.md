# Implementation handover: folder to first mix

## Assignment

Build a reliable local workflow that takes a configured music folder and a mix brief through scanning, analysis, planning, validation, rendering, and final checking. Integrate KeyFinder into normal track analysis first. Users must not need maintenance scripts, manual database edits, or invented metadata to make their first mix.

This is an implementation specification, not an implemented feature. Repository baseline: `73bec9e` on `main`, inspected 2026-09-14. The baseline passes 408 tests, type checking, lint, and formatting. Recheck the current checkout before editing and preserve unrelated changes.

Deliver working code, migrations, CLI/MCP contracts, documentation, and tests. Follow the stages below; each stage should leave the repository usable. Use existing services and keep CLI/MCP handlers thin.

## Outcome and scope

Given a configured folder with enough suitable, untagged DnB MP3s and the required local tools installed, a user can request a mix and receive verified master/listen output through one operation. An unsuitable library must instead produce an accurate, actionable explanation. File-format support is broad; musical analysis remains DnB-specific (including the current 160–190 BPM assumptions).

The first release includes:

- Automatic, separately tracked key analysis during ordinary analysis.
- Dependency and configuration preflight with useful remediation.
- A persisted, resumable mix workflow shared by CLI and MCP.
- Stage progress, reusable analysis, structured blockers, cancellation, and recovery.
- Documentation that explains the prerequisites and the shortest successful path.

Out of scope: a GUI, automatic dependency downloads/installers, multi-genre beat analysis, streaming services, MP3 output encoding, external metadata enrichment by default, replacing the DSP or stretching engine, and relaxing strict mix-quality policy. Initial folder/config selection remains the documented setup step; MCP continues to use configured roots rather than accepting arbitrary filesystem paths.

## Current implementation and entry points

- `packages/catalog/src/library-scan.ts`: scan/import/reconciliation orchestration, including incomplete-scan protection.
- `packages/catalog/src/scanner.ts`: filesystem traversal and root resolution.
- `packages/catalog/src/analysis/coordinator.ts`: queued DSP analysis, bounded PCM prefetch, persistence, and shutdown.
- `packages/catalog/src/analysis/load-pcm.ts`: mono 22.05 kHz analysis decode.
- `packages/catalog/src/analysis/key-engine.ts`: existing KeyFinder discovery, stereo 44.1 kHz decode, invocation, and key parsing. Currently discovers the executable repeatedly; configuration is not used by the probe. Parsing assigns 0.7 confidence to recognized keys; this is a heuristic, not a measured probability.
- `tools/scripts/fill-crate-keys-and-bpm.mts` and `promote-keyfinder.mts`: existing manual key storage/promotion paths. Extract reusable behavior; do not copy script orchestration into production services.
- `packages/catalog/src/analysis-repository.ts`, `evidence.ts`, and `repository.ts`: stored analysis rows, independent rhythm/structure/key selections, and canonical metadata precedence.
- `packages/catalog/src/service.ts`: public catalog operations and plan/render readiness checks.
- `packages/catalog/src/index.ts`, `worker-owner.ts`, and existing job repositories: composition root, single local worker ownership, polling, recovery, and shutdown.
- `packages/catalog/src/render/coordinator.ts`: frozen render settings, binary identity checks, quality validation, verified listen publication, and render checking.
- `packages/domain/src/config.ts`, `load-config.ts`, `analysis-contracts.ts`, and `constants.ts`: config and external contracts. The public analysis-engine list currently allows only `dnb-crate-dsp`.
- `apps/cli/src/main.ts` and `apps/mcp-server/src/create-server.ts`: adapters; update their tests and tool descriptions as part of delivery.

Do not assume the existing maintenance scripts are resumable jobs. Inspect their storage and evidence-selection behavior before replacing them.

## Stage 1: integrate key analysis

### Configuration and execution

Add a validated `keyfinderPath` option, with `DNB_CRATE_KEYFINDER_PATH` support through the existing config loader. Add `analysis.keyAnalysis: "auto" | "off"`, defaulting to `auto` without breaking existing configs.

Use a documented discovery order: explicit configured executable, supported bundled location, then PATH. An invalid explicit path must produce a configuration error rather than silently selecting another binary. Verify usability, not merely file existence. Keep process execution shell-free and inject `ProcessRunner` for tests.

Resolve the executable once per analysis job/batch, pass it into execution, and record its identity with key evidence. Invalidate discovery when retrying after a dependency/config change. Add cancellation and timeouts to both decoding and KeyFinder execution, with temporary-file cleanup on every exit path.

Preserve KeyFinder's stereo 44.1 kHz input contract. Do not feed it the mono DSP PCM merely to save a decode. Keep decode/process concurrency bounded; avoid loading the whole library into memory. Optimize shared decoding only if equivalent audio behavior is demonstrated.

### Evidence and freshness

Keep `dnb-crate-dsp` as the public rhythm-analysis engine; KeyFinder is an internal key-analysis stage. Do not add it to the public engine enum as though it supplied beat grids and sections.

Persist key evidence under `analyzer_name = "keyfinder"` using the existing separate-row model. Extract a catalog-owned service for storage, canonical promotion, and key selection. Preserve `manual > published > analyzed > tag`, rhythm/structure selections, manual cues, and beat anchors. Change only the key selection when appropriate; respect existing explicit user evidence choices.

Track key-stage state independently: pending/running/succeeded/failed/skipped, source fingerprint, analyzer/executable identity, analyzed time, and a useful failure/skip reason. Use an additive migration or equivalent durable schema extension. Existing key rows without freshness metadata must remain readable; treat their freshness as unknown and recheck when needed.

Define work selection per stage:

- Reuse current successful DSP and key results independently.
- Missing or stale keys must be picked up even when the DSP row is current and the track's old analysis status is complete.
- Manual/published canonical keys may skip automatic key measurement by default; report that as a deliberate skip.
- Failed key work can be retried without discarding or recomputing successful DSP work.
- A changed source fingerprint or key executable/version invalidates the relevant cached result.
- A missing/invalid KeyFinder result must never manufacture a key or erase a valid manual/published key. Mark stale evidence accurately and prevent it being represented as current after the source changes.

Ordinary analysis should preserve successful rhythm results if KeyFinder is unavailable or fails. Expose key-stage warnings/failures explicitly; do not describe the track as fully prepared when required key evidence is absent. The one-operation workflow decides whether the usable remainder can satisfy the brief.

Centralize the existing 0.7 confidence policy and document it as heuristic. Do not imply that KeyFinder emits calibrated confidence.

Update the maintenance scripts to delegate to the same service, or deprecate them with a working replacement command. Remove duplicate production logic only after equivalent behavior is tested.

## Stage 2: preflight and readiness

Create one catalog-owned preflight/readiness service, with structured results shared by CLI and MCP. Separate dependency/configuration checks from brief-specific planning readiness.

Check configured roots, output-directory writability and containment rules, FFmpeg/ffprobe and required capabilities, KeyFinder, and the standalone Rubber Band requirements of the existing fidelity policy. Detect known missing requirements before expensive analysis. Re-evaluate conditional requirements after candidate selection/planning; for example, KeyFinder is needed when usable keys are missing, and stretching requirements depend on the plan.

Return stable issue codes, severity, scope/stage, affected track IDs/counts where relevant, retryability, a plain-language explanation, and a concrete next action. Examples include missing dependency, unreadable source, missing key evidence, rejected grids, insufficient usable material, unsatisfied brief constraints, failed plan quality, and failed render checks.

Use existing evidence resolution and plan-quality services as the authority. Simple counts are diagnostic, not proof that a full mix is feasible. Unreadable files should not block the whole library if enough valid candidates remain. An incomplete scan retains the existing protection against falsely marking files missing.

Keep MCP results consistent with existing path/privacy conventions: config keys and logical root/track identifiers rather than new absolute-path disclosures. Do not automatically install software, enable enrichment, change the brief, or turn quality checks off.

## Stage 3: durable first-mix workflow

Add a small workflow coordinator/repository under the catalog package, composed through `createCatalogRuntime`. Reuse scan, analysis, plan, validation, render, and check services. Avoid growing `CatalogService` into a second implementation of each stage.

Proposed stage order:

1. Preflight known configuration/dependency requirements.
2. Scan and reconcile the configured library.
3. Select missing/stale analysis work, including key-only backfill.
4. Run/reuse analysis jobs with per-track outcomes.
5. Assess readiness and create a plan from the submitted brief.
6. Validate the actual plan and conditional render dependencies.
7. Run/reuse the render job.
8. Check the output and return verified output references.

Persist workflow ID, immutable submitted brief/seed, effective relevant settings and versions, current stage/status, child job IDs, plan ID, stage progress, issues, timestamps, and final result. Capture the candidate/source identities after scanning so resume can detect changes without silently rebuilding a supposedly identical request.

Suggested statuses: `queued`, `running`, `blocked`, `succeeded`, `failed`, `cancelled`. Define `blocked` as an actionable unmet prerequisite or brief constraint; `failed` as execution failure. Track stage completion separately from overall status. Avoid misleading overall percentages; report stage and completed/total work where known.

### Recovery and ownership requirements

- Participate in the existing worker-owner lifecycle. Do not create another independent worker loop or allow passive reporting runtimes to execute jobs.
- The workflow must yield while child jobs run; it must not hold a transaction or block the worker needed to complete those jobs.
- Persist the stage checkpoint and child-job association atomically, or use a unique parent/stage key to make child creation recoverably idempotent. A crash between enqueue and checkpoint must not create a duplicate render on resume.
- Accept a caller request token for idempotent start. Reusing a token with a different brief is an error; deliberately starting another mix uses a new token.
- Resume reuses completed valid stages and existing child jobs. Revalidate affected stages after source/settings/version changes. Do not silently overwrite an already created plan with a different one.
- Scanning may restart safely after interruption. Analysis resumes from valid per-track/per-stage results. Reuse the renderer's existing recovery/publication policy; do not promise sample-level render resume.
- Cancellation stops further scheduling and propagates to work owned exclusively by this workflow. Do not cancel unrelated/shared jobs. Release ownership only after active processes and cleanup settle.
- Preserve the existing shutdown guarantee that `await runtime.close()` drains work before closing SQLite.

Success requires the actual plan to pass existing strict readiness checks and the rendered output to pass required checks. Require the expected listen deliverable for first-mix success: if the master exists but the listen copy is withheld, retain the master and report the failure explicitly rather than reporting an unqualified success. Partial plans remain available for inspection but are not silently rendered as fulfillment of the original request.

## Stage 4: CLI, MCP, and onboarding

Use the existing mix brief schema rather than introducing a competing vocabulary. Proposed interfaces, to finalize consistently with existing conventions:

- CLI: `mix:create --brief-json brief.json --wait`, plus the existing-style name/duration/seed shortcuts; `mix:status --id ID`, `mix:resume --id ID --wait`, and `mix:cancel --id ID`.
- MCP: `start_mix_workflow`, `get_mix_workflow`, `resume_mix_workflow`, and `cancel_mix_workflow`.
- Expose the same preflight report through a CLI health/readiness command and MCP tool, reusing existing status endpoints where that keeps the API simpler.

Start returns a workflow ID promptly. CLI `--wait` keeps an active worker alive; enqueue-only mode must clearly report that a live worker is required. MCP runs asynchronously through the existing server worker. JSON remains on stdout; human progress/diagnostics go to stderr. Large libraries must be chunked within existing analysis input limits rather than raising an unbounded limit.

Final output includes workflow/plan/render IDs, verification outcome, master/listen references, track count, actual duration, and warnings. Blocked output gives the reason and next action, such as installing KeyFinder, adding suitable tracks, or explicitly requesting a shorter mix. Do not alter the user's duration or quality policy automatically.

Update README, analysis docs, tool contracts, CLI help, and the MCP prompt so the preferred first-run flow uses this operation. Describe setup honestly: users still need the repository/runtime and supported native tools installed. Remove instructions that imply a maintenance script is necessary for ordinary key analysis.

## Verification and acceptance criteria

Use generated audio and isolated temporary catalogs; never depend on a private library or external metadata services.

1. Untagged, harmonically suitable DnB fixtures with enough duration complete scan → rhythm/key analysis → strict plan → render → output check through CLI and MCP. Assert persisted stage and child IDs plus playable master/listen output. Do not bypass quality with fixture-only settings in this acceptance test.
2. Keep existing real CBR/VBR MP3 and mixed-format tests. Add known-key synthetic chord/music fixtures for actual KeyFinder integration; use controlled runner doubles for job and failure semantics.
3. Manual/published keys, cues, rhythm evidence, and anchors survive analysis and key backfill unchanged. Test an explicit user key selection separately from automatic selection.
4. A DSP-complete/key-missing catalog acquires keys without rerunning valid DSP. Unchanged resume launches no unnecessary analysis/decodes. Changed fingerprints/versions invalidate only the appropriate results.
5. Missing executable, invalid configured path, unrecognized key output, timeout, corrupt file, cancellation, and unwritable output yield actionable outcomes and leave no orphan temporary files.
6. Crash/restart at each stage boundary—including child creation before checkpoint—reuses the right jobs without duplicate plans/renders. Two runtimes still allow only one worker owner. Test passive CLI reads and shutdown with active/prefetched work.
7. An unsuitable or too-small library returns a truthful blocker/partial plan and never silently relaxes strict checks. Invalid render checks or withheld listen output cannot appear as full success.
8. Existing catalogs migrate without losing stored analysis, selections, plans, or manifests. Existing analysis commands and saved plans remain compatible.
9. A library beyond the per-request analysis limit processes in bounded chunks; concurrency stays within configured bounds. Assert work/process counts rather than fragile wall-clock thresholds.

CI currently installs FFmpeg, not KeyFinder. Add a reproducible supported KeyFinder build/setup for at least one real integration job, or provide an explicit documented test target with mandatory execution evidence before declaring the feature complete. Do not silently skip all real key detection coverage. Test Windows discovery/path handling as well as Linux CI execution. Verify licensing/distribution constraints before choosing any bundled executable approach; automatic bundling is not required by this scope.

Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm format:check`. Report actual commands/results, including the real-KeyFinder test environment.

## Delivery sequence and completion report

Implement in reviewable increments: (1) key-stage service/config/freshness and tests, (2) preflight/readiness, (3) durable workflow/recovery, (4) adapters/onboarding and end-to-end acceptance. Avoid unrelated renderer or planner tuning.

The final implementation report should list user-visible behavior, schema/config changes, migration compatibility, verified failure/recovery paths, test results, and any remaining platform prerequisites. Include a copyable first-mix command and the equivalent MCP request. Do not claim universal musical compatibility or guaranteed success for arbitrary folders.
