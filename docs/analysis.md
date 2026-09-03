# Analysis and aligned transitions (Stage 5 / v2.1)

Automatic analysis is **advisory**. Every BPM, key, downbeat, section, and suggested cue has confidence and provenance. Manual values always win without deleting the analysis row.

Canonical BPM/key precedence: **manual > published > analyzed > tag**.

## Engines

| Engine | Runtime | What it produces |
| --- | --- | --- |
| `dnb-crate-dsp` 3.2 (default) | TypeScript in-process | STFT spectral-flux onsets, tempogram, comb-locked sub-hop beats, downbeat v2 (kick/sub + snare flux, mod-4 then mod-8, drop/section log-priors, logistic confidence), per-bar features, HPCP chroma key v3 (165–3520 Hz, sub-root prior, clarity-gated confidence), downbeat-anchored sections, sonic descriptors including a same-pass pack (`energy`, `danceability`, `acousticness`, `melodicness`, `valence`) |
| `beat-this` | Optional Python sidecar | Beats / downbeats / tempo (IQR confidence; 180 s timeout) |
| `allin1` | Optional Python sidecar (slow; Demucs) | Beats / downbeats / tempo / section labels (900 s timeout) |
| `dnb-crate-envelope` 1.0 | Legacy | Peak-amplitude envelope; kept for migrated Stage 4 rows |

Key and descriptors always come from `dnb-crate-dsp` even when a sidecar supplies rhythm. Rows are stored per `(track_id, analyzer_name)`. Descriptors include `chromaVector` (12-bin), `tempoEvidence` `{ prominence, stability, tempoConf, onGridRatio }`, and the 3.0 pack below. The pack is **heuristic** (deterministic per file, not a trained model).

### Descriptor pack (analyzer 3.0.0)

Computed in the existing `analyze` pass. Every slider is 0–1. `suggestedEnergy = round(1 + 9·energy)` stays 1–10. `shortTermLufsMean` / `shortTermLufsMax` are 3 s RMS windows in dBFS (a loudness proxy; ebur128 still fills `integratedLufs` later).

| Field | Formula (sketch) |
| --- | --- |
| `energy` | `0.4·loud + 0.3·dropIntensity + 0.3·onsetDensityNorm`, then a 0.25…0.84 → 0.05…0.95 stretch (WP5, 2026-09-03). `loud` maps file RMS dBFS from −24…−8 → 0…1 |
| `danceability` | `0.5·dfa + 0.3·prominence + 0.2·stability` — Essentia-style DFA on a 10 ms frame-stddev envelope after a 180 Hz high-pass (tau 310–8800 ms, ×1.1). Flat envelopes (CV < 0.18) score 0 |
| `acousticness` | STFT sub-band ratio, strong spectral peaks, chroma clarity, and onset density, then a 0.02…0.40 → 0.05…0.85 stretch (WP5) |
| `melodicness` | `2.2·keyConfidence` plus a small spectral-tonal term. The plan’s chromaClarity blend was not adopted: on fixtures, chromaClarity ranks white noise above most crate tracks. Key confidence on this crate still clusters (p90 ≈ 0.05); a 0.55 liquid cutoff matches nobody. |
| `valence` | **Low-confidence.** `0.35·majorness + 0.25·(brightness/0.15) + 0.2·melodicness + 0.2·danceability` |

Reference ranges live in `packages/audio-analysis/src/descriptors.ts` (retuned 2026-09-03). Energy and acousticness were stretched once so crate p10–p90 ≥ 0.3. Melodicness, sub-bass, and brightness were left unstretched so fixture floors stay green (key-confidence calibration is deferred).

Python is **off by default**. Enable with `analysis.engines.python.enabled` and run `tools/analyzer-py/setup.ps1` (Python **3.12** venv + CPU torch). The product runs without it. This crate’s host only has Python 3.14, so beat-this is **not installed** and DSP remains the rhythm source (see `docs/decisions.md`).

essentia.js was rejected: unmaintained since 2021, AGPL, Node was the slowest environment in the authors' benchmarks, WASM heap OOM on full tracks, ML path needs native tfjs-node.

## BPM and grids

