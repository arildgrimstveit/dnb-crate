# DnB Crate MCP — Five-Stage Implementation Specification

**Document status:** Implementation-ready  
**Primary audience:** Coding/implementation agent working in Cursor  
**Project codename:** `dnb-crate-mcp`  
**Primary outcome:** Generate coherent, continuous DJ-style drum & bass sets from a private local music library using natural-language requests, an MCP server, deterministic planning, and a deterministic audio engine.

---

## 1. Product vision

DnB Crate MCP is a local-first “AI DJ for my own music” system. A user should eventually be able to ask an MCP-capable agent:

> Create a one-hour soulful and emotional liquid DnB set. Start atmospheric, build gradually into deep dancefloor, include two tasteful doubles near the peak, and finish with an emotional release. Favor music adjacent to Technimatic and Polaris.

The MCP host's language model interprets the request and uses tools exposed by this project. The project itself owns the reliable work:

- Cataloging and querying local tracks.
- Storing musical and personal metadata.
- Calculating compatibility and energy progression.
- Creating and validating explicit set plans.
- Analyzing audio and cue points.
- Rendering transitions and complete mixes.
- Previewing and rating transitions.

The model is the **intent interpreter and set-design collaborator**. The application is the **source of truth and deterministic audio engine**.

### 1.1 Final user experience

The intended mature interaction is:

1. The user describes the desired set in natural language.
2. The agent searches the local library through MCP tools.
3. The agent requests or generates a structured set plan.
4. The server validates timing, key, energy, cue points, and transition feasibility.
5. The agent revises invalid or weak choices.
6. The server renders previews or the complete set.
7. The user listens and optionally rates transitions.
8. Future plans use the stored feedback.

### 1.2 Architecture boundary

Do **not** embed an LLM or agent loop inside the MCP server during these five stages. The MCP host supplies the model. All core features must also be callable deterministically from tests or a CLI.

| Responsibility | Owner |
| --- | --- |
| Interpret “melancholic but hopeful” | MCP host/model |
| Decide which tools to call | MCP host/model |
| Search/filter tracks | MCP server/domain service |
| Calculate BPM/key compatibility | Domain service |
| Calculate set timing | Domain service |
| Validate set plans | Domain service |
| Read and modify the catalog | Repository layer |
| Analyze audio | Audio-analysis adapter |
| Mix and render audio | Audio-rendering adapter |
| Explain the result conversationally | MCP host/model |

### 1.3 Guiding rule

If a result can be calculated or verified deterministically, calculate or verify it in the application. Use the model for intent, ambiguity, creative planning, and explanation.

---

## 2. Scope and non-goals

### 2.1 In scope

- Private, local audio files owned or lawfully accessible by the user.
- Drum & bass as the first supported genre.
- Local MCP connection over `stdio` first.
- Metadata search and editing.
- Set planning with explicit JSON plans.
- Offline rendering of previews and full mixes.
- Progressive support for crossfades, phrase-aligned transitions, EQ-based bass swaps, and doubles.
- Persistent transition feedback.
- WAV output first; MP3 may be added after WAV is correct.

### 2.2 Explicit non-goals for the initial five stages

- Public redistribution or streaming of copyrighted audio.
- Spotify audio extraction, downloading, or circumventing service restrictions.
- Live, low-latency DJ performance.
- Replacing Ableton Live or professional DJ software.
- Fully automatic stem separation in the critical path.
- Guaranteed human-DJ-quality transitions for arbitrary genres.
- A polished consumer UI.
- Cloud hosting before local behavior is reliable.
- Giving MCP tools arbitrary filesystem paths or arbitrary shell commands.

### 2.3 Source-file safety

- Source music files are always read-only.
- Generated files must go into a separate configured output directory.
- The application must never rename, move, overwrite, retag, or delete a source track unless a future, explicitly authorized feature adds that behavior.

---

## 3. Technical defaults

These are the default implementation decisions. Change one only when there is a concrete blocker, and record the decision in `docs/decisions.md`.

| Area | Default |
| --- | --- |
| Language | TypeScript with strict mode |
| Runtime | Current active Node.js LTS at project initialization |
| Package management | `pnpm` workspaces |
| MCP SDK | Official `@modelcontextprotocol/sdk` |
| Runtime validation | Zod |
| Database | SQLite using `better-sqlite3` |
| Tests | Vitest |
| Logging | Pino or equivalent structured logger; `stderr` only in stdio mode |
| Audio metadata | `music-metadata` plus `ffprobe` where required |
| Audio processing | Locally installed FFmpeg/ffprobe invoked with argument arrays, never shell-interpolated strings |
| Audio analysis | Adapter interface; TypeScript/FFmpeg initially, isolated Python worker only if Stage 4 requires it |
| Configuration | Environment variables plus a validated local config file |
| IDs | UUIDs persisted in SQLite; never use raw paths as public IDs |
| Date/time storage | ISO 8601 UTC |

Do not pin versions in this specification. At repository creation, select current stable releases, commit the lockfile, and document runtime prerequisites.

### 3.1 Suggested repository structure

```text
dnb-crate-mcp/
  apps/
    mcp-server/
      src/
      test/
    cli/
      src/
      test/
  packages/
    domain/
      src/
      test/
    catalog/
      src/
      migrations/
      test/
    audio-analysis/
      src/
      test/
    audio-renderer/
      src/
      test/
  fixtures/
    catalog/
    audio/
  docs/
    decisions.md
    progress.md
    manual-test-log.md
    tool-contracts.md
  output/                 # gitignored
  pnpm-workspace.yaml
  package.json
  tsconfig.base.json
  README.md
```

Avoid speculative packages. Create a workspace/package only when its stage begins, except for `domain`, `catalog`, `mcp-server`, and `cli`, which belong in Stage 1.

### 3.2 Core operating modes

