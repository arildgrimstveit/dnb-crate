# Rendering (Stage 4)

Stage 4 writes a **gapless WAV**. Crossfades stay equal-power. Phrase-mix and bass-swap templates are beat-aligned when analysis is valid. Source files are never modified. Outputs go under `outputRoot`.

Analysis, confidence, and template parameters: `docs/analysis.md`.

## FFmpeg

Install FFmpeg **and** ffprobe so both are on `PATH` (or set `ffmpegPath` / `ffprobePath` in config).

The server looks for `acrossfade`, `ebur128`, and `alimiter` for every mix. Phrase-mix and bass-swap also need `atempo`, `lowpass`, `highpass`, `asplit`, `amix`, and `afade`.

Filter graphs prefer `-filter_complex_script` (a sidecar file, so argv stays short). Builds that do not ship that option — some Windows nightlies — fall back to inline `-filter_complex`. Pairwise mixing still applies if the inline graph would blow the argv soft limit.

Tempo matching uses **`atempo`** (pitch-preserving). `asetrate` is not used.

## Loudness policy

Unchanged from Stage 3: mix-wide **-14 LUFS**, true-peak **-1.0 dBTP**, no per-track loudnorm, one mix-wide attenuation if the mix is >0.5 LU above target, `alimiter` on the ceiling.

## Timing

- Crossfade: `acrossfade` with `c1=hsin` / `c2=hsin`.
- Phrase mix / bass swap: pairwise graphs; overlap duration is the planned phrase (16/32 bars at target BPM).
- Playback rate other than 1.0 is applied with `atempo` and bounded to ±3% unless `allowExcessiveTempo`.
- Internal format: 48 kHz stereo PCM 24-bit WAV.
- Output duration must match the plan within **1000 ms** (after rate-adjusted playable lengths).

## Job lifecycle

Same as Stage 3: `start_set_render` / `create_transition_preview` return a job id immediately. Poll `get_render_status`. Manifest after `succeeded`. Preview cache keys include template, bar count, and playback rates.

Aligned templates **fail closed** when a required grid is missing, rejected, or below confidence 0.5, unless `allowLowConfidence` is true.

## Known limitations

- Envelope analysis is advisory on real music; click-track fixtures are the automated grid gate.
- `double_drop` is Stage 5 (rendered as bass_swap with a warning).
- Private listening QA is not part of the automated gate.
