# Rendering (Stage 4)

Stage 4 writes a **gapless 24-bit 48 kHz FLAC** (same PCM as the mix, losslessly compressed). Crossfades stay equal-power. Phrase-mix and bass-swap templates are beat-aligned when analysis is valid. Source files are never modified. Outputs go under `outputRoot`.

Analysis, confidence, and template parameters: `docs/analysis.md`. Ear-check rules for later hours: `docs/mixing-lessons.md`.

## FFmpeg

Install FFmpeg **and** ffprobe so both are on `PATH` (or set `ffmpegPath` / `ffprobePath` in config).

The server looks for `acrossfade`, `ebur128`, and `alimiter` for every mix. Phrase-mix and bass-swap also need `atempo`, `lowpass`, `highpass`, `asplit`, `amix`, and `afade`.

Filter graphs prefer `-filter_complex_script` (a sidecar file, so argv stays short). Builds that do not ship that option — some Windows nightlies — fall back to inline `-filter_complex`. Pairwise mixing still applies if the inline graph would blow the argv soft limit.

Tempo matching uses **`atempo`** (pitch-preserving). `asetrate` is not used.

## Loudness policy

Unchanged from Stage 3: mix-wide **-14 LUFS**, true-peak **-1.0 dBTP**, no per-track loudnorm, one mix-wide attenuation if the mix is >0.5 LU above target, `alimiter` on the ceiling.

## Timing

- Crossfade: `acrossfade` with `c1=hsin` / `c2=hsin`.
- Phrase mix / bass swap: pairwise **3-band** graphs (`asplit=3`, Linkwitz–Riley 4th-order low/mid/high, `amix=inputs=6`). The graph limiter, when applied, sits on the overlap tail only. Overlap duration is the planned phrase (16/32 bars at target BPM). Presets:

  | Preset | What moves |
  | --- | --- |
  | `phrase_mix` | Incoming mid/high fade in over the whole overlap (`hsin`); outgoing mid/high fade out over the same span so the kits do not stack. Incoming low arrives at bar 12 (24 of 32). Outgoing low steps to −24 dB there, then to −inf at the end. When a drop outro meets a drum-heavy intro (`phraseShape: sequential`), incoming mid/high wait until mid-phrase so the kits do not overlap. |
  | `bass_swap` | Mid/high crossfade across the overlap; outgoing mid dips −6 dB from bar 4. Lows swap at bar 8 (16 of 32) in `rampMs`, then outgoing low goes to −inf at bar 12. |
  | `crossfade` | Single `acrossfade` with `hsin` (WP6 may shorten this on tempo mismatch). |

  Band fades use `afade` `unity`/`silence` when FFmpeg has them (`hasAfadeUnity`). Otherwise partial levels collapse to full fades and a warning is recorded. `double_drop` still renders as `bass_swap`.
- Aligned joins nudge the incoming start in **output time**. When both `downbeatConfidence` values are ≥ 0.5 the wrap period is one **bar** (4 beats); otherwise one beat. A negative nudge at source start 0 adds one period instead of being dropped. Manifest fields: `downbeatOffsetMs`, `alignmentPeriodMs`, `alignmentMode` (`bar` | `beat`).
- Playback rate other than 1.0 is applied with `atempo` and bounded to ±3% unless `allowExcessiveTempo`.
- Internal mix: 48 kHz stereo PCM 24-bit. Working files stay WAV. The published file is 24-bit FLAC.
- Published FLACs do **not** keep the first source file's tags. They get mix-level `title`/`album` (plan name), `artist` `dnb-crate`, a numbered tracklist in `comment`/`description`, and an embedded `CUESHEET` (track markers). FFmpeg's FLAC muxer does not persist native chapters; the cue sheet is what foobar2000 and similar players read.
- Output duration must match the plan within **1000 ms** (after rate-adjusted playable lengths).

## Job lifecycle

Same as Stage 3: `start_set_render` / `create_transition_preview` return a job id immediately. Poll `get_render_status`. Manifest after `succeeded`. Preview cache keys include template, bar count, and playback rates.

Aligned templates **fail closed** when a required grid is missing, rejected, or below confidence 0.6, unless `allowLowConfidence` is true.

`render:check --id JOB` runs `silencedetect` (−50 dB, ≥ 1 s) and prints interior spans plus per-join template, bars, rates, `downbeatOffsetMs`, `alignmentPeriodMs`, `alignmentMode`, and `windowInSilence`. Exit 1 if any interior span or window sits in silence.

## Known limitations

- Envelope analysis is advisory on real music; click-track fixtures are the automated grid gate.
- `double_drop` is Stage 5 (rendered as bass_swap with a warning).
- Private listening QA is not an automated gate. Verdicts and keep-files: `docs/mixing-lessons.md`.