1. **CLI mode:** deterministic administration, ingestion, validation, and debugging without an MCP host.
2. **MCP stdio mode:** local agent integration. Standard output is reserved exclusively for MCP protocol messages.
3. **Test mode:** isolated temporary database and fixture directory.
4. **Optional remote mode:** Streamable HTTP, considered only in Stage 5 after local security and behavior are stable.

---

## 4. Core domain model

The exact database schema may evolve through migrations, but public types and concepts should remain stable.

### 4.1 Track

```ts
type Track = {
  id: string;
  filePath: string;              // Internal only; never returned by default.
  fileFingerprint: string;
  artist: string | null;
  title: string;
  album: string | null;
  durationMs: number;
  sampleRateHz: number | null;
  channels: number | null;
  bpm: number | null;
  bpmSource: "tag" | "manual" | "analyzed" | null;
  musicalKey: string | null;     // Canonical key, e.g. F#m.
  camelotKey: string | null;     // e.g. 11A.
  keySource: "tag" | "manual" | "analyzed" | null;
  energy: number | null;         // Integer 1–10.
  rating: number | null;         // Integer 1–5.
  subgenres: string[];
  moods: string[];
  tags: string[];
  notes: string | null;
  analysisStatus: "not_analyzed" | "pending" | "complete" | "failed";
  createdAt: string;
  updatedAt: string;
};
```

### 4.2 Cue point

```ts
type CuePoint = {
  id: string;
  trackId: string;
  type:
    | "intro_start"
    | "intro_end"
    | "drop"
    | "breakdown"
    | "outro_start"
    | "outro_end"
    | "custom";
  positionMs: number;
  beatIndex: number | null;
  barIndex: number | null;
  confidence: number | null;     // 0–1 for analyzed points.
  source: "manual" | "analyzed" | "imported";
  label: string | null;
};
```

### 4.3 Track analysis

```ts
type TrackAnalysis = {
  trackId: string;
  analyzerVersion: string;
  bpm: number | null;
  bpmConfidence: number | null;
  beatTimesMs: number[];
  downbeatTimesMs: number[];
  integratedLufs: number | null;
  truePeakDb: number | null;
  key: string | null;
  keyConfidence: number | null;
  lowBandEnergy: number | null;
  midBandEnergy: number | null;
  highBandEnergy: number | null;
  waveformSummary: number[] | null;
  analyzedAt: string;
};
```

### 4.4 Set plan

The set plan is a versioned, portable JSON document. Never make renderer behavior depend on undocumented fields.

```ts
type SetPlanV1 = {
  schemaVersion: 1;
  id: string;
  name: string;
  targetDurationMs: number;
  targetBpm: number | null;
  requestedArc: Array<{
    atFraction: number;           // 0–1 through the set.
    targetEnergy: number;         // 1–10.
  }>;
  entries: SetPlanEntry[];
  createdAt: string;
  updatedAt: string;
};

type SetPlanEntry = {
  id: string;
  trackId: string;
  order: number;
  sourceStartMs: number;
  sourceEndMs: number;
  timelineStartMs: number;
  playbackRate: number;          // 1.0 until tempo matching exists.
  gainDb: number;
  transitionToNext: TransitionPlan | null;
};

type TransitionPlan = {
  id: string;
  type: "crossfade" | "phrase_mix" | "bass_swap" | "double_drop";
  durationMs: number;
  outgoingCuePointId: string | null;
  incomingCuePointId: string | null;
  parameters: Record<string, number | string | boolean>;
};
```

### 4.5 Render job

```ts
type RenderJob = {
  id: string;
  setPlanId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;               // 0–1.
  outputPath: string | null;      // Internal by default.
  outputFormat: "wav" | "mp3";
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};
```

---

## 5. MCP design requirements

### 5.1 General tool rules

Every tool must have:

- A narrow, goal-oriented name.
- A description that says when to use it and when not to use it.
- Strict input validation.
- Bounded result sizes with pagination or limits.
- Stable machine-readable structured output.
- A short text fallback suitable for clients that do not render structured output.
- Typed domain errors with actionable messages.
- No arbitrary path, SQL, command, or FFmpeg argument parameters.

### 5.2 Tool response envelope

Use a consistent application-level envelope inside MCP structured content:

```ts
type ToolResult<T> =
  | {
      ok: true;
      data: T;
      warnings: string[];
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown>;
      };
    };
```

Expected error codes include:

- `TRACK_NOT_FOUND`
- `SET_PLAN_NOT_FOUND`
- `INVALID_SET_PLAN`
- `MISSING_METADATA`
- `MISSING_CUE_POINTS`
- `AUDIO_FILE_UNAVAILABLE`
- `FFMPEG_UNAVAILABLE`
- `ANALYSIS_FAILED`
- `RENDER_FAILED`
- `PATH_OUTSIDE_LIBRARY_ROOT`
- `RESULT_LIMIT_EXCEEDED`

### 5.3 Resource URI conventions

Introduce resources gradually:

```text
dnbcrate://tracks/{trackId}
dnbcrate://tracks/{trackId}/analysis
dnbcrate://set-plans/{setPlanId}
dnbcrate://renders/{renderJobId}/manifest
```

Resources return metadata, plans, and manifests—not raw full-length copyrighted audio. Transition previews remain controlled tool outputs or local artifact references.

### 5.4 Long-running work

Audio analysis and full rendering must use jobs:

1. A start tool validates the request and creates a job.
2. It returns immediately with a job ID.
3. A status tool returns progress and terminal state.
4. A cancellation tool may be added once cancellation is implemented safely.

Do not hold an MCP request open for a one-hour render.

### 5.5 Security requirements

- Resolve all files beneath an allow-listed library root.
- Resolve symlinks before checking containment.
- Store paths internally and expose track IDs to tools.
- Spawn processes using executable plus argument arrays.
- Do not pass model-provided strings through a shell.
- Do not expose environment variables, tokens, or unrestricted logs.
- Redact source paths from normal MCP responses.
- Require an explicit output directory outside the source library.
- Treat imported metadata and filenames as untrusted text.
- Keep mutation tools separate from read tools and make their effects explicit.