- Tempo is folded into **160–190 BPM** (half/double time). If that fold fails or the grid is rejected, the analyzer also scores **2/3 and 3/2** of the raw estimate via the same reference-tempo logistic and adopts an in-range candidate that clears the 0.6 floor. A 3:2 confusion (for example 186 hats over 124 kicks) rejects the in-range accept when the out-of-range partner scores higher — `bpmRaw` keeps the stronger out-of-range candidate and the grid stays rejected. Confidence below **0.6** is never accepted.
- On real crates, DSP tempo is a grid/structure hint. Mix planning still uses canonical BPM (**manual > published > analyzed**).
- Grids are tracked from onset strength, then downbeat-phased. Beat times follow the tempo comb (offset from the time-domain onset fit) with parabolic interpolation when the local peak is within 0.15 of a period. A manual `beatAnchorMs` still biases downbeat phase.
- Downbeat v2 (analyzer **3.1.0**) scores kick/sub positive deltas and snare-band flux (150–400 Hz + 1.5–4 kHz). It searches phase mod 4, then the two 8-beat candidates. First-drop onset and section boundaries add a log-prior for beat 1 (not a `×1.08` scale). Confidence is the mod-4 comb-score margin in σ, mapped through a logistic so synthetic fixtures land ≥ 0.9. Bar-mode alignment still needs ≥ 0.5.
- Per-bar features are persisted on `descriptors.bars` as `{ rms, sub, midFlux, onsetDensity }` arrays (2 decimals). Section `relEnergy` is `sectionEnergy / max drop energy`.
- Confidence is a 3-feature logistic on prominence, stability, and grid-vs-rival score. `tempoEvidence.agreement` is a fourth recorded feature (free fold vs kick/sub comb) used only as a bounded rescue: agreement 1 and logistic ≥ 0.45 can clear the 0.6 floor. There is no 0.55 floor. Confidence below **0.6**, or a tempo that cannot fold into range, **rejects** the grid unless that rescue fires. Re-fit weights with `node ./node_modules/tsx/dist/cli.mjs tools/scripts/calibrate-confidence.mts --config dnb-crate.config.json` after onset/tempo changes. Crate rows that would drop accepted-correct are not pasted blindly. Sidecar rhythm, when present, stores `gridSource: "sidecar"`.
- When the track has a published or manual BPM, the analyzer also fits phase at that **reference tempo**. Integer published BPM tolerates **1.0** BPM of free-grid disagreement (fractional published BPM still uses 0.5). If the free grid is rejected or disagrees beyond that tolerance, a passing logistic at the reference is stored as `gridSource: "reference"` (`bpm` = reference, `bpmRaw` = free estimate). A free grid that lands inside the tolerance stays `gridSource: "analyzed"` (Like a Memory 175 vs published 176). A failing reference fit rejects the grid (`"Reference tempo … does not fit"`). `set_beat_anchor` stores `gridSource: "anchor"`. Canonical BPM/key values are unchanged. The published/manual BPM used for the fit is persisted as `reference_bpm`.
- A rejected grid whose raw estimate still folds into 160–190 with confidence ≥ **0.3** exposes `bpmHint` / `bpmHintConfidence` on the analysis view and timeline. Hints never write `tracks.bpm`. Planning readiness treats a hint as covering the BPM field (`bpmSource: "hint"`). Pool BPM filters (WP4) may use hints at half weight; tempo matching and aligned templates do not.
- Phrase-mix / bass-swap renders use downbeat-phase alignment in **output time** (`downbeatOffsetMs`, `alignmentPeriodMs`, `alignmentMode` on the manifest). `alignmentMode` is `bar` when both downbeat confidences are ≥ 0.5, otherwise `beat`. The mix itself is a 3-band preset (`expandPreset`); plan `parameters` carry `crossoverHz`, `swapAtBar`, `lowHandoverBar`, `rampMs`, `lowAttenuationDb`, `midDipDb`, `phraseShape`.

## Planner tempo matching

When both tracks have an accepted grid and their canonical BPMs are within ±3%, `create_set_plan` picks `phrase_mix` or `bass_swap` from the **join** (incoming head is a drop, or `headEnergy ≥ 0.6 ×` drop energy, or both tail/head are hot). Sections missing falls back to track energy. 32 bars when the incoming intro or outgoing outro/breakdown is ≥ 28 bars. **Caveat (Peak ear-check):** a long drum-heavy intro made Let The Story Begin → Let It Fall worse (44 s of two kits). Sequential phrase-mix is the workaround; do not treat “long intro” as “long blend.” See `docs/mixing-lessons.md`. Both `playbackRate`s move toward a shared target. Tempo mismatch (`|pairRate − 1| > 3%`) is an **8 s** `crossfade` (`tempo-out-of-range`) at the mix-out/mix-in, even when grids are missing. Missing grids keep the 30 s crossfade only when the BPMs already sit within 3%.

A track that is incoming from pair *i−1* keeps that rate when it is outgoing to pair *i+1*; the next target is recomputed from effective BPM (`canonicalBpm × rate`). `update_set_plan.setPlaybackRate` still wins on rebuild. Transition `parameters` record `{ targetBpm, barCount, reason }`.

`tempoStability` in the analysis row is the MAD of windowed BPM estimates (0–1, higher is more stable). It is an input to confidence, not a second gate.

## Sections and cues

Bars are anchored at the first downbeat when the grid is accepted. DSP labels `intro | build | drop | breakdown | bridge | outro` from 4-bar novelty peaks (8-bar minimum, merged same-type neighbours, confidence from the boundary margin). Cues (`intro_start`, `drop`, `breakdown`, `outro_start`) are derived from sections: breakdown is the first breakdown after the first drop; `outro_start` only exists when an outro section exists.

