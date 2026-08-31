# Analysis and aligned transitions (Stage 4)

Automatic analysis is **advisory**. Every BPM, key, downbeat, and suggested cue has confidence and provenance. Manual values always win without deleting the analysis row.

## Analyzer

Stage 4 uses an in-process TypeScript envelope analyzer (`dnb-crate-envelope` 1.0.0) in `@dnb-crate/audio-analysis`. WAV is decoded in-process (16-bit PCM). Other formats are decoded to PCM with FFmpeg when it is available.

Rejected alternatives (native aubio, Python/librosa worker) are recorded in `docs/decisions.md`. Click-track fixtures are the automated accuracy gate; real-library quality is advisory.

## BPM and grids

- Tempo is folded into **160–190 BPM** (half/double time).
- Grids are 4/4 only, reconstructed from a beat/downbeat anchor (default 0, or `set_cue_points.beatAnchorMs`).
- Confidence below **0.5**, or a tempo that cannot fold into range, **rejects** the grid. Rejected grids are stored and surfaced; they cannot enter phrase-mix/bass-swap renders unless `allowLowConfidence` is true.
- Canonical BPM/key precedence: **manual > analyzed > tag**.

## Cue points

- Analyzer may insert `analyzed` intro/drop/outro cues only when that type is not already present.
- `set_cue_points` replaces the list as `manual` and may set a beat anchor that reconstructs the stored grid from canonical BPM.

## Transition templates

| Template     | Behaviour                                                                                                                                                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crossfade`  | Equal-power `acrossfade` (`c1=hsin`/`c2=hsin`). No grid required.                                                                                                                                                                                                                |
| `phrase_mix` | 16 or 32 bars at target BPM. Incoming mids/highs fade in through a **250 Hz** high-pass. Outgoing fades out over the phrase.                                                                                                                                                     |
| `bass_swap`  | Split at a bounded crossover (**120–250 Hz**, default **180**). Highs equal-power acrossfade. Outgoing lows fade out and incoming lows fade in at bar **8 of 16** or **16 of 32**, ramp **20–80 ms** (default **40**). Both lows are never at full strength through the overlap. |

Parameters are bounded template numbers, not model-supplied FFmpeg strings.

Tempo matching uses FFmpeg **`atempo`** (pitch-preserving), not `asetrate`. Playback rate is **±3%** unless `allowExcessiveTempo` is set.

`plan_transition` ranks `bass_swap` first when energy rises or both tracks are ≥ 7; otherwise `phrase_mix`; `crossfade` is the fallback. Accept a proposal with `update_set_plan.applyTransition`.

`double_drop` remains Stage 5 (rendered as `bass_swap` with a warning if it appears on a plan).

## CLI

```bash
pnpm cli analysis:start --track-id UUID --wait
pnpm cli analysis:get --track-id UUID
pnpm cli transition:plan --from UUID --to UUID --bars 32
```