---

# Stage 1 — MCP foundation and searchable local catalog

## Goal

Create a working local MCP server that scans a configured music folder into SQLite and lets an MCP host discover and query the catalog. This stage teaches MCP initialization, capability/tool discovery, schemas, tool invocation, structured results, error handling, and stdio transport.

## User-visible milestone

The user can connect the server to an MCP client and ask:

> Find my Technimatic tracks.

> Show me five highly rated liquid tracks between 172 and 176 BPM.

> What metadata is missing from The Nightfall?

No audio is rendered in this stage.

## Stage 1 tool inventory

| Tool | Purpose |
| --- | --- |
| `get_server_status` | Confirm server, database, configured roots, and dependency health without exposing secrets. |
| `scan_library` | Discover supported audio files and upsert metadata into the catalog. |
| `search_tracks` | Search and filter tracks with bounded pagination. |
| `get_track` | Return canonical metadata for one track ID. |
| `update_track_metadata` | Add or correct personal metadata such as energy, rating, moods, subgenres, tags, and notes. |
| `get_library_stats` | Return counts, formats, duration, and missing-metadata statistics. |

### `search_tracks` minimum filters

- Free-text query across artist, title, album, tags, and notes.
- Artist.
- BPM minimum/maximum.
- Musical key or Camelot key.
- Energy minimum/maximum.
- Minimum rating.
- Any/all subgenres.
- Any/all moods.
- Any/all tags.
- Analysis status.
- Sort and ascending/descending direction.
- `limit` capped at 50 and opaque pagination cursor.

## Intermediate implementation steps

### Step 1.1 — Bootstrap and guardrails

- Initialize the pnpm workspace and strict TypeScript configuration.
- Add formatting, linting, type-checking, and Vitest.
- Create `README.md`, `.env.example`, `docs/decisions.md`, and `docs/progress.md`.
- Add a startup configuration schema for database path, library roots, output root, log level, and supported extensions.
- Ensure output, database, local configuration, and private media are gitignored.
- Add fixture audio generated specifically for tests; never commit copyrighted music.

### Step 1.2 — Catalog database

- Implement migration execution on startup/CLI command.
- Add tables for tracks, moods, subgenres, tags, and track relationships.
- Enforce unique canonical file path and stable UUID.
- Create a repository interface independent of MCP.
- Implement deterministic pagination and filtering.
- Add temporary-database tests for all repository queries.

### Step 1.3 — Safe library scanner

- Walk allow-listed roots only.
- Support a small initial extension set: `.wav`, `.flac`, `.mp3`, `.m4a`, and `.aiff` if metadata parsing is reliable.
- Extract embedded artist, title, album, duration, sample rate, channel count, BPM, and key when present.
- Normalize blank tags to `null`.
- Calculate a stable fingerprint using file size, modification time, and a bounded content hash strategy; document collision tradeoffs.
- Upsert moved/changed metadata without creating duplicate records unnecessarily.
- Mark missing files; do not delete their records automatically.
- Provide a dry-run CLI scan and tests for traversal, symlinks, unsupported files, and malformed media.

### Step 1.4 — Domain services and CLI

- Implement catalog service methods used by both CLI and MCP handlers.
- Add CLI commands: `db:migrate`, `library:scan`, `library:stats`, and `track:search`.
- Verify services return domain types and never MCP-specific objects.
- Add stable error types and map repository failures to domain errors.

### Step 1.5 — MCP stdio server

- Create the server using the official TypeScript MCP SDK.
- Register the six Stage 1 tools with strict input schemas.
- Keep stdout protocol-clean; all diagnostic logs go to stderr.
- Return structured content plus concise text fallback.
- Add one resource template: `dnbcrate://tracks/{trackId}`.
- Test handler logic without spawning a process.
- Add at least one process-level protocol test that launches the stdio server.

### Step 1.6 — Client integration and manual verification

- Test initialization, `tools/list`, each tool call, resource listing, and resource reading with MCP Inspector.
- Add documented configuration examples for Cursor and Codex without hardcoding user-specific paths.
- Run at least five natural-language queries through an MCP host.
- Record actual tool calls and outcomes in `docs/manual-test-log.md`.

## Stage 1 checklist

### Build

- [ ] Workspace installs from a clean checkout.
- [ ] TypeScript strict mode is enabled.
- [ ] Configuration is validated with useful startup errors.
- [ ] Database migrations are repeatable and transactional.
- [ ] Scanner ingests supported fixture files.
- [ ] Scanner cannot escape configured library roots.
- [ ] Search supports all specified filters and bounded pagination.
- [ ] Metadata updates validate ranges and allowed fields.
- [ ] MCP server exposes exactly the documented Stage 1 capabilities.
- [ ] Stdout contains no non-protocol logs.

### Tests and quality

- [ ] Unit tests cover filter semantics and metadata normalization.
- [ ] Integration tests use a temporary SQLite database.
- [ ] Path-containment and symlink tests pass.
- [ ] Malformed and missing audio files produce typed errors/warnings.
- [ ] Lint, format check, type-check, and all tests pass.
- [ ] MCP Inspector can list and call every tool.

### Documentation

- [ ] README includes prerequisites, setup, scan, server start, and MCP client configuration.
- [ ] `docs/tool-contracts.md` records exact inputs and outputs.
- [ ] Decisions and known limitations are documented.
- [ ] No local music, database, output audio, secrets, or absolute personal paths are committed.

## Stage 1 acceptance gate

Stage 1 is complete only when a clean MCP client session can discover the server, scan a fixture library, query it through natural language, read a track resource, and receive valid structured results. Stop and request review before Stage 2.

---

# Stage 2 — One-hour set planning without audio rendering

## Goal

