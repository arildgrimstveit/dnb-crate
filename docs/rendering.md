# Rendering

The renderer prints a plan. It does not re-pick tracks. A full render writes two FLACs under `outputRoot`: a **24-bit 48 kHz master** named with the job id, and a **16-bit 48 kHz listen** copy named from the plan. Source files are never modified.

## FFmpeg

Install FFmpeg and ffprobe on `PATH` (or set `ffmpegPath` / `ffprobePath`). Phrase-mix and bass-swap need `acrossfade`, `ebur128`, `alimiter`, `atempo`, `lowpass`, `highpass`, `asplit`, `amix`, and `afade`.

Stretch prefers standalone Rubber Band 4 (`-3` / fine) when `rubberbandPath`, `DNB_CRATE_RUBBERBAND_PATH`, or `tools/rubberband-cli/` is present. Queued jobs freeze that executable path, its SHA-256, and the audio-engine id. Execution refuses a replaced binary or a queued engine id that no longer matches the running DSP. Full renders use the frozen path and refuse FFmpeg `rubberband` / `atempo` fallback when any original deck needs stretch, including multi-track pairwise mixes. Featured bodies stay at rate 1. Extract, makeup and splices stay 32-bit float; planned segment gain is applied before any bounded or external step.

Filter graphs prefer `-filter_complex_script`. Phrase-mix and bass-swap with three or more decks join the original pair each time, then stitch the preserved prefix with a short fade. Each shared deck uses a consistent crossover response across its two joins, including plain crossfade → band and band → plain crossfade. A plain crossfade applies the adjacent band reconstruction to that deck when needed; this prevents blending dry and phase-shifted copies at the stitch. Completed track bodies are not sent through the band filters again. Pairwise also applies if an inline graph would blow the argv limit.

## Loudness

Mix-wide **−14 LUFS**, true-peak **−1.0 dBTP**. No per-track loudnorm. The mix is assembled in float without a graph limiter. One static gain then satisfies loudness and peak headroom; a single latency-compensated 4× oversampled limiter runs only if residual true peak still misses. Phrase-mix / bass-swap apply complementary LR4 bands once per original join. A full render fails closed if loudness or true-peak measurement of the encoded master is missing, or if the encoded true peak exceeds the ceiling. The 24-bit master is quantized explicitly to `s32` / 24-bit FLAC; the 16-bit listen copy is measured after dither and withheld when that measurement is missing or over the ceiling.

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
source fingerprints, and the effective render settings including renderer version, audio-engine id,
the Rubber Band path, and the Rubber Band executable hash. Validation and decode use that snapshot,
not the live plan. The preview cache key hashes the same frozen request. Editing the live plan,
reanalysis, a renderer/audio-engine bump, replacing the frozen Rubber Band binary, or a later worker
config change does not change what an already-queued job renders and invalidates new preview
identities. An incompatible queued engine or replaced binary fails the job instead of rendering with
the new DSP.

Named listen FLACs encode to a unique staging file per job. The coordinator measures and verifies
that staged file before publishing under a lock. Failed verification removes only that job’s staged
file and preserves the previous named listen file. Measurements in the manifest belong to the
verified stage, even when another same-name render publishes later.

## Jobs

`render:start` / `create_transition_preview` return a job id. Poll `get_render_status`. After a full render succeeds, play `listenRootRelativePath` and keep `outputRootRelativePath` as the master. Read the manifest after `succeeded`.

`render:check --id JOB` looks for interior silence, window-in-silence, stored-grid residual > 40 ms on aligned joins, planned LUFS steps > 3 LU, and hour duration error > 1 s.
