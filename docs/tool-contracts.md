# Tool contracts (Stage 1–4)

All tools return the application envelope:

```ts
{ ok: true, data: T, warnings: string[] } | { ok: false, error: { code, message, retryable, details? } }
```

Plus a short `text` content fallback. Source `filePath` is never included in `data`.

## `get_server_status`

- Input: `{}`
- Output data: `{ name, version, databaseReady, libraryRootCount, libraryRootsReady, outputRootConfigured, ffmpegAvailable, ffprobeAvailable, ffmpegVersion, ffprobeVersion, supportedExtensions }`

## `scan_library`

- Input: `{ dryRun?: boolean }`
- Output data: `{ dryRun, rootsScanned, filesSeen, upserted, moved, skippedUnsupported, skippedMalformed, markedMissing }`
- Does not accept a path argument.

## `search_tracks`

- Input: optional `query`, `artist`, `bpmMin`/`bpmMax`, `musicalKey`, `camelotKey`, `energyMin`/`energyMax`, `minRating`, `subgenres` + `subgenresMatch`, `moods` + `moodsMatch`, `tags` + `tagsMatch`, `analysisStatus`, `sort`, `direction`, `limit` (1–50), `cursor`
- Output data: `{ tracks, nextCursor, limit, sort, direction }`

## `get_track`

- Input: `{ trackId }` (UUID)
- Output: public track plus `cuePoints`
- Errors: `TRACK_NOT_FOUND`

## `update_track_metadata`

- Input: `{ trackId }` plus at least one of `energy`, `rating`, `moods`, `subgenres`, `tags`, `notes`, `bpm`, `musicalKey`
- Manual BPM/key set provenance to `manual` and survive a later file scan
- Errors: `TRACK_NOT_FOUND`, `INVALID_METADATA`

## `get_library_stats`

- Input: `{}`
- Output data: counts, `extensionCounts`, missing-field counts, `totalDurationMs`

## `set_cue_points`

- Input: `{ trackId, cuePoints: [{ type, positionMs, ... }], beatAnchorMs? }` — replaces the full list; optional anchor reconstructs the stored grid
- Errors: `TRACK_NOT_FOUND`, `INVALID_METADATA`, `INVALID_BEAT_GRID`

## `start_track_analysis`

- Input: `{ trackIds?: UUID[], planningReadyOnly?: boolean }` — at least one of `trackIds` or `planningReadyOnly=true`
- Output: analysis job
- Errors: `TRACK_NOT_FOUND`, `ANALYSIS_FAILED`

## `get_analysis_status`

- Input: `{ analysisJobId? }`
- Output: `{ jobs: AnalysisJob[] }`
- Errors: `ANALYSIS_JOB_NOT_FOUND`

## `get_track_analysis`

- Output: grid, BPM/key with confidence, bands, suggested cues, canonical vs analyzed provenance, descriptors (`chromaVector`, `tempoEvidence`)
- Errors: `TRACK_NOT_FOUND`, `ANALYSIS_FAILED` (not yet analyzed; retryable)

## `compare_track_analyses`

- Input: `{ trackId, engine? }`
- Output: per-engine BPM/key/sections plus `chromaVector` when the DSP row has one

## `get_track_sections`

- Input: `{ trackId, engine? }`

## `get_analysis_report`

- Input: `{}`
- Output: `{ inRange: { count, withinHalf }, outOfRange: { count }, engines[], needsReview[], disagreements[] }`
- `withinHalf` is computed only on published/manual BPM inside 160–190. Out-of-range published values are `needsReview` with `publishedFolded`.

## `create_cue_preview`

- Input: `{ trackId, cue?: intro_start|drop|breakdown|outro_start, windowMs? }`
- Output: `{ trackId, cue, positionMs, outputRelpath }`

## `plan_transition`