Turn natural-language intent into a validated, persistent one-hour set plan. The output is an ordered plan—not yet an audio mix. This stage teaches richer tool composition, resources, prompts, deterministic scoring, mutations, and iterative validation.

## User-visible milestone

The user can ask:

> Build a one-hour liquid set that starts at energy 3, peaks at 9 around 45 minutes, then ends at 6. Favor emotional and deep tracks, avoid repeating artists back-to-back, and finish with The Nightfall.

The agent can create a plan, inspect validation problems, revise it, and save it.

## Stage 2 tool inventory

| Tool | Purpose |
| --- | --- |
| `find_compatible_tracks` | Rank candidates against a source track and requested direction. |
| `create_set_plan` | Generate a deterministic draft from structured constraints. |
| `get_set_plan` | Retrieve a saved plan. |
| `validate_set_plan` | Return errors, warnings, timing, energy, key, and diversity diagnostics. |
| `update_set_plan` | Apply explicit validated edits to entries or transitions. |
| `list_set_plans` | List saved plans with bounded pagination. |
| `delete_set_plan` | Optional; add only with explicit confirmation semantics in metadata/description. |

## Planning inputs

At minimum, `create_set_plan` accepts:

- Target duration.
- Optional target BPM or BPM range.
- Energy curve control points.
- Required track IDs.
- Excluded track IDs/artists.
- Preferred moods, subgenres, tags, and artists.
- Minimum rating.
- Artist-repeat spacing.
- Harmonic compatibility importance.
- Exploration versus familiarity weight.
- Optional start and ending tracks.
- Random seed for reproducibility.

## Deterministic planning model

Implement a transparent weighted score. Keep weights configurable and return score components for inspection.

```text
candidate score =
    mood match
  + subgenre match
  + target-energy proximity
  + BPM compatibility
  + harmonic compatibility
  + personal rating
  + preferred-artist bonus
  + novelty/exploration term
  - repeated-artist penalty
  - recently-used penalty
  - missing-metadata penalty
```

Do not use opaque embeddings yet. Free-text intent must be translated by the host model into explicit structured constraints.

## Intermediate implementation steps

### Step 2.1 — Complete planning metadata

- Add track metadata and cue-point editing through CLI and MCP.
- Normalize musical keys and convert between canonical and Camelot notation.
- Add manual BPM, key, energy, and cue-point provenance.
- Create a “planning readiness” report for tracks.
- Seed at least 20–30 private local tracks for manual testing; keep this database outside git.

### Step 2.2 — Compatibility services

- Implement BPM-distance scoring.
- Implement configurable Camelot compatibility scoring.
- Implement energy-direction scoring.
- Implement mood/subgenre/tag overlap scoring.
- Return human-readable reason codes alongside numeric components.
- Unit-test boundary cases, missing fields, enharmonic key normalization, and deterministic tie-breaking.

### Step 2.3 — Set duration and energy model

- Calculate timeline duration using source durations and assumed overlaps.
- Interpolate the requested energy curve at every entry.
- Prevent impossible trims and negative timeline positions.
- Require a configurable minimum playable duration per track.
- Define default Stage 2 transition overlap (for timing only), such as 30 seconds.
- Keep all timing fields in integer milliseconds.

### Step 2.4 — Draft planning algorithm

- Generate candidate pools for each position.
- Select tracks incrementally with bounded backtracking.
- Honor hard constraints before optimizing soft preferences.
- Support a seed so identical input and catalog state produce identical output.
- Return an explanation object with selected/rejected candidate reasons.
- Handle insufficient-library cases by returning partial plans plus actionable warnings.

### Step 2.5 — Persistence and validation

- Add set-plan and set-entry migrations.
- Persist schema version with each plan.
- Implement validation errors separately from warnings.
- Validate track existence, source timing, target duration, duplicates, BPM jumps, key clashes, energy arc deviation, artist repetition, and metadata readiness.
- Store the exact generated plan, not just generation parameters.

### Step 2.6 — MCP composition features

- Register Stage 2 tools.
- Add resource templates for `dnbcrate://set-plans/{setPlanId}`.
- Add an optional discoverable prompt named `build-dnb-set` if supported by target clients.
- Keep the workflow fully usable through tools when prompt discovery is unsupported.
- Ensure list-change behavior is correct if capabilities can change during a server session.

### Step 2.7 — Evaluation

- Create a synthetic test catalog with known best sequences.
- Add golden tests for deterministic plans.
- Run at least ten varied natural-language planning prompts through the MCP host.
- Record whether the model selected appropriate tools and supplied valid arguments.
- Tune tool descriptions before changing the planning algorithm when tool selection is the problem.

## Stage 2 checklist

### Build

- [ ] Manual metadata and cue points can be added safely.
- [ ] Key normalization and Camelot conversion are tested.
- [ ] Compatibility scoring is deterministic and explainable.
- [ ] Planner honors hard constraints.
- [ ] Planner targets requested duration within the configured tolerance.
- [ ] Energy curve is measurable and included in validation output.
- [ ] Plans are versioned and persistent.
- [ ] Agent can create, inspect, revise, validate, and save a plan using tools.

### Tests and evaluation

- [ ] Golden plan tests pass with fixed seeds.
- [ ] Validation catches every documented invalid condition.
- [ ] Partial-plan behavior is tested for small or poorly tagged libraries.
- [ ] Ten natural-language scenarios have been manually evaluated.
- [ ] No plan silently invents metadata or cue points.
- [ ] All Stage 1 regression tests still pass.

### Documentation

- [ ] Scoring components and default weights are documented.
- [ ] Set plan JSON schema is documented and exported.
- [ ] Example one-hour plan is included using fictional/fixture tracks.
- [ ] Known planning limitations are explicit.

## Stage 2 acceptance gate

Stage 2 is complete when the MCP host can turn a natural-language request into a persistent, valid, approximately one-hour set plan; explain why tracks were selected; revise the plan after validation feedback; and reproduce it from the same seed. Stop and request review before Stage 3.

