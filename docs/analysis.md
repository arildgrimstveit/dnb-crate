# Analysis and aligned transitions (Stage 5 / v2.1)

Automatic analysis is **advisory**. Every BPM, key, downbeat, section, and suggested cue has confidence and provenance. Manual values always win without deleting the analysis row.

Canonical BPM/key precedence: **manual > published > analyzed > tag**.

## Engines

| Engine | Runtime | What it produces |
| --- | --- | --- |
| `dnb-crate-dsp` 2.1 (default) | TypeScript in-process | STFT spectral-flux onsets, tempogram, comb-locked sub-hop beats, downbeats, HPCP chroma key (165–3520 Hz, spectral peaks, tuning, Temperley+KK), downbeat-anchored sections, sonic descriptors |
| `beat-this` | Optional Python sidecar | Beats / downbeats / tempo (IQR confidence; 180 s timeout) |
| `allin1` | Optional Python sidecar (slow; Demucs) | Beats / downbeats / tempo / section labels (900 s timeout) |
| `dnb-crate-envelope` 1.0 | Legacy | Peak-amplitude envelope; kept for migrated Stage 4 rows |

Key and descriptors always come from `dnb-crate-dsp` even when a sidecar supplies rhythm. Rows are stored per `(track_id, analyzer_name)`. Descriptors include `chromaVector` (12-bin) and `tempoEvidence` `{ prominence, stability, tempoConf, onGridRatio }`.

Python is **off by default**. Enable with `analysis.engines.python.enabled` and run `tools/analyzer-py/setup.ps1` (Python 3.12 venv). The product runs without it.

essentia.js was rejected: unmaintained since 2021, AGPL, Node was the slowest environment in the authors' benchmarks, WASM heap OOM on full tracks, ML path needs native tfjs-node.

## BPM and grids

- Tempo is folded into **160–190 BPM** (half/double time).
- On real crates, DSP tempo is a grid/structure hint. Mix planning still uses canonical BPM (**manual > published > analyzed**).
- Grids are tracked from onset strength, then downbeat-phased. Beat times follow the tempo comb (offset from the time-domain onset fit) with parabolic interpolation when the local peak is within 0.15 of a period. A manual `beatAnchorMs` still biases downbeat phase.
- Confidence is a 3-feature logistic on prominence, stability, and grid-vs-rival score. There is no 0.55 floor. Confidence below **0.6**, or a tempo that cannot fold into range, **rejects** the grid. Re-fit weights with `node ./node_modules/tsx/dist/cli.mjs tools/scripts/calibrate-confidence.mts --config dnb-crate.config.json` after onset/tempo changes. Crate rows that would drop accepted-correct are not pasted blindly.
- When the track has a published or manual BPM, the analyzer also fits phase at that **reference tempo**. If the free grid is rejected or disagrees by more than 0.5 BPM, a passing logistic at the reference is stored as `gridSource: "reference"` (`bpm` = reference, `bpmRaw` = free estimate). A failing reference fit rejects the grid (`"Reference tempo … does not fit"`); a free grid that disagrees with published BPM is never accepted. `set_beat_anchor` stores `gridSource: "anchor"`. Canonical BPM/key values are unchanged.
- Phrase-mix / bass-swap renders use downbeat-phase alignment in **output time** (`downbeatOffsetMs`, `alignmentPeriodMs`, `alignmentMode` on the manifest). `alignmentMode` is `bar` when both downbeat confidences are ≥ 0.5, otherwise `beat`. The mix itself is a 3-band preset (`expandPreset`); plan `parameters` carry `crossoverHz`, `swapAtBar`, `lowHandoverBar`, `rampMs`, `lowAttenuationDb`, `midDipDb`.

## Planner tempo matching