- Input: `{ outgoingTrackId, incomingTrackId, preferredType?, barCount?, targetBpm?, allowExcessiveTempo?, allowLowConfidence?, allowDropIn? }`
- Output: `{ proposals: TransitionProposal[] }` ranked; analyzer-derived cues are reasons, not blockers; incoming `drop` only when `preferredType=bass_swap` and `allowDropIn`

## `validate_transition`

- Input: type plus optional duration/rates/overrides
- Output: `{ valid, feasible, errors, warnings }`

## `get_planning_readiness`

- Input: `{ trackId? }`
- Output: per-track missing BPM/key/energy/file plus cue types

## `find_compatible_tracks`

- Input: `{ sourceTrackId, direction?, limit?, preferredMoods?, ... }`
- Output: ranked candidates with score components and reason codes

## `create_set_plan`

- Input: name, optional duration/BPM/arc/required/excluded/preferences/start/end/seed
- Output: `{ plan, explanation, validation, partial }`
- Errors: `TRACK_NOT_FOUND` when a required/start/end id is not eligible

## `get_set_plan` / `list_set_plans`

- Errors: `SET_PLAN_NOT_FOUND`

## `update_set_plan`

- One of: `name`, `replaceTrack`, `setTrim`, `setTransition`, `setPlaybackRate`, `applyTransition`, `moveEntry`
- Rebuilds timeline; rejects structurally invalid edits with `INVALID_SET_PLAN`
- `applyTransition` keeps `outgoing.sourceStartMs = min(existing, proposal)` so a phrase-length proposal does not collapse the playable window below 90 s. `incoming.sourceEndMs` is only written when the incoming entry is last (no `transitionToNext`).
- Analysis rows include `gridSource` (`analyzed` | `reference` | `anchor`) and optional `descriptors.audioStartMs` / `audioEndMs`. Reference grids never change canonical BPM/key.
- `validate_set_plan` warns `WINDOW_IN_SILENCE` when `sourceEndMs` is more than 250 ms past `descriptors.audioEndMs`. Render readiness blocks only when the whole overlap sits past `audioEndMs`.

## `delete_set_plan`

- Input: `{ setPlanId, confirm: true }`

## `validate_set_plan`

- Errors: `SET_PLAN_NOT_FOUND`
- Output also includes optional `renderReadiness` (FFmpeg presence, fingerprint mismatches, unreadable files, trims shorter than the planned crossfade)

## `create_transition_preview`

- Input: `{ setPlanId, transitionId, windowMs?, template?, barCount?, allowLowConfidence? }`
- Output: render job (queued or cache hit)
- Errors: `SET_PLAN_NOT_FOUND`, `INVALID_SET_PLAN`, `FFMPEG_UNAVAILABLE`, `AUDIO_FILE_UNAVAILABLE`

## `start_set_render`

- Input: `{ setPlanId, outputFormat?: "wav", edgeFadeMs?, allowLowConfidence?, allowExcessiveTempo? }`
- Returns immediately with a job id. Poll `get_render_status`.
- Errors: `SET_PLAN_NOT_FOUND`, `INVALID_SET_PLAN`, `FFMPEG_UNAVAILABLE`

## `get_render_status` / `list_render_jobs`

- Status includes `outputRootRelativePath` when succeeded (never an absolute path)
- Errors: `RENDER_JOB_NOT_FOUND`

## `cancel_render_job`

- Input: `{ renderJobId, confirm: true }`
- Kills the FFmpeg child if running

## `get_render_manifest`

- `get_render_manifest` tracks include `downbeatOffsetMs`, `alignmentPeriodMs`, and `alignmentMode` (`bar` | `beat`)
- Errors: `RENDER_JOB_NOT_FOUND`, `RENDER_FAILED` (not finished; `retryable` while queued/running)

## Resources

- `dnbcrate://tracks/{trackId}`
- `dnbcrate://tracks/{trackId}/analysis`
- `dnbcrate://set-plans/{setPlanId}`
- `dnbcrate://renders/{renderJobId}/manifest`

## Prompt

- `build-dnb-set` argument `request`: natural-language brief → structured `create_set_plan`, then optional preview/render
