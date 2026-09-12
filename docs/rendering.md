# Rendering

The renderer prints a plan. It does not re-pick tracks. A full render writes two FLACs under `outputRoot`: a **24-bit 48 kHz master** named with the job id, and a **16-bit 48 kHz listen** copy named from the plan. Source files are never modified.

## FFmpeg

Install FFmpeg and ffprobe on `PATH` (or set `ffmpegPath` / `ffprobePath`). Phrase-mix and bass-swap need `acrossfade`, `ebur128`, `alimiter`, `atempo`, `lowpass`, `highpass`, `asplit`, `amix`, and `afade`.

Stretch prefers standalone Rubber Band 4 (`-3` / fine) when `rubberbandPath`, `DNB_CRATE_RUBBERBAND_PATH`, or `tools/rubberband-cli/` is present. FFmpeg’s `rubberband` filter is the fallback; `atempo` is last. Stretch runs on the **join only**. Featured bodies stay at rate 1.

Filter graphs prefer `-filter_complex_script`. Pairwise mixing applies if an inline graph would blow the argv limit.

## Loudness

Mix-wide **−14 LUFS**, true-peak **−1.0 dBTP**. No per-track loudnorm. One mix-wide attenuation if the mix is more than 0.5 LU above target.

Each entry gets `gainDb = clamp(medianLufs − trackLufs, −6, +3)`, then a further cut if stored true peak plus that gain would exceed 0 dBTP.

## Templates

| Preset       | What moves                                                                                                                                                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phrase_mix` | Complementary `lift` (default): incoming mid/high from bar 0; outgoing mid/high hold then fade; incoming low later in the window. Sequential: incoming mid/high start two bars before mid-phrase. Landing: incoming low opens two bars before the incoming drop when that drop is still ahead. |
| `bass_swap`  | Mid/high crossfade; lows swap at the handover bar.                                                                                                                                                                                                                                             |
| `crossfade`  | Single equal-power `acrossfade` (`hsin`).                                                                                                                                                                                                                                                      |

Overlap is the planned phrase (8 / 16 / 32 bars at the pair tempo). Intermediate pairwise joins write float WAV. The master is 24-bit FLAC (`renders/{jobId}.flac`). After that, a dithered 16-bit listen FLAC is written as `renders/{plan-name}.flac`. Checksums, `render:check`, and hour feedback stay on the master. Previews stay in `cache/previews/` and do not get a listen copy. Re-rendering a plan with the same name overwrites that listen file.

## Alignment and tempo

Alignment is planned as `mixInMs` / `mixOutMs` so the drop stays at overlap end. Render confirms (≤ 20 ms) or applies a leftover fallback: phrase wrap, then bar, then beat.

Playback rate is `pairTargetBpm /` accepted grid BPM, bounded to ±3% unless `allowExcessiveTempo`. Skip stretch for identity or when `|rate−1| · overlapMs < 10`.

Aligned templates fail closed when a required grid is missing, rejected, or below 0.6, unless `allowLowConfidence` is true.

Output duration must match the plan within 1000 ms. A full mix **fails the job** when that check
misses; the 24-bit master is kept for diagnostics. Previews only warn. `render:check` still treats
only mixes of five minutes or longer as a duration **fail** (shorter mixes warn). Listen-encode
failure after a valid master is a warning, not a failed job.

Queued full and preview jobs freeze the plan, selected evidence values (including absent rows),
source fingerprints, and the effective render settings. Validation and decode use that snapshot, not
the live plan. The preview cache key hashes the same frozen request. Editing the live plan, reanalysis,
or a later worker config change does not change what an already-queued job renders.

Named listen FLACs encode to a unique staging file per job, then publish under a lock so two workers
cannot share one `.partial.flac`. The previous listen file is replaced only after the new encode is
ready.

## Jobs

`render:start` / `create_transition_preview` return a job id. Poll `get_render_status`. After a full render succeeds, play `listenRootRelativePath` and keep `outputRootRelativePath` as the master. Read the manifest after `succeeded`.

`render:check --id JOB` looks for interior silence, window-in-silence, stored-grid residual > 40 ms on aligned joins, planned LUFS steps > 3 LU, and hour duration error > 1 s.
