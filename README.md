# DnB Crate

<p align="center"><img src="docs/images/dnb-crate.jpg" alt="DnB Crate" width="420"></p>

Point this at a local drum & bass folder. It catalogs the files, measures grids and keys, plans a deterministic mix of the length you ask for, and renders a gapless 24-bit master plus a 16-bit listen FLAC.

**Use your existing MP3/M4A library.** You can mix MP3 (including variable-bitrate), unprotected M4A, WAV, FLAC, and AIFF files in the same set. No manual conversion is needed: FFmpeg decodes your sources for analysis and mixing, and the original files stay unchanged. FLAC is the output format; it avoids another lossy encoding step but cannot restore detail already lost in a compressed source.

An MCP host (Cursor, Codex, MCP Inspector) talks to a stdio server. The same services are on the CLI. The model interprets requests; this app owns scanning, storage, search, planning, and rendering.

## Ask for a mix

Talk to the MCP host (Cursor, Codex). Mood or energy plus a length is enough. The host maps that onto `start_mix_workflow` using `create_set_plan` brief fields. The planner picks the order and joins; it does not write audio. The renderer prints a gapless **24-bit 48 kHz master** and a **16-bit listen** FLAC named from the plan.

Say whatever else you care about: preferred moods, subgenres, or artists; how the energy should move; a start or closer by title; a seed; genres to include or exclude; how pretty, danceable, or heavy the tracks should stay. Named titles are resolved with `search_tracks` (your catalog only). If you omit a length, the plan is **60 minutes**. Allowed range is 1 minute–8 hours.

Configure `libraryRoots`, `databasePath`, and `outputRoot`, then use `mix:create --wait` / `start_mix_workflow` for preflight, scanning, rhythm/key analysis, strict planning, rendering and verification. Migrations run automatically. A crate that cannot satisfy the brief returns an actionable blocker or inspectable partial plan. See [folder to first mix](docs/first-mix.md).

Examples:

- “Hour of liquid. Close on a title from this folder.”
- “20-minute mix, rolling energy.”
- “Peak hour. Climb into the last third, then ease off.”
- “30 minutes of liquid, keep the pretty ones. Give me a different take.”

Those words become structured fields:

| You say                                      | `create_set_plan`                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “20 minutes” / “an hour”                     | `targetDurationMinutes` or `targetDurationMs`                                                                                                                                   |
| “liquid”, “soulful”, “rolling”               | `preferredMoods` (also `heavy`, `dark`, `deep`, `neuro`, `uplifting`)                                                                                                           |
| “liquid funk”                                | `preferredSubgenres`                                                                                                                                                            |
| named artists                                | `preferredArtists`                                                                                                                                                              |
| start easy, peak late, then ease off         | `requestedArc` — start energy, when it peaks, how it ends (1–10 vs mix position). Default: open at 3, peak at 9 three-quarters in, land at 6                                    |
| Peak-style hour                              | energy/`danceability` floors + that arc + a subgenre if you have one. Not a mood named peak-time                                                                                |
| “start on X” / “close on Y”                  | `startTrackId` / `endTrackId`                                                                                                                                                   |
| “keep the pretty ones” / “keep it danceable” | `descriptors`: `melodicness` / `danceability` / `energy` / `valence` / `acousticness` / `subBass` / `brightness`. Absolute `min`/`max` 0–1, or crate-relative `minPct`/`maxPct` |
| include/exclude genres                       | `genres.include` / `genres.exclude`                                                                                                                                             |
| “same mix again”                             | same brief + same `seed` (default 1)                                                                                                                                            |
| “try another one” / “a different take”       | change `seed`                                                                                                                                                                   |

A new mix will not reuse old pairings unless you ask. Tracks keep their own tempo and meet in the overlap; the planner skips unexplained risky keys and unexplained fades.

Ready to render means the plan is valid, quality checks pass, and duration is within **5 minutes** of the request. The planner still aims within **90 s**. Analysis is advisory. Provenance is **manual > published > analyzed > tag**. The model must not invent BPM, key, energy, or cues.

### CLI

Same services, no host model. Duration and seed are flags. Moods, arc, descriptors, and genres need a brief JSON. Start from `docs/examples/liquid-hour.example.brief.json` or `docs/examples/peak-hour.example.brief.json`. Change duration, moods, descriptor floors, and seed. Do not copy title lists or exclude IDs from another library.

```bash
pnpm cli plan:create --brief-json docs/examples/liquid-hour.example.brief.json
pnpm cli plan:create --name "20-minute mix" --duration-min 20 --seed 4
pnpm cli plan:create --name "Named closer" --duration-min 60 --end-query "title words"
```

`--duration-min` or `--duration-ms`, not both. Then `plan:quality`, `render:start`, `render:check`.

## Prerequisites

