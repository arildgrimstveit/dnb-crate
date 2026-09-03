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

Each plan entry also gets a bounded `gainDb` so tracks sit near the **set median** integrated LUFS (not a fixed −14). `gainDb = clamp(medianLufs − trackLufs, −6, +3)`. Tracks without LUFS stay at 0 and record `levelMatchWarning: missing-lufs`. A non-zero manual `gainDb` survives `plan:clone --replan`. The renderer already applies this as `volume=`. `render:check` v2 prints per-join `outgoingGainDb` / `incomingGainDb` and the 10 s level step.

## Timing

- Crossfade: `acrossfade` with `c1=hsin` / `c2=hsin`.
- Phrase mix / bass swap: pairwise **3-band** graphs (`asplit=3`, Linkwitz–Riley 4th-order low/mid/high, `amix=inputs=6`). The graph limiter, when applied, sits on the overlap tail only. Overlap duration is the planned phrase (8/16/32 bars at target BPM). Presets:

  | Preset | What moves |
  | --- | --- |
  | `phrase_mix` | Complementary: incoming mid/high fade in over the overlap (`hsin`); outgoing mid/high fade out over the same span. Incoming low arrives at bar 12 (24 of 32, 6 of 8). Sequential: incoming mid/high start 2 bars before mid-phrase. Landing: incoming low at −inf until the last bar; outgoing mid/high fade only over the last 8 bars (4 when `B = 8`); incoming drop hits as the outgoing ends. Render keeps a planned `landing` (or `exitKind: dropLanding`) and does not run `choosePhraseShape` over it. Sequential still applies when the planner did not set landing. |
  | `bass_swap` | Mid/high crossfade across the overlap; outgoing mid dips −6 dB from bar 4. Lows swap at bar 8 (16 of 32, 4 of 8) in `rampMs`, then outgoing low goes to −inf at the handover bar. |
  | `crossfade` | Single `acrossfade` with `hsin`. |

  Every band ramp uses `:curve=hsin`, including partial levels. Band fades use `afade` `unity`/`silence` when FFmpeg has them (`hasAfadeUnity`). Otherwise partial levels collapse to full fades and a warning is recorded. `double_drop` still renders as `bass_swap`.
- Alignment is baked into planned `mixInMs` / `mixOutMs` so the drop stays at overlap end. Render only confirms (≤ 20 ms) or applies a leftover after the same fallback. Phrase wrap is kept when `|offset|` is within half a bar (~2 beats); larger residuals fall back to **bar**, then **beat** — never an 11 s phrase slide. A negative nudge at source start 0 **shifts the outgoing mix-out / end** and recomputes overlap so the overlap start is not stale. It never adds one period. Manifest fields: `downbeatOffsetMs`, `alignmentPeriodMs`, `alignmentMode` (`bar` | `beat` | `phrase`).
- Playback rate other than 1.0 is applied with `atempo` and bounded to ±3% unless `allowExcessiveTempo`.
- Internal mix: 48 kHz stereo PCM 24-bit. Working files stay WAV. The published file is 24-bit FLAC.
- Published FLACs do **not** keep the first source file's tags. They get mix-level `title`/`album` (plan name), `artist` `dnb-crate`, a numbered tracklist in `comment`/`description`, and an embedded `CUESHEET` (track markers). FFmpeg's FLAC muxer does not persist native chapters; the cue sheet is what foobar2000 and similar players read.
- Output duration must match the plan within **1000 ms** (after rate-adjusted playable lengths).

## Job lifecycle

Same as Stage 3: `start_set_render` / `create_transition_preview` return a job id immediately. Poll `get_render_status`. Manifest after `succeeded`. Preview cache keys include template, bar count, and playback rates.

Aligned templates **fail closed** when a required grid is missing, rejected, or below confidence 0.6, unless `allowLowConfidence` is true.

`render:check --id JOB` runs `silencedetect` (−50 dB, ≥ 1 s) and prints interior spans plus per-join template, bars, rates, `downbeatOffsetMs`, `alignmentPeriodMs`, `alignmentMode`, `windowInSilence`, alignment residual (grid xcorr after the applied nudge; a one-beat period-add still fails), 10 s arrangement step (LUFS 10 s before the overlap vs 10 s after it ends), low-overlap proxy, Camelot distance, `exitKind`, mix windows, and per-track LUFS/gain. Exit 1 if any interior span, window sits in silence, residual > 40 ms, or the gain-corrected LUFS delta (`incomingLufs + incomingGainDb − outgoingLufs − outgoingGainDb`) exceeds 3 LU. Quiet-tail and landing joins can show a large 10 s arrangement step; that is not the level-match gate.

The one-beat residual heuristic only fires when the wrap period is a **beat** (~345 ms). Phrase-mode wraps are ~8 bars (~11 s), so a 360 ms phrase nudge is not treated as a +1-period failure. Grid xcorr uses a 20 ms hop and searches only ±160 ms (half a beat). A wider lag window on phrase/bar wraps locks onto the next periodic replica (~345 ms) on sparse liquid grids. The off-zero peak must beat lag 0 by 25% or the residual is 0 — otherwise liquid/ambient onsets report the search-edge lag. Missing beat grids do not fall back to the raw nudge. Residual > 40 ms fails only on `phrase_mix` / `bass_swap`.

## Known limitations

- Envelope analysis is advisory on real music; click-track fixtures are the automated grid gate.
- `double_drop` is Stage 5 (rendered as bass_swap with a warning).
- Private listening QA is not an automated gate. Verdicts and keep-files: `docs/mixing-lessons.md`.