When both tracks have an accepted grid and their canonical BPMs are within ±3%, `create_set_plan` picks `phrase_mix` or `bass_swap` from the **join** (incoming head is a drop, or `headEnergy ≥ 0.6 ×` drop energy, or both tail/head are hot). Sections missing falls back to track energy. 32 bars when the incoming intro or outgoing outro/breakdown is ≥ 28 bars. Both `playbackRate`s move toward a shared target. If the pair cannot lock within ±3%, the join is an **8 s** `crossfade` (`tempo-out-of-range`) at the mix-out/mix-in. Missing grids keep the 30 s crossfade.

A track that is incoming from pair *i−1* keeps that rate when it is outgoing to pair *i+1*; the next target is recomputed from effective BPM (`canonicalBpm × rate`). `update_set_plan.setPlaybackRate` still wins on rebuild. Transition `parameters` record `{ targetBpm, barCount, reason }`.

`tempoStability` in the analysis row is the MAD of windowed BPM estimates (0–1, higher is more stable). It is an input to confidence, not a second gate.

## Sections and cues

Bars are anchored at the first downbeat when the grid is accepted. DSP labels `intro | build | drop | breakdown | bridge | outro` from 4-bar novelty peaks (8-bar minimum, merged same-type neighbours, confidence from the boundary margin). Cues (`intro_start`, `drop`, `breakdown`, `outro_start`) are derived from sections: breakdown is the first breakdown after the first drop; `outro_start` only exists when an outro section exists.

Analyzer-inserted cues never overwrite a manual cue of the same type. The transition planner treats `source === "analyzed"` cues as **inferred** (reasons, not blockers). Outgoing mix-out never uses `drop`; incoming `drop` is only used for `bass_swap` when `allowDropIn` is true.

Silence bounds come from RMS over 50 ms frames. Leading/trailing runs below **−50 dBFS** lasting ≥ **500 ms** set `descriptors.audioStartMs` / `audioEndMs`. Bars and section labels stop at `audioEndMs`. A last section with `sectionEnergy < 0.02` is dropped (not labelled `outro`).

`create_set_plan` and `plan_transition` share `planning/cues.ts`: manual `outro_start` → energetic outro → last energetic breakdown → last eight downbeats → `audioEnd − overlap` (and the incoming mirror: manual intro → intro → first downbeat → `audioStart`). Candidate sections need `sectionEnergy ≥ 0.05`. If `mixOut + overlap` would pass `audioEndMs`, the mix-out snaps back to the previous downbeat. Playable windows grow toward `audioStartMs` when they would otherwise fall below 90 s; they never extend past `audioEndMs`.

## Transition templates

| Template     | Behaviour |
| ------------ | --------- |
| `crossfade`  | Equal-power `acrossfade` (`hsin`). No grid required. |
| `phrase_mix` | 16 or 32 bars at target BPM. Incoming mids/highs fade in through a **250 Hz** high-pass. |
| `bass_swap`  | Split at **120–250 Hz** (default 180). Highs acrossfade; lows swap at bar 8/16. |

`create_set_plan` picks `bass_swap` / `phrase_mix` / `crossfade` from grids, ±3% tempo, section lengths, and energy (including `suggestedEnergy` when manual energy is missing), then tempo-matches aligned pairs as above.

Tempo matching uses FFmpeg **`atempo`**. Playback rate is **±3%** unless `allowExcessiveTempo`.

`double_drop` remains later work (rendered as `bass_swap` with a warning if it appears on a plan).

## CLI

```bash
pnpm cli analysis:start --track-id UUID --wait
pnpm cli analysis:get --track-id UUID
pnpm cli analysis:compare --track-id UUID
pnpm cli analysis:report
pnpm cli analysis:gate [--engine dsp|beat-this] [--previews]
pnpm cli analysis:cue-preview --track-id UUID --cue drop
pnpm cli transition:plan --from UUID --to UUID --bars 32
```

`analysis:gate` re-analyses every track with `bpmSource` `published` or `manual` and prints `get_analysis_report` (in-range vs out-of-range split). Optional `--previews` renders drop cue previews.