---

# Stage 3 — Continuous audio rendering with reliable fixed crossfades

## Goal

Render a set plan into a continuous audio file with safe trimming, loudness management, fixed crossfades, progress reporting, and transition previews. The result should be pleasant and gapless, but is not yet promised to be beat- or phrase-matched.

## User-visible milestone

The user can ask:

> Render this plan as a WAV and give me 30-second previews of transitions 3 and 7 first.

The server creates preview files, then asynchronously renders a complete mix.

## Stage 3 tool inventory

| Tool | Purpose |
| --- | --- |
| `create_transition_preview` | Queue a short preview around one planned transition. |
| `start_set_render` | Validate and queue a full render job. |
| `get_render_status` | Return progress, warnings, and terminal result. |
| `list_render_jobs` | Show recent jobs. |
| `cancel_render_job` | Add only after safe process cancellation is implemented. |
| `get_render_manifest` | Return exact tracks, trims, gains, transitions, checksums, and output characteristics. |

## Rendering policy

- WAV is the canonical first output.
- Render internally to a consistent sample rate and channel layout.
- Do not modify originals.
- Prevent clipping and record loudness metrics.
- Use a versioned render manifest.
- A render must be reproducible from its plan, catalog snapshot/fingerprints, renderer version, and configuration.

## Intermediate implementation steps

### Step 3.1 — FFmpeg dependency adapter

- Detect FFmpeg and ffprobe at startup or through a health check.
- Validate supported versions/capabilities without depending on localized console output.
- Invoke executables with argument arrays.
- Capture bounded stderr for diagnostics.
- Map process failures and signals to stable domain errors.
- Add fake-process tests and a real FFmpeg integration-test lane.

### Step 3.2 — Audio probing and render readiness

- Probe each source file before rendering.
- Validate duration, stream type, channel count, sample rate, and readability.
- Reject plans referencing changed fingerprints until revalidated.
- Add render-readiness output to `validate_set_plan`.
- Detect insufficient source duration around planned trims.

### Step 3.3 — Single transition renderer

- Implement a fixed equal-power crossfade template.
- Trim source segments precisely.
- Normalize input format before combining streams.
- Add configurable crossfade duration within safe bounds.
- Produce a manifest describing actual, not merely requested, timings.
- Create deterministic fixture tests using generated tones and click tracks.

### Step 3.4 — Preview workflow

- Render a bounded window around a selected transition.
- Default to approximately 30–60 seconds.
- Store previews under the configured output directory.
- Return job/artifact metadata without exposing unrestricted paths.
- Make repeated identical preview requests cacheable by content hash.

### Step 3.5 — Full-set renderer

- Convert the set plan to an FFmpeg filter graph or a sequence of lossless intermediate renders.
- Prefer one-pass composition when reliable; otherwise document intermediate-file cleanup.
- Apply per-track gain and crossfades.
- Emit progress events into the render-job repository.
- Write atomically to a temporary output and rename only after success.
- Generate a render manifest and output checksum.
- Clean up failed temporary artifacts safely.

### Step 3.6 — Loudness and output validation

- Measure integrated LUFS and true peak before final acceptance.
- Use a documented loudness target and ceiling; make them configurable.
- Avoid blind normalization that destroys intentional energy differences between tracks.
- Probe the completed output and verify duration, streams, readability, and absence of unexpected silence.
- Add a short fade at the absolute beginning/end only when requested by render policy.

### Step 3.7 — Job lifecycle and MCP exposure

- Add persistent render-job states and progress.
- Recover jobs left `running` after server restart by marking them interrupted/failed with a retryable status.
- Register Stage 3 tools and render-manifest resource.
- Prevent concurrent jobs from exhausting the machine through a configurable worker limit.
- Ensure MCP calls return promptly after queueing.

## Stage 3 checklist

### Build

- [ ] FFmpeg/ffprobe availability is reported clearly.
- [ ] Source-file changes invalidate stale plans safely.
- [ ] Preview rendering works for any valid adjacent pair.
- [ ] Full rendering runs through a persistent job.
- [ ] Output creation is atomic.
- [ ] Source files remain byte-identical.
- [ ] Render manifest describes every track and transition.
- [ ] WAV output is gapless and readable.
- [ ] Completed output duration matches the plan within one second or a documented tolerance.

### Tests and listening QA

- [ ] Generated-tone tests verify crossfade timing and channel format.
- [ ] Failure tests cover missing FFmpeg, corrupt audio, disk errors, and process interruption.
- [ ] No output exceeds the configured true-peak ceiling.
- [ ] A 20-minute private test mix renders successfully.
- [ ] A one-hour private test mix renders successfully.
- [ ] Every transition in one test set has been listened to and logged.
- [ ] All prior-stage regression tests pass.

### Documentation

- [ ] FFmpeg installation instructions cover Windows and the primary development environment.
- [ ] Loudness policy is documented.
- [ ] Render job lifecycle is documented.
- [ ] Known limitation states clearly that Stage 3 is not beat-matched.

## Stage 3 acceptance gate

Stage 3 is complete when the agent can queue previews and a full approximately one-hour WAV render, poll its status, receive a manifest, and play a gapless result whose files, duration, peaks, and source integrity all validate. Stop and request review before Stage 4.

---

# Stage 4 — Beat-matched, phrase-aligned DJ transitions

## Goal

Upgrade from generic crossfades to actual DnB-aware mixing: BPM normalization, beat-grid alignment, 4/4 bar structure, 16/32-bar phrase alignment, cue-aware entry/exit, and EQ-based bass swaps.

## User-visible milestone

The user can ask:

> Rebuild this set using 32-bar phrase mixes. Keep tempo near 174 BPM and use bass swaps on the higher-energy transitions.

The rendered set should sound intentionally mixed rather than merely crossfaded.

## Stage 4 tool changes