- Node.js 24+
- [pnpm](https://pnpm.io/) 11+
- A folder of audio you own (`.wav`, `.flac`, `.mp3`, `.m4a`, `.aiff`)
- FFmpeg and ffprobe on `PATH` (see `docs/rendering.md`)
- Optional: Rubber Band 4 CLI under `tools/rubberband-cli/` for join-only R3 stretch
- KeyFinder CLI for automatic musical keys, under `tools/keyfinder-cli/`, on PATH, or configured with `keyfinderPath` (manual/published keys can be used without it)

## Setup

```bash
pnpm install
copy dnb-crate.config.example.json dnb-crate.config.json
```

Set `libraryRoots` to your music folder and `outputRoot` to a directory **outside** that folder. Config and `data/` are gitignored. Environment variables: `.env.example`.

Keep the default `supportedExtensions` to include MP3 and M4A. Use `pnpm cli mix:create --name "First mix" --duration-min 60 --wait` to scan and prepare the folder automatically. The individual commands below remain available. Scanning reports malformed or unreadable files and continues with readable files. If a file fails, check that it plays locally and that the app can read it; replace or re-export damaged files. Changing the filename extension does not convert audio. DRM-protected downloads cannot be used. If non-WAV analysis reports missing FFmpeg, install FFmpeg/ffprobe or set `ffmpegPath`/`ffprobePath` in the config.

## Typical flow

```bash
pnpm cli mix:create --name "First mix" --duration-min 60 --seed 1 --wait
```

That preflights, scans, analyzes rhythm and keys, plans, renders, and checks the master/listen files. Use `--brief-json` for moods, arc, descriptors, and genres. Migrations run on open.

JSON goes to stdout. Diagnostics go to stderr.

Individual stage commands remain available (`library:scan`, `analysis:run`, `plan:create`, `render:start`). Other useful commands: `library:stats`, `track:search`, `analysis:get`, `transition:plan`, `plan:list`, `plan:validate`.

## MCP server (stdio)

Stdout is reserved for JSON-RPC.

```bash
pnpm mcp
```

Cursor MCP config (do not hardcode someone else’s disk layout):

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

```bash
npx @modelcontextprotocol/inspector pnpm mcp
```

Tool contracts: `docs/tool-contracts.md`. Prompt: `build-dnb-set` (see **Ask for a mix**).

## How it fits together

| Part         | Job                                                                                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Catalog**  | Scan configured roots. Source files stay read-only.                                                                                                                                          |
| **Analyzer** | `dnb-crate-dsp` measures BPM/grid, sections, and loudness. Advisory until confidence clears the floor. KeyFinder runs as an internal, separately tracked key stage during ordinary analysis. |
| **Planner**  | Same catalog + brief + seed → same mix. Picks order and joins; does not write audio.                                                                                                         |
| **Renderer** | Prints the plan: beatmatched overlaps, 3-band fades, −14 LUFS, 24-bit master + 16-bit listen FLAC.                                                                                           |

Docs: [analysis](docs/analysis.md), [scoring](docs/scoring.md), [mixing](docs/mixing.md), [rendering](docs/rendering.md). Example briefs: `docs/examples/liquid-hour.example.brief.json`, `docs/examples/peak-hour.example.brief.json`.

## Tests

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

Tests use generated audio fixtures. The compressed-audio integration suite encodes real CBR/VBR MP3, AAC/M4A, and FLAC files with FFmpeg, then checks scanning, analysis, mixing, and cue timing. It requires FFmpeg/ffprobe with the `libmp3lame` encoder (also installed in CI). Tests never read a private library.

## Layout

- `packages/domain` — types, config, keys, scoring contracts
- `packages/catalog` — SQLite, scan, analysis jobs, planner, render jobs
- `packages/audio-analysis` — DSP grid / descriptors
- `packages/audio-renderer` — FFmpeg graphs
- `apps/cli` — administration
- `apps/mcp-server` — thin MCP adapters

Keep dependencies pointing inward: CLI/MCP adapters call catalog services; the catalog coordinates persistence, analysis, and rendering; the audio packages depend on domain contracts, and the domain does not depend on the catalog or audio implementations. ESLint enforces these package boundaries. File traversal lives in `scanner.ts`, while `library-scan.ts` owns import and missing-file reconciliation. Track-list reads load related metadata in batches so query count does not grow per track.

Generated files go under `outputRoot`. Tools never accept arbitrary paths, SQL, or shell commands.

## Worker lifecycle and scanning

One local runtime owns background jobs for each catalog database. Other runtimes can submit jobs;
the owner polls for them every 250 ms. Reporting CLI commands and maintenance reports use passive
runtimes, so they never recover or claim jobs. Recovery runs only after ownership is acquired from
an exited process or released by a closing runtime. This coordination is for processes on the same
machine, consistent with the local SQLite catalog.

CLI job commands (`mix:create`, `mix:resume`, `analysis:run`, `enrich:run`, `render:start`, and previews) enqueue only unless
you pass `--wait`. Enqueue-only exits immediately and requires a live worker such as `pnpm mcp`.
`--wait` and `analysis:gate` start a worker in the CLI process and keep it until those jobs finish.
Do not submit work and then shut down the only worker that claimed it.

Programmatic callers must `await runtime.close()`. Shutdown stops claiming jobs, aborts active
renders, and waits for current analysis/enrichment work and prefetched decodes before releasing
ownership and closing SQLite. Remaining queued jobs can run in the next active runtime.

Scanning follows each real directory once, including junctions and overlapping roots. If any path
cannot be traversed, the scan still imports readable files but skips marking existing files missing.
Resolve the reported access problems and rerun a complete scan to reconcile deletions.
