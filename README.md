# DnB Crate MCP

Local-first catalog for a private drum & bass library. An MCP host (Cursor, Codex, MCP Inspector) talks to a stdio server; the same domain services are also available from a CLI. Stage 1 indexes local audio metadata. Stage 2 builds a deterministic ordered set plan. Stage 3–4 render a gapless WAV with equal-power crossfades plus optional beat-aligned phrase mixes and bass swaps.

The language model interprets requests. This application owns scanning, storage, search, and validation.

## Prerequisites

- Node.js 24+ (the version used at repo init was 24.16.0)
- [pnpm](https://pnpm.io/) 11+
- A folder of audio you own or may access (`.wav`, `.flac`, `.mp3`, `.m4a`, `.aiff`)
- FFmpeg **and** ffprobe on `PATH` for rendering (see `docs/rendering.md` and `docs/analysis.md`). Status tools report whether they are present.

## Setup

```bash
pnpm install
copy dnb-crate.config.example.json dnb-crate.config.json
```

Edit `dnb-crate.config.json` so `libraryRoots` points at your music folder and `outputRoot` points at a directory that is **not** inside that library. Both `dnb-crate.config.json` and `data/` are gitignored.

Alternatively, use environment variables (see `.env.example`).

## CLI

```bash
pnpm cli db:migrate
pnpm cli library:scan
pnpm cli library:scan --dry-run
pnpm cli library:stats
pnpm cli track:search --query "Technimatic" --limit 10
pnpm cli analysis:start --track-id UUID --wait
pnpm cli analysis:get --track-id UUID
pnpm cli transition:plan --from UUID --to UUID --bars 32
pnpm cli plan:create --name "Liquid hour" --duration-ms 3600000 --seed 1 --end-query "Nightfall"
pnpm cli plan:list
pnpm cli plan:get --id UUID
pnpm cli plan:validate --id UUID
pnpm cli render:start --plan-id UUID --wait
pnpm cli render:status --id UUID
pnpm cli render:manifest --id UUID
```

JSON is written to stdout. Diagnostics go to stderr.

## MCP server (stdio)

Stdout is reserved for JSON-RPC. Do not `console.log` in this process.

```bash
pnpm mcp
```

### Cursor

In your user MCP config (path varies by Cursor version), add a server without hardcoding someone else’s disk layout:

```json
{
  "mcpServers": {
    "dnb-crate": {
      "command": "npx",
      "args": ["tsx", "apps/mcp-server/src/main.ts"],
      "cwd": "PATH_TO_THIS_REPO",
      "env": {
        "DNB_CRATE_CONFIG": "PATH_TO_THIS_REPO/dnb-crate.config.json"
      }
    }
  }
}
```

Use `pnpm exec tsx` instead of `npx tsx` if you prefer the workspace binary.

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector pnpm mcp
```

Set the same `DNB_CRATE_*` environment variables in the Inspector session. Confirm `tools/list`, call `scan_library`, then `search_tracks`.

## Tools (Stage 1–4)

| Tool                        | When to use                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `get_server_status`         | Health: database, root count, ffmpeg/ffprobe presence. No secrets or absolute paths. |
| `scan_library`              | Re-index configured roots. Optional `dryRun`.                                        |
| `search_tracks`             | Filter the catalog. Max 50 results, cursor pagination.                               |
| `get_track`                 | One track UUID, including cue points.                                                |
| `update_track_metadata`     | Energy, rating, moods, subgenres, tags, notes, plus manual BPM/key.                  |
| `get_library_stats`         | Counts and missing-metadata summary.                                                 |
| `set_cue_points`            | Replace manual cue points; optional beat anchor.                                     |
| `start_track_analysis`      | Queue analysis for explicit UUIDs or the planning-ready subset.                      |
| `get_analysis_status`       | Poll analysis jobs.                                                                  |
| `get_track_analysis`        | Beat grid, confidence, canonical vs analyzed BPM/key.                                |
| `get_planning_readiness`    | Which tracks lack BPM/key/energy/file.                                               |
| `find_compatible_tracks`    | Rank candidates vs a source track (BPM/Camelot/energy/tags).                         |
| `create_set_plan`           | Deterministic draft from structured constraints. Persists the plan.                  |
| `get_set_plan`              | Load a saved plan.                                                                   |
| `validate_set_plan`         | Errors vs warnings plus energy/duration diagnostics.                                 |
| `update_set_plan`           | Explicit replace/trim/transition/rate/applyTransition/reorder edits.                 |
| `list_set_plans`            | Bounded list.                                                                        |
| `delete_set_plan`           | Requires `confirm: true`.                                                            |
| `plan_transition`           | Rank phrase-mix / bass-swap / crossfade proposals for a pair.                        |
| `validate_transition`       | Feasibility of a concrete template (grids, rates, cues).                             |
| `create_transition_preview` | Queue a 30–60s WAV preview; optional `phrase_mix` / `bass_swap` template.            |
| `start_set_render`          | Queue a full WAV render. Returns a job id immediately.                               |
| `get_render_status`         | Poll progress 0–1 and terminal state.                                                |
| `list_render_jobs`          | Bounded list of preview/full jobs.                                                   |
| `cancel_render_job`         | Requires `confirm: true`. Kills the FFmpeg process.                                  |
| `get_render_manifest`       | Fingerprints, trims, LUFS, true peak, checksum after success.                        |

Resources: `dnbcrate://tracks/{trackId}`, `dnbcrate://tracks/{trackId}/analysis`, `dnbcrate://set-plans/{setPlanId}`, `dnbcrate://renders/{renderJobId}/manifest`.

Prompt: `build-dnb-set` (optional; the tool workflow works without it).

Scoring details: `docs/scoring.md`. Analysis / templates: `docs/analysis.md`. Rendering / loudness / jobs: `docs/rendering.md`. Example plan JSON: `docs/examples/one-hour-plan.example.json`.

## Tests

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

Tests generate tiny sine-wave fixtures. They never read a private library.

## Layout

- `packages/domain` — types, config, errors, key normalization
- `packages/catalog` — SQLite, scanner, search, set plans, analysis jobs, render jobs
- `packages/audio-analysis` — envelope BPM/grid analyzer, click-track fixtures
- `packages/audio-renderer` — FFmpeg adapter, equal-power / phrase-mix / bass-swap, loudness
- `apps/cli` — deterministic administration
- `apps/mcp-server` — thin MCP adapters
- `docs/` — decisions, progress, tool contracts, spec

## Source-file safety

Source music is read-only. Generated files go under `outputRoot`. Tools never accept arbitrary paths, SQL, or shell commands.