| Tool | Purpose |
| --- | --- |
| `start_track_analysis` | Queue analysis for selected tracks or the planning-ready subset. |
| `get_analysis_status` | Report analysis jobs and confidence. |
| `get_track_analysis` | Return beat grid, loudness, key, bands, cue points, and provenance. |
| `set_cue_points` | Manually correct cue points/beat anchors. |
| `plan_transition` | Produce a concrete phrase-aligned transition proposal. |
| `validate_transition` | Check timing, grids, key, cue points, headroom, and feasibility. |
| `create_transition_preview` | Extended with `phrase_mix` and `bass_swap` templates. |

## Analysis principle

Automatic analysis is advisory. Every analyzed BPM, key, downbeat, phrase, and cue point has confidence and provenance. Low-confidence values must not be treated as facts. Manual correction must always be possible.

## DnB assumptions for the first aligned renderer

- 4/4 meter only.
- Normalize plausible tempo to a configurable DnB range, initially 160–190 BPM, to handle half/double-time estimates.
- Transitions use multiples of 4 bars; initial templates use 16 or 32 bars.
- Tempo changes remain small and bounded, initially no more than approximately ±3% unless explicitly allowed.
- The renderer aligns annotated/analyzed cue points to downbeats.

## Intermediate implementation steps

### Step 4.1 — Audio-analysis abstraction and spike

- Define an `AudioAnalyzer` interface before selecting deeper dependencies.
- Build a fixture benchmark containing generated click tracks and a small private evaluation set.
- Evaluate candidate analysis libraries for Windows support, maintenance, licensing, deterministic output, BPM accuracy, beat timing, and key estimation.
- Keep any Python component behind a versioned JSON stdin/stdout worker contract.
- Record the chosen implementation and rejected alternatives in `docs/decisions.md`.

### Step 4.2 — BPM and beat grids

- Analyze BPM and beat timestamps.
- Normalize half-time/double-time DnB results.
- Store confidence, analyzer name, and version.
- Allow one manual beat/downbeat anchor to shift or reconstruct a grid.
- Reject implausible grids rather than silently using them.
- Add click-track tests at several DnB tempos and deliberate offsets.

### Step 4.3 — Key, loudness, and spectral bands

- Estimate musical key and confidence.
- Measure integrated loudness and true peak.
- Measure low/mid/high band energy over transition-relevant windows.
- Store analysis separately from manual canonical metadata.
- Define precedence: manual values override analyzed values while preserving both.

### Step 4.4 — Cue points and phrase model

- Detect candidate intro, drop, breakdown, and outro regions when feasible.
- Snap suggested cue points to the nearest validated downbeat.
- Infer bar indices from the selected anchor.
- Suggest 16/32-bar mixing windows.
- Provide CLI/MCP correction for cue type, timestamp, beat, bar, and confidence.
- Block aligned rendering when required cue points are absent or low-confidence unless explicitly overridden.

### Step 4.5 — Tempo matching

- Calculate target playback rate from source and set BPM.
- Apply pitch-preserving time stretching through a documented FFmpeg-supported method or isolated adapter.
- Bound playback rate and reject excessive adjustments.
- Verify output duration mathematically and by probing.
- Add tone tests that detect unintended pitch shifts beyond tolerance.

### Step 4.6 — Phrase-mix template

- Align incoming intro/downbeat with the outgoing transition window.
- Support 16- and 32-bar durations.
- Fade incoming mids/highs according to a documented curve.
- Maintain headroom during overlap.
- End or reduce outgoing content at the planned phrase boundary.
- Store every automation event in the render manifest.

### Step 4.7 — Bass-swap template

- High-pass or attenuate the incoming low band during the early overlap.
- At a selected bar boundary, attenuate outgoing lows while restoring incoming lows.
- Use short smoothing ramps to avoid clicks.
- Make EQ frequencies, gain, and ramp lengths bounded template parameters—not arbitrary model-controlled FFmpeg expressions.
- Validate overlapping low-band energy and headroom.

### Step 4.8 — Transition planning and preview loop

- Rank feasible templates for a track pair.
- Return exact cue points, bar counts, playback rates, and compatibility reasons.
- Generate previews of alternatives using content-addressed cache keys.
- Allow the model/user to replace a transition in the set plan with an accepted proposal.
- Revalidate the entire set timeline after every accepted change.

### Step 4.9 — Objective and listening evaluation

- Check beat-grid alignment against fixture truth.
- Measure onset offset at joins where measurable.
- Check sample peaks and low-band overlap.
- Blind-compare fixed crossfade versus phrase mix for a private transition set.
- Record subjective ratings for timing, phrasing, bass clash, harmonic fit, and energy continuity.

## Stage 4 checklist

### Build

- [ ] Analyzer is isolated behind a stable interface.
- [ ] Analysis records provenance, version, and confidence.
- [ ] Half/double-time BPM cases are handled.
- [ ] Manual values override analysis without destroying it.
- [ ] Cue points can be corrected manually.
- [ ] Playback-rate limits are enforced.
- [ ] Phrase-mix template aligns configured bar counts.
- [ ] Bass-swap template avoids simultaneous full-strength sub-bass.
- [ ] Render manifest records beat grids, cue points, rates, and automation.

### Tests and listening QA

- [ ] Click-track beat-grid fixtures pass documented accuracy thresholds.
- [ ] Tempo-adjusted tone fixtures retain pitch within documented tolerance.
- [ ] Invalid/low-confidence grids cannot silently enter an aligned render.
- [ ] Ten private phrase-mix previews have been reviewed.
- [ ] Ten private bass-swap previews have been reviewed.
- [ ] At least one 20-minute aligned DnB mix passes full listening QA.
- [ ] At least one one-hour aligned mix renders successfully.
- [ ] Prior-stage regression tests pass.

### Documentation

- [ ] Analysis dependency decision and license are documented.
- [ ] Manual beat-grid and cue correction workflow is documented.
- [ ] Transition templates and parameters are documented.
- [ ] Confidence/override policy is documented.

