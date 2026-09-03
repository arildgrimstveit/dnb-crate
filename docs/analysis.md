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

- Tempo is folded into **160–190 BPM** (half/double time). If that fold fails or the grid is rejected, the analyzer also scores **2/3 and 3/2** of the raw estimate via the same reference-tempo logistic and adopts an in-range candidate that clears the 0.6 floor. A 3:2 confusion (for example 186 hats over 124 kicks) rejects the in-range accept when the out-of-range partner scores higher — `bpmRaw` keeps the stronger out-of-range candidate and the grid stays rejected. Confidence below **0.6** is never accepted.
- On real crates, DSP tempo is a grid/structure hint. Mix planning still uses canonical BPM (**manual > published > analyzed**).
- Grids are tracked from onset strength, then downbeat-phased. Beat times follow the tempo comb (offset from the time-domain onset fit) with parabolic interpolation when the local peak is within 0.15 of a period. A manual `beatAnchorMs` still biases downbeat phase.
- Confidence is a 3-feature logistic on prominence, stability, and grid-vs-rival score. There is no 0.55 floor. Confidence below **0.6**, or a tempo that cannot fold into range, **rejects** the grid. Re-fit weights with `node ./node_modules/tsx/dist/cli.mjs tools/scripts/calibrate-confidence.mts --config dnb-crate.config.json` after onset/tempo changes. Crate rows that would drop accepted-correct are not pasted blindly.
- When the track has a published or manual BPM, the analyzer also fits phase at that **reference tempo**. Integer published BPM tolerates **1.0** BPM of free-grid disagreement (fractional published BPM still uses 0.5). If the free grid is rejected or disagrees beyond that tolerance, a passing logistic at the reference is stored as `gridSource: "reference"` (`bpm` = reference, `bpmRaw` = free estimate). A free grid that lands inside the tolerance stays `gridSource: "analyzed"` (Like a Memory 175 vs published 176). A failing reference fit rejects the grid (`"Reference tempo … does not fit"`). `set_beat_anchor` stores `gridSource: "anchor"`. Canonical BPM/key values are unchanged. The published/manual BPM used for the fit is persisted as `reference_bpm`.
- A rejected grid whose raw estimate still folds into 160–190 with confidence ≥ **0.3** exposes `bpmHint` / `bpmHintConfidence` on the analysis view and timeline. Hints never write `tracks.bpm`. Planning readiness treats a hint as covering the BPM field (`bpmSource: "hint"`). Pool BPM filters (WP4) may use hints at half weight; tempo matching and aligned templates do not.
- Phrase-mix / bass-swap renders use downbeat-phase alignment in **output time** (`downbeatOffsetMs`, `alignmentPeriodMs`, `alignmentMode` on the manifest). `alignmentMode` is `bar` when both downbeat confidences are ≥ 0.5, otherwise `beat`. The mix itself is a 3-band preset (`expandPreset`); plan `parameters` carry `crossoverHz`, `swapAtBar`, `lowHandoverBar`, `rampMs`, `lowAttenuationDb`, `midDipDb`.

## Planner tempo matching

When both tracks have an accepted grid and their canonical BPMs are within ±3%, `create_set_plan` picks `phrase_mix` or `bass_swap` from the **join** (incoming head is a drop, or `headEnergy ≥ 0.6 ×` drop energy, or both tail/head are hot). Sections missing falls back to track energy. 32 bars when the incoming intro or outgoing outro/breakdown is ≥ 28 bars. Both `playbackRate`s move toward a shared target. Tempo mismatch (`|pairRate − 1| > 3%`) is an **8 s** `crossfade` (`tempo-out-of-range`) at the mix-out/mix-in, even when grids are missing. Missing grids keep the 30 s crossfade only when the BPMs already sit within 3%.

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
| `crossfade`  | Equal-power `acrossfade` (`hsin`). No grid required. Default 30 s; 8 s on tempo mismatch. |
| `phrase_mix` | 16 or 32 bars at target BPM. Incoming mid/high fade in over the first half; incoming low arrives at bar 12 (24 of 32). Outgoing low steps to −24 dB there, then to −inf. Outgoing mid/high fade out over the second half. |
| `bass_swap`  | Mid/high crossfade across the overlap; outgoing mid dips −6 dB from bar 4. Lows swap at bar 8 (16 of 32) in `rampMs` (default 40). |

`create_set_plan` picks `bass_swap` / `phrase_mix` / `crossfade` from the join (head/tail sections when present; track energy only as fallback), ±3% tempo, and section lengths, then tempo-matches aligned pairs as above.

Tempo matching uses FFmpeg **`atempo`**. Playback rate is **±3%** unless `allowExcessiveTempo`.

`double_drop` remains later work (rendered as `bass_swap` with a warning if it appears on a plan).

## Analysis scopes

`start_track_analysis` / `analysis:run` accept `scope`:

| Scope | Selects |
| --- | --- |
| `ids` (default) | Explicit `trackIds` |
| `planningReady` | Tracks that pass `get_planning_readiness` (BPM, key, energy, file). A `bpmHint` counts as BPM. |
| `unanalyzed` | `analysis_status != complete` and file present |
| `stale` | No DSP row, `analyzer_version` older than current, `analysis_status = failed`, or `reference_bpm` ≠ current published/manual BPM (including null `reference_bpm` when a published/manual BPM exists) |
| `all` | Every non-missing file |

`analysis:start` is unchanged (explicit ids or `--planning-ready`). `analysis:run --scope stale|unanalyzed|all|planningReady [--wait] [--timeout-min N]` is the whole-library entry (default wait timeout 90 minutes). Decode of track *i+1* is prefetched while DSP runs on *i*; ebur128 of *i* overlaps that decode. Config `analysis.prefetch` defaults to 1. Progress logs every 25 tracks. Stopping mid-job marks the job failed and retryable.

## CLI

```bash
pnpm cli analysis:start --track-id UUID --wait
pnpm cli analysis:run --scope stale --wait --timeout-min 90
pnpm cli analysis:get --track-id UUID
pnpm cli analysis:compare --track-id UUID
pnpm cli analysis:report
pnpm cli analysis:gate [--engine dsp|beat-this] [--previews]
pnpm cli analysis:cue-preview --track-id UUID --cue drop
pnpm cli transition:plan --from UUID --to UUID --bars 32
```

`analysis:gate` re-analyses every track with `bpmSource` `published` or `manual` and prints `get_analysis_report` (in-range vs out-of-range split). Stderr also prints one line: in-range accepted/count, accepted-exact, and `gridSource` counts. Optional `--previews` renders drop cue previews.
