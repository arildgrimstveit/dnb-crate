# CLI reference

Every command prints a JSON envelope to stdout (`{ ok, data | error }`); diagnostics go to stderr. Commands that submit background jobs (`--wait` available) enqueue only unless you pass `--wait`, which keeps a worker alive in this process. Run `pnpm cli <command>` from the repository root.

Config comes from `dnb-crate.config.json` (see `.env.example` and the README for the basics). UUIDs are catalog ids from `track:search`, `plan:list`, `render:list`, or `mix:status`.

## First-mix workflow

| Command                                                                                             | What it does                                                                   |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `mix:preflight`                                                                                     | Check configured roots, output access, and native prerequisites                |
| `mix:create --name N [--brief-json FILE \| --duration-min M --seed S] [--request-token T] [--wait]` | Preflight → scan → analyze → plan → render → verify, as one resumable workflow |
| `mix:status --id UUID`                                                                              | Workflow stage, progress, issues, and final output references                  |
| `mix:resume --id UUID [--wait]`                                                                     | Reuse completed work and continue a blocked/interrupted workflow               |
| `mix:cancel --id UUID`                                                                              | Stop scheduling and cancel exclusively owned children                          |

## Library and tracks

| Command                                             | What it does                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `library:scan [--dry-run]`                          | Import new/changed files; report malformed ones and continue                 |
| `library:stats`                                     | Counts, extension spread, analysis/metadata coverage, descriptor percentiles |
| `track:search [--query Q] [--artist A] [--limit N]` | Search the catalog (same filters as the MCP `search_tracks`)                 |
| `db:migrate`                                        | Open the catalog and apply pending migrations                                |

## Analysis

| Command                                                                                           | What it does                                                              |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `analysis:start --track-id UUID [--wait]`                                                         | Analyze specific tracks (DSP + key stage)                                 |
| `analysis:run --scope stale\|unanalyzed\|all\|planningReady [--wait] [--timeout-min N]`           | Analyze a whole scope; `stale` re-runs old-analyzer rows and missing keys |
| `analysis:status [--id UUID]`                                                                     | List or inspect analysis jobs (including per-track key stages)            |
| `analysis:get --track-id UUID`                                                                    | Grid, key, sections, cues, descriptors for one track                      |
| `analysis:compare --track-id UUID`                                                                | Per-engine BPM/key comparison                                             |
| `analysis:report`                                                                                 | Whole-library analysis report (engine versions, BPM agreement, keys)      |
| `analysis:gate [--previews]`                                                                      | Analyze all published/manual-BPM tracks, then verify the report           |
| `analysis:cue-preview --track-id UUID [--cue drop]`                                               | Render a short WAV around a cue point                                     |
| `analysis:select-evidence --track-id UUID [--rhythm E] [--structure E] [--key E] [--reason TEXT]` | Pin which stored evidence rows planning/rendering use                     |

## Enrichment (disabled by default)

| Command                                                                   | What it does                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------ |
| `enrich:run --scope unmatched\|all\|ids [--dry-run] [--limit N] [--wait]` | Match tracks against MusicBrainz/Deezer/AcoustID |
| `enrich:status [--id UUID]`                                               | Enrichment job status                            |
| `enrich:report`                                                           | Match methods, disagreements, duplicates         |

## Planning

| Command                                                                                                      | What it does                                              |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `plan:create --name N [--brief-json FILE] [--duration-min M \| --duration-ms MS] [--seed S] [--end-query Q]` | Draft and store a deterministic set plan                  |
| `plan:list` / `plan:get --id UUID`                                                                           | List plans; plan + quality report                         |
| `plan:quality --id UUID`                                                                                     | Strict-quality report (joins, harmony, duration, spacing) |
| `plan:validate --id UUID`                                                                                    | Structural validation plus render readiness               |
| `plan:clone --id UUID --name N [--replan]`                                                                   | Copy a plan (optionally rebuild joins)                    |
| `plan:delete --id UUID --confirm`                                                                            | Delete a plan                                             |

## Transitions and feedback

| Command                                                                                | What it does                                    |
| -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `transition:plan --from UUID --to UUID [--type T] [--bars 16\|32]`                     | Ranked transition proposals for a pair          |
| `transition:validate --from UUID --to UUID --type T`                                   | Feasibility check for one transition            |
| `feedback:rate --json FILE`                                                            | Record a listen rating for a pair/recipe        |
| `feedback:list [--from UUID] [--to UUID] [--fingerprint F]`                            | List transition ratings                         |
| `hour:feedback --id RENDER_UUID --checksum SHA256 --accepted true\|false --quote TEXT` | Verdict on a whole render, tied to its checksum |
| `hour:history [--id RENDER_UUID]`                                                      | Past whole-render verdicts, newest first        |

## Rendering

| Command                                                                                                                                  | What it does                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `render:start --plan-id UUID [--wait] [--edge-fade-ms N] [--allow-low-confidence] [--allow-excessive-tempo] [--allow-overlong-duration]` | Queue a full render (24-bit master + 16-bit listen FLAC); `--allow-overlong-duration` bypasses a duration-only deviation (e.g. after removing entries from an auditioned plan) |
| `render:preview --plan-id UUID --transition-id UUID [--wait] [--template T]`                                                             | Render one join as a short preview                                                                                                                                             |
| `render:status --id UUID` / `render:list`                                                                                                | Job status / recent jobs                                                                                                                                                       |
| `render:manifest --id UUID`                                                                                                              | Per-track alignment, rates, checksums, loudness                                                                                                                                |
| `render:check --id UUID`                                                                                                                 | Silence/residual/level/duration checks over the finished master                                                                                                                |
| `render:cancel --id UUID --confirm`                                                                                                      | Kill a running or queued render                                                                                                                                                |