## Stage 4 acceptance gate

Stage 4 is complete when a set can be rendered near a target BPM with validated beat grids, 16/32-bar phrase alignment, and bounded bass-swap automation; low-confidence analysis is surfaced rather than hidden; and listening tests show a clear improvement over Stage 3 crossfades. Stop and request review before Stage 5.

---

# Stage 5 — Double drops, feedback-driven creativity, and production hardening

## Goal

Add controlled creative mixing—especially double drops—while learning from explicit user feedback. Package the system as a dependable reusable MCP server and evaluate optional Streamable HTTP transport only after the local product works well.

## User-visible milestone

The user can ask:

> Create a one-hour soulful liquid set that becomes darker after 30 minutes, uses two compatible doubles between minutes 38 and 50, peaks at energy 9, and finishes with The Nightfall. Prefer transition styles I have rated highly before.

The agent proposes doubles, renders previews, incorporates approval/rejection, and produces the complete set.

## Stage 5 tool inventory

| Tool | Purpose |
| --- | --- |
| `find_double_candidates` | Rank possible secondary tracks for a selected primary drop. |
| `plan_double_drop` | Produce a bounded, explicit double-drop plan. |
| `validate_double_drop` | Check grid, drop, harmonic, rhythmic, spectral, vocal, and headroom risks. |
| `rate_transition` | Store structured user feedback on a rendered transition. |
| `get_transition_preferences` | Summarize ratings and preference signals without claiming unsupported learning. |
| `recommend_transition_style` | Rank templates using deterministic features plus stored ratings. |
| `duplicate_set_plan` | Fork a plan safely for experimentation. |

## Double-drop safety model

A double must never be generated by merely playing two full-strength drops together. The plan must explicitly select:

- Primary and secondary track.
- Primary and secondary drop cue points.
- Alignment offset.
- Duration in bars.
- Playback rates.
- Per-track gain.
- Low/mid/high-band ownership or attenuation.
- Optional vocal-risk flag.
- Entry and exit behavior.

The first implementation should generally designate one track as low-band owner and attenuate the other track's lows.

## Intermediate implementation steps

### Step 5.1 — Double candidate features

- Require validated grids and drop cue points.
- Score BPM/playback-rate compatibility.
- Score harmonic compatibility.
- Compare drop-window band energy.
- Estimate rhythmic density and onset conflict.
- Add a manual vocal-presence flag before attempting automated vocal detection.
- Penalize two vocal-heavy drops and two full low-band drops.
- Return score components and risk reasons.

### Step 5.2 — Double-drop template

- Align both selected drop downbeats sample-accurately relative to their grids.
- Assign low-band ownership.
- Apply bounded per-band attenuation and gain staging.
- Support an initial 16- or 32-bar double duration.
- Provide safe entry and exit templates.
- Prevent clipping and excessive loudness.
- Record all automation and source windows in the manifest.

### Step 5.3 — Preview-first workflow

- Require a successful preview before a double is accepted into a full set render.
- Generate at least two bounded mix variants when requested.
- Cache variants by plan/content hash.
- Let the agent replace, adjust, approve, or reject a proposed double.
- Keep approval state on the plan entry; do not infer approval from preview creation.

### Step 5.4 — Structured feedback

- Add transition ratings for overall quality, timing, phrasing, harmonic fit, bass clarity, energy flow, and vocal clash.
- Accept optional free-text notes as untrusted text.
- Associate feedback with the exact render/transition manifest and renderer version.
- Never overwrite old feedback when a transition changes; create a new evaluated version.
- Expose aggregate preference summaries with sample counts.

### Step 5.5 — Preference-aware recommendation

- Start with deterministic weighted adjustments based on explicit ratings.
- Require minimum sample counts before applying preference bonuses.
- Show which preference signals changed a recommendation.
- Avoid claiming that the system “learned” a preference when evidence is sparse.
- Add an export/import format for feedback records.

### Step 5.6 — Complete creative set workflow

- Extend set constraints with requested double count and preferred time window.
- Ensure double placement respects the target energy curve and total duration.
- Add preflight validation that every double has an accepted preview.
- Generate an end-to-end one-hour creative mix.
- Produce a human-readable set report with tracklist, timestamps, transition types, doubles, and warnings.

### Step 5.7 — MCP production hardening

- Audit every tool description, schema, result bound, mutation, and error.
- Add request IDs and bounded structured logging.
- Add database backup/export and migration tests.
- Add graceful shutdown for workers and queued jobs.
- Add concurrency, disk-space, and maximum-render-duration limits.
- Add a diagnostic bundle that excludes audio, secrets, and private paths.
- Verify behavior with at least two MCP hosts where practical.

### Step 5.8 — Optional Streamable HTTP transport

- Keep stdio as the primary local transport.
- Add Streamable HTTP only if there is a concrete remote/custom-app use case.
- Reuse the same application services and tool contracts.
- Bind locally by default.
- If exposed beyond localhost, implement the current MCP authorization requirements, TLS, origin validation, user scoping, and explicit deployment documentation.
- Do not expose private audio or unrestricted local filesystem access remotely.

### Step 5.9 — Optional future investigations, not acceptance blockers

- Embedding-based semantic descriptions such as “melancholic but hopeful.”
- Section-level audio embeddings.
- Stem separation for cleaner doubles.
- Ableton export.
- A desktop/web playback and plan-editing UI.
- Integration with Guess the Bass using metadata or lawfully licensed audio only.
- Live playback after offline rendering is mature.

## Stage 5 checklist

### Build

- [ ] Double candidates require validated drop grids.
- [ ] Candidate scores expose compatibility and risk components.
- [ ] Double renderer assigns low-band ownership.
- [ ] Full set render requires accepted double previews.
- [ ] Feedback is tied to immutable transition/render versions.
- [ ] Preference adjustments are deterministic and explainable.
- [ ] One-hour plans can constrain double count and placement.
- [ ] Set report includes timestamped tracklist and transition types.