Analyzer-inserted cues never overwrite a manual cue of the same type. The transition planner treats `source === "analyzed"` cues as **inferred** (reasons, not blockers). Outgoing mix-out never uses `drop`; incoming `drop` is only used for `bass_swap` when `allowDropIn` is true.

Silence bounds come from RMS over 50 ms frames. Leading/trailing runs below **−50 dBFS** lasting ≥ **500 ms** set `descriptors.audioStartMs` / `audioEndMs`. Bars and section labels stop at `audioEndMs`. A last section with `sectionEnergy < 0.02` is dropped (not labelled `outro`).

Aligned joins use `planning/windows.ts`: mix-in is drop-anchored (`D_in − B` for `B ∈ {32,16,8}` so the incoming drop lands at overlap end) unless the brief sets `dropAnchored: false`. Mix-out is the latest phrase-grid boundary that fits `B` — a quiet outro/breakdown (`exitKind: quietTail`) or the last phrase inside the final drop (`dropLanding`). `constrainMixOut` only clamps to `audioEndMs`; it never relocates a mix-out into a drop. Mix-in never starts at source 0 (first downbeat instead). Crossfade / no-drop tracks still use `planning/cues.ts` (manual outro → energetic outro → last energetic breakdown → last eight downbeats). Playable windows grow toward `audioStartMs` when they would otherwise fall below 90 s.

## Transition templates

| Template     | Behaviour |
| ------------ | --------- |
| `crossfade`  | Equal-power `acrossfade` (`hsin`). No grid required. Default 30 s; 8 s on tempo mismatch. |
| `phrase_mix` | 8, 16 or 32 bars at target BPM. Complementary: incoming mid/high over the whole overlap; incoming low at bar 12 (24 of 32, 6 of 8). Sequential: incoming mid/high start 2 bars before mid-phrase. Landing (`exitKind: dropLanding`): incoming low stays at −inf until the last bar; outgoing mid/high fade only over the last 8 bars (4 when `B = 8`). |
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
pnpm cli enrich:run --scope unmatched --wait
pnpm cli enrich:status
pnpm cli enrich:report
pnpm cli plan:create --brief-json docs/examples/liquid-hour-v3.brief.json
pnpm cli analysis:cue-preview --track-id UUID --cue drop
pnpm cli transition:plan --from UUID --to UUID --bars 32
```

`analysis:gate` re-analyses every track with `bpmSource` `published` or `manual` and prints `get_analysis_report` (in-range vs out-of-range split). Stderr also prints one line: in-range accepted/count, accepted-exact, `gridSource` counts, and `keyAgreement` counts (exact / relative / number ±1 / clash) against published or manual keys. Optional `--previews` renders drop cue previews.

## Key v3 and the gold set

Chroma is still HPCP in 165–3520 Hz. Key v3 adds a **sub-root prior**: the dominant 35–110 Hz pitch class over drop frames boosts that tonic in both modes (+0.06). Confidence is a logistic of the score-margin z-score, times a clarity gate (`clarity < 0.45` → `clarity * 0.08`) so broadband noise cannot look confident. `keyCandidates` is `[best, runnerUp]`.

`applyAnalyzedMetadata` writes an analyzed canonical key only when `keyConfidence ≥ MIN_KEY_CONFIDENCE` (0.5). Rejected-grid tracks can still get a key. Existing ungated analyzed keys are cleared on the next stale pass. Analysis stays advisory; false “confident” keys are worse than unknown keys.

Melodicness uses the calibrated key confidence: when `chromaClarity < 0.45` the key term is weighted 0.2.

### Gold set (30) — label with `update_track_metadata { musicalKey, keySource: "published" }`

Peak v3 (16): Pendulum — Under The Waves; Logistics — Chant; Sub Focus — Let The Story Begin; Technimatic — Let It Fall; Logistics — Inemuri; Sub Focus — Calling for a Sign; Nu:Logic — Dreamweaver; Technimatic — Breathe In; Technimatic — Hold on a While; Nu:Logic — Red Velvet; Technimatic — Moment to Moment; Technimatic — Colour Me In; Sub Focus — Until The End; Sub Focus — Tidal Wave; Pendulum — Streamline; Sub Focus — Vapourise.

Liquid v3 (12): Form Form — New Element; Goldie — Sensual; Gavin Bryars — Raising the Titanic (Big Drum Mix); JMJ & Flytronic — In Too Deep; Nu:Logic — Pathways (feat. BLAKE); Logistics — Microdot; Maduk, Amanda Collis — Fire Away; Calibre — Feeling Normal; PFM — Danny's Song; Calibre — Say Enough (with DRS); Calibre — Time to Breathe (with Cimone); PFM — One & Only.

Also: Alone; Complicated.

Agreement target: ≥ 70 % on Camelot **number** (relative major/minor counts as agreement). Not measured until those rows are labelled published. On the 3.1.0 pass `key_confidence` p50 is still **0.012** and **0** rows are ≥ 0.5, so the gate writes no new canonical keys until confidence improves or labels exist.
