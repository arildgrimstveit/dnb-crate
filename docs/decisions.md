# Decisions

## 2026-08-31 — MCP TypeScript SDK v2 packages

The implementation spec named `@modelcontextprotocol/sdk`. The stable TypeScript line for MCP revision 2026-07-28 ships as `@modelcontextprotocol/server` and `@modelcontextprotocol/client` (v2.0.0). Stage 1 uses those packages, `registerTool` / `registerResource`, `serveStdio`, and Zod 4 schemas (`zod/v4`).

## 2026-08-31 — TypeScript executed with tsx

Apps run from TypeScript source via `tsx` rather than a `dist/` compile step. Workspace `exports` point at `src/index.ts`. This keeps Stage 1 iteration short; a compile pipeline can be added when packaging for non-dev hosts.

## 2026-08-31 — File fingerprint

A track fingerprint is SHA-256 over file size plus the first and last 64 KiB (the tail is omitted when the file is smaller than 64 KiB). Modification time is **not** mixed into the hash: including it made copy/rewrite moves look like new files. Two different files that share size and those windows can still collide. That is accepted for Stage 1 move detection. A full-file hash can replace this later if collisions appear.

## 2026-08-31 — Missing title statistic

`missingTitleFromTagsCount` is approximated as “title equals the filename stem”. Embedded title tags that happen to match the filename are counted as missing. Good enough for Stage 1 hygiene; a dedicated provenance flag can be added later.

## 2026-08-31 — Stage 2 timing overlap

Stage 2 treats a 30-second crossfade as a **timing assumption only**. Transition type is stored on the plan so Stage 3 can render it; no audio is mixed yet.

## 2026-08-31 — Manual BPM/key vs rescan

File scans no longer overwrite BPM or key when `bpmSource` / `keySource` is `manual`. Energy, rating, moods, tags, and notes were already preserved.

`fileMissing` is included on public tracks so a search can still find a renamed/deleted file without exposing `filePath`. `filePath` is omitted from every MCP and default CLI search result.

## 2026-08-31 — Prompt schemas live in domain

`apps/mcp-server` does not depend on `zod`. `build-dnb-set` argument schemas are exported from `@dnb-crate/domain` (`buildDnbSetPromptArgsSchema`) so the MCP server can pass them to `registerPrompt` without a direct Zod import.

## 2026-08-31 — get_track vs update_track_metadata output

`get_track` returns a public track **plus** `cuePoints` (`getTrackDataSchema`). `update_track_metadata` still returns a public track without requiring cue points (`publicTrackSchema`).

## 2026-08-31 — Stage 3 renderer and loudness

WAV is the only output. Mixing uses FFmpeg `acrossfade` with `hsin` curves (equal-power) at 48 kHz stereo `pcm_s24le`. Argument arrays only; filter graphs use stream labels, never source paths.

Loudness: mix-wide target **-14 LUFS**, true-peak ceiling **-1 dBTP**. Individual tracks are not loudnormed. If integrated LUFS is more than 0.5 LU above target, one mix-wide attenuation is applied. Stage 3 does not promise bit-identical output across FFmpeg builds.

Jobs persist in SQLite. `cancel_render_job` aborts the child process. Running jobs leftover after a crash are marked `RENDER_INTERRUPTED`.

The in-process fake FFmpeg runner is used in catalog/MCP tests so the gate does not require a system FFmpeg install. A real-FFmpeg integration test skips when binaries are missing.

## 2026-08-31 — Stage 4 analyzer and atempo

Beat grids come from a TypeScript onset-envelope analyzer (`dnb-crate-envelope`) plus WAV decode. No Python worker and no native aubio: Windows native builds were rejected, and a second runtime would split the product. Key estimation is a coarse pitch/zero-crossing hint and is often omitted (confidence 0) on broadband/click material; tags and manual keys remain canonical.

Pitch-preserving stretch uses FFmpeg `atempo` after `atrim`/`asetpts`. `asetrate` is not used because it would shift pitch.

Bass-swap EQ frequencies, swap bar, and ramp are clamped template parameters (crossover 120–250 Hz, ramp 20–80 ms). The model cannot pass raw filter expressions.