### Tests and listening QA

- [ ] Synthetic alignment and headroom tests pass.
- [ ] Unsafe/incompatible double plans are rejected with actionable reasons.
- [ ] At least 20 double previews across varied pairs are manually reviewed.
- [ ] Accepted and rejected examples both exist in the feedback store.
- [ ] Preference-aware ranking is tested with controlled feedback fixtures.
- [ ] At least one complete one-hour set with two accepted doubles passes listening QA.
- [ ] Database migration, backup, restart, and interrupted-job scenarios pass.
- [ ] All previous-stage regression tests pass.

### Security and release readiness

- [ ] No tool accepts arbitrary commands, SQL, FFmpeg filters, or unrestricted paths.
- [ ] Source library remains read-only.
- [ ] Logs and diagnostic bundles redact private paths and content.
- [ ] Concurrency and disk usage are bounded.
- [ ] README contains a complete local setup and troubleshooting flow.
- [ ] MCP client examples are current and manually verified.
- [ ] Streamable HTTP is omitted unless its full security checklist is complete.

## Stage 5 acceptance gate

Stage 5 is complete when the agent can propose, preview, validate, and incorporate two approved doubles into a coherent one-hour set; use explicit past feedback to influence transition recommendations transparently; render and verify the result; and operate reliably as a local reusable MCP server.

---

## 6. Cross-stage testing strategy

### 6.1 Test pyramid

1. **Pure unit tests:** scoring, time calculations, key conversion, validation, filter construction, plan transformations.
2. **Repository integration tests:** real temporary SQLite database and migrations.
3. **Audio adapter tests:** generated audio fixtures and real FFmpeg in an optional/required CI lane depending on stage.
4. **MCP protocol tests:** initialization, discovery, valid calls, invalid calls, and process lifecycle.
5. **Agent behavior evaluations:** natural-language prompts and observed tool selection.
6. **Listening QA:** recorded subjective evaluation using private tracks.

### 6.2 Generated audio fixtures

Programmatically generate and commit only small non-copyrighted fixtures:

- Sine tones for pitch and gain tests.
- Click tracks at 172, 174, and 176 BPM.
- Click tracks with known first-downbeat offsets.
- Low- and high-frequency signals for EQ tests.
- Short silent/corrupt/unsupported fixtures for failure handling.

### 6.3 Listening QA rubric

Rate each transition from 1–5 on:

- Timing/beat alignment.
- Phrase alignment.
- Harmonic compatibility.
- Bass clarity.
- Loudness continuity.
- Energy progression.
- Vocal conflict.
- Overall enjoyment.

Keep automated correctness and subjective quality separate. A technically valid transition may still sound bad.

---

## 7. Observability and reproducibility

Every plan and render should be explainable after the fact.

### 7.1 Required render manifest fields

- Manifest schema version.
- Application and renderer versions.
- Set plan ID and content hash.
- Track IDs and source fingerprints.
- Exact source/timeline windows.
- Playback rates.
- Gain and automation curves/templates.
- Analysis versions and relevant confidence values.
- FFmpeg version and normalized invocation description, with private paths redacted.
- Output sample rate, channels, duration, LUFS, true peak, and checksum.
- Warnings and approved overrides.

### 7.2 Determinism expectations

- Planning with the same catalog snapshot, constraints, weights, and seed should produce the same plan.
- Rendering the same plan with the same source fingerprints, renderer version, and dependencies should be functionally reproducible.
- If bit-identical output cannot be guaranteed across FFmpeg/platform versions, document the boundary.

---

## 8. Definition of done for every stage

A stage is not done merely because the happy path works. Before advancing:

- All stage checklist items are completed or explicitly documented as deferred with user approval.
- Lint, formatting, type-checking, unit tests, and integration tests pass.
- The stage's MCP tools have been exercised through an actual MCP client.
- Tool contracts and README are updated.
- Security checks relevant to the stage pass.
- Private/local artifacts are not committed.
- `docs/progress.md` describes what works, what does not, and the next gate.
- The implementation agent stops and requests review.

---

## 9. Instructions for the implementation agent

1. Read this entire specification before editing code.
2. If the repository is empty, initialize it according to Stage 1.
3. Implement **Stage 1 only** unless the user explicitly authorizes a later stage.
4. Do not build speculative Stage 2–5 components during Stage 1.
5. Preserve clear domain boundaries so later stages do not require rewriting MCP handlers.
6. Keep the MCP server thin: validate, call application services, map results.
7. Do not put business logic directly in tool registration callbacks.
8. Never process or commit the user's real music during automated tests.
9. Prefer small, reviewable changes and update `docs/progress.md` continuously.
10. When blocked by a material product or dependency decision, present concrete options and tradeoffs rather than silently choosing.
11. Before declaring a stage complete, run every checklist and show evidence for the acceptance gate.
12. Stop after the authorized stage and provide a concise handoff summary.

### Initial implementation-agent prompt

Copy this together with the path to this specification:

> Read `dnb-crate-mcp-implementation-spec.md` completely. Implement Stage 1 only. Treat its Stage 1 acceptance gate and checklists as binding. Start by inspecting the repository, then create a short execution plan. Use the specified defaults unless a concrete incompatibility exists; record deviations in `docs/decisions.md`. Keep source music read-only, never commit private media or local paths, keep stdout protocol-clean, and do not begin Stage 2. At completion, run all checks, test the server with an MCP client or Inspector, update `docs/progress.md`, and report acceptance evidence plus any remaining limitations.

---

## 10. References

- [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)
- [MCP prompts](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts)
- [MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
- [OpenAI Codex MCP documentation](https://developers.openai.com/codex/mcp)
- [OpenAI MCP server guide](https://developers.openai.com/plugins/build/mcp-server)

