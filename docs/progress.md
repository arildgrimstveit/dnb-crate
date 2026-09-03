# Progress

## Mixing v4 — baseline (2026-09-03)

Live crate after the v3 whole-library pass. Docs that still say **583** tracks are stale; `library:stats` now reports **431** (430 FLAC, 1 MP3, 34.5 h). The drop is a later library/dedupe pass, not an analysis regression.

- Tracks **431**, analyzed **431 / 431**. DSP `dnb-crate-dsp@3.0.0`: accepted **209**, rejected **213**, reference **9**, `bpmHintOnly` **73**. Envelope 1.0.0: 11 leftover rows.
- BPM source: published 140, analyzed 153, NULL 138. Key source: manual 8, analyzed 216, NULL 207.
- Energy / rating / moods: **0**. Enrichment: genres 376, isrc 399, label 409, releaseDate 431, recordingMbid 415, `duplicateGroups` 1.
- Descriptor p10 / p50 / p90: energy 0.438 / 0.714 / 0.825; danceability 0.269 / 0.472 / 0.656; valence 0.224 / 0.346 / 0.649; acousticness 0.107 / 0.167 / 0.686; melodicness 0.025 / 0.055 / 0.143.

`render:check` v2 on Peak v3.3 job `558bf742-56ed-412a-aaf5-d7f3f834fde6` (`output/renders/hour-peak-v3.3.flac`, duration **3583076** ms). Exit **1**. `interiorSilence: []`. Every join `alignmentMode: beat`, `gainDb` 0, `exitKind` null. Fail gates: residual > 40 ms or |level step| > 3 LU.

| # | Join | Bars | Residual ms | Level step LU | Camelot | mixOut / mixIn ms | LUFS out→in | Fail |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| 0 | Under The Waves → Chant | 16 | 0 | −1.0 | 0 | 264868 / 247 | −9.0 → −7.7 | |
| 1 | Chant → Let The Story Begin | 16 | 23 | −4.6 | 1 | 215419 / 1000 | −7.7 → −8.4 | level |
| 2 | Let The Story Begin → Let It Fall | 32 | 0 | −0.9 | 0 | 248604 / 209 | −8.4 → −7.5 | |
| 3 | Let It Fall → Inemuri | 16 | 0 | −2.8 | 0 | 260893 / 342 | −7.5 → −7.6 | |
| 4 | Inemuri → Calling for a Sign | 16 | 0 | −1.9 | 0 | 237582 / 342 | −7.6 → −5.6 | |
| 5 | Calling for a Sign → Dreamweaver | 32 | 0 | +0.6 | 1 | 186551 / 110 | −5.6 → −9.0 | |
| 6 | Dreamweaver → Breathe In | 16 | 0 | −2.3 | 0 | 231834 / 342 | −9.0 → −7.6 | |
| 7 | Breathe In → Hold on a While | 16 | 0 | −1.7 | 0 | 244481 / 81 | −7.6 → −7.4 | |
| 8 | Hold on a While → Red Velvet | 16 | 0 | −8.2 | 0 | 176633 / 52 | −7.4 → −7.4 | level |
| 9 | Red Velvet → Moment to Moment | 16 | **343** | −4.0 | 1 | 220742 / 0 | −7.4 → −8.3 | residual + level |
| 10 | Moment to Moment → Colour Me In | 32 | **343** | −0.6 | 1 | 228967 / 0 | −8.3 → −7.7 | residual |
| 11 | Colour Me In → Until The End | 16 | 0 | −10.8 | 0 | 242756 / 175 | −7.7 → −8.0 | level |
| 12 | Until The End → Tidal Wave | 32 | 0 | −1.1 | 0 | 193278 / 173 | −8.0 → −7.7 | |
| 13 | Tidal Wave → Streamline | 32 | 0 | −4.6 | 0 | 110518 / 177 | −7.7 → −10.3 | level |
| 14 | Streamline → Vapourise | 32 | 0 | −1.1 | 0 | 278796 / 179 | −10.3 → −8.9 | |

The two **343 ms** residuals are one beat (`alignmentPeriodMs` 345) on joins whose mix-in is source 0 — the `applyAlignmentOffset` +1-period path. Joins 2 and 14 report `lowOverlapSec` 44.14 (section-energy proxy: both sides hot). Plan: `docs/plans/mixing-v4-handover.md`.

### WP0 shipped

Plan file, crate-count refresh (431), manifest join fields (`barCount`, `phraseShape`, `exitKind`, mix windows, LUFS, Camelot), `render:check` v2 (residual, level step, low-overlap proxy, key distance). `parseEbur128` now takes the Summary `I:` so 10 s windows are not read as the first momentary −70 LUFS line.

### WP1 shipped

`gainDb = clamp(setMedianLufs − trackLufs, −6, +3)`. Missing LUFS stays 0 with `levelMatchWarning`. Non-zero manual gain survives `--replan`.

### WP2 shipped

Phrase-anchored windows (`packages/catalog/src/planning/windows.ts`): drop-anchored mix-in, phrase-boundary mix-out, `exitKind` `quietTail` / `dropLanding`, new `landing` shape, sequential mid/high start 2 bars before mid-phrase, no +1-period alignment nudge, `alignmentMode: phrase` when both drops sit on 8-bar multiples, `:curve=hsin` on partial ramps.

Peak v3.4: plan `5c5121fb-…`, job `ed06f32f-…`, `output/renders/hour-peak-v3.4.flac`. `render:check` v2 exit **0** (residuals 0; gain-corrected LUFS within 3 LU). Duration **2214820** ms. Ear-check pending in `docs/mixing-lessons.md`.

| # | Join | Bars | Shape | Exit | Residual | Arr. step LU | Mode |
| --- | --- | ---: | --- | --- | ---: | ---: | --- |
| 0 | Under The Waves → Chant | 32 | complementary | quietTail | 0 | +0.4 | phrase |
| 1 | Chant → Let The Story Begin | 8 | sequential | quietTail | 0 | +7.6 | phrase |
| 2 | Let The Story Begin → Let It Fall | 8 | landing | dropLanding | 0 | −0.4 | phrase |
| 3 | Let It Fall → Inemuri | 16 | sequential | quietTail | 0 | −0.8 | phrase |
| 4 | Inemuri → Calling for a Sign | 8 | landing | dropLanding | 0 | −0.2 | phrase |
| 5 | Calling for a Sign → Dreamweaver | 8 | landing | dropLanding | 0 | −1.0 | phrase |
| 6 | Dreamweaver → Breathe In | 16 | complementary | quietTail | 0 | −0.9 | phrase |
| 7 | Breathe In → Hold on a While | 32 | complementary | quietTail | 0 | −0.3 | phrase |
| 8 | Hold on a While → Red Velvet | 32 | complementary | quietTail | 0 | −0.3 | phrase |
| 9 | Red Velvet → Moment to Moment | 32 | complementary | quietTail | 0 | +1.2 | phrase |
| 10 | Moment to Moment → Colour Me In | 8 | sequential | quietTail | 0 | −7.9 | beat |
| 11 | Colour Me In → Until The End | 8 | sequential | quietTail | 0 | −2.7 | beat |
| 12 | Until The End → Tidal Wave | 8 | landing | dropLanding | 0 | +0.9 | phrase |
| 13 | Tidal Wave → Streamline | 32 | landing | dropLanding | 0 | −1.4 | phrase |
| 14 | Streamline → Vapourise | 16 | sequential | quietTail | 0 | −0.9 | phrase |

## Crate v3 — baseline (2026-09-03)

`library:stats` before WP1–WP5. Live crate, no re-analysis.

- Tracks **583** (582 FLAC, 1 MP3), 47.5 h, 87 artists.
- Analysis: **14 / 583** complete, 569 `not_analyzed`. DSP 2.1.0: accepted **5**, rejected **8**, reference **1**. Envelope 1.0.0: 14 rows.
- BPM source: published 14, NULL 569. Key source: manual 9, analyzed 3, NULL 571.
- Energy / rating / moods / tags / subgenres: **0**. Enrichment fields (isrc, label, releaseDate, recordingMbid, genres, duplicateGroups) report 0 until WP3.
- File tags (not yet in the catalog): ISRC 122, label 115, genre 491, date 582, MusicBrainz IDs 30.

### WP1 shipped

Analysis scopes (`unanalyzed` / `stale` / `all` / `planningReady`), `reference_bpm`, decode/ebur128 prefetch, 2/3–3/2 fold, integer published tolerance 1.0 BPM, `bpmHint` on rejected in-range rows, CLI `analysis:run`.

### WP2 shipped

Descriptor pack on the DSP path (`energy`, `danceability`, `acousticness`, `melodicness`, `valence`), `shortTermLufs*` from 3 s RMS, analyzer **3.0.0**. `scope: stale` now selects every 2.1.0 row. Suite 19 files / 133 passed.

## Crate v3 (2026-09-03)

Whole-library analysis, enrichment, descriptor retune, and two hours from the full crate.

### WP0–WP4

Coverage stats, analysis scopes, descriptor pack 3.0.0, MusicBrainz/Deezer/AcoustID enrichment, planner descriptor/genre/dedupe filters. See the headings above and `docs/plans/crate-v3-handover.md`.

### WP5 whole-library run

- `library:scan` then `analysis:run --scope stale` (first 3.0.0 pass): **583 / 583** in **27.4 min**, `failedTrackIds: []`. Accepted **292**, rejected **290**, reference **1**, `bpmHintOnly` **102**.
- Descriptor p10 / p50 / p90 before retune: energy 0.531 / 0.690 / 0.760 (spread **0.228**); danceability 0.273 / 0.485 / 0.673; valence 0.228 / 0.345 / 0.649; acousticness 0.047 / 0.074 / 0.282; melodicness 0.024 / 0.052 / 0.136; subBass 0.522 / 0.540 / 0.578; brightness 0.061 / 0.095 / 0.123.
- Energy and acousticness were stretched once (constants dated 2026-09-03). Melodicness stayed on key-confidence (chromaClarity ranks noise above the crate; key-confidence calibration is deferred). After stretch: energy 0.479 / 0.721 / 0.832 (spread **0.353**); acousticness 0.106 / 0.163 / 0.602.
- Enrichment: first pass hit MusicBrainz ISRC HTTP 400 (`inc=release-groups+genres+tags`) and never reached AcoustID. After the ISRC 4xx fall-through, URL-safe chromaprint parse, 120 s fingerprint window, and AcoustID accept (score ≥ 0.85 + remix tokens + duration ≤ 6 s): **555 / 583 matched** (file-tags 30, isrc 38, acoustid 134, search 353), unmatched 28, needsReview 6, published BPM written 152, disagreements 29, `duplicateGroups` 151. `library:stats` metadata: genres 499, isrc 547, label 554, releaseDate 583, recordingMbid 555, bpm published 187 / analyzed 210 / NULL 186.
- `analysis:run --scope stale` after enrichment: **173** tracks, **5.8 min**, 0 failed (new published BPM reference grids).
- `analysis:gate`: in-range accepted **80/117** exact **79**, `gridSource` `{"analyzed":585,"reference":12,"anchor":0}`.
- `calibrate-confidence.mts --config dnb-crate.config.json`: keep existing logistic weights and `MIN_ANALYSIS_CONFIDENCE` **0.6**. Fitted unconstrained MIN 0.962 would drop accepted-correct from 79 to 4. Prominence weight on the fitted curve went negative; not adopted.

### Hours

Join-by-join ear-check, keep-list, and mix rules for later hours: **`docs/mixing-lessons.md`**.

- **Liquid hour v3** plan `c93a9f56-…` — 12 tracks, **12** outside the original 14, **11** canonical artists. Brief: exclude idm/ambient/rock; `melodicness.min` **0.12** (crate p80; 0.55 matches zero rows); energy 0.35–0.7; arc 4 → 7 → 5; seed 3. Job `abeb7577-…`, `render:check` exit **0**, `interiorSilence: []`, duration **4001988 ms** (~66:42, +402 s vs target). Copy `output/renders/hour-liquid-v3.wav` (sha256 `abb8021e…`). Did not overwrite older hours. **Ear-check pass: all transitions nice.** Almost every join is a crossfade (only 1→2 is phrase mix).
- **Peak hour v3** plan `5cb141aa-…` — 16 tracks, **15** outside the original 14 (Tidal Wave is the one overlap), **10** canonical artists. Brief: energy ≥ 0.7, danceability ≥ 0.6, arc 6 → 9 → 7, seed **6** (seed 5 failed `render:check` on a 2 s quiet hole). Duration **3583076 ms** (~59:43) on every Peak copy. Did not overwrite older hours.
  - 6.0.0 job `2eff4a40-…` → `hour-peak-v3.wav` (sha256 `ce578306…`). Ear-check fail: pairwise phrase-mix re-filtered the mix so far (LUFS **−17.9**).
  - 6.1.0 job `49a99d77-…` → `hour-peak-v3.1.wav` (sha256 `3ce67316…`), LUFS **−14.9**, TP **−1.2**. First detailed listen (kit clash at 12:08, sudden drops, Technimatic run perfect, later 32-bar squash).
  - 6.2.0 publishes FLAC; older liked hours stay WAV.
  - 6.3.0 job `70135278-…` → `hour-peak-v3.2.flac` (sha256 `44088df9…`), LUFS **−14**, TP **−2.5**. Complementary mid/high: sudden drops and compression fixed; 12:08 still two kits.
  - **6.4.0 job `558bf742-…` → `hour-peak-v3.3.flac`. Sequential drums on Story Begin → Let It Fall only. User accepted this copy.** Mix tags remuxed in 6.5.0 (audio unchanged; sha256 `72a6dd84…`).

## Mixing v2.2 (2026-09-03)

Set plans now consume analysis: mix windows from mix-in/mix-out + silence bounds, beat-or-bar alignment, reference grids, 3-band presets, and join type from head/tail energy. WP0–WP6 notes sit below.

### Gate

`analysis:gate in-range accepted 5/9 exact 5 gridSource {"analyzed":27,"reference":1,"anchor":0}` (DSP; stored after WP3; not re-run for this heading).

- In-range accepted **5/9**, exact **5**. WP3 target ≥ 8/9 is **not** met — fixtures and MIN 0.6 win; crate-fit weights were not pasted.
- Exact 174 accepted: Coming Down (0.947), Basic Instinct (0.748), Witchcraft (0.924), Turn Up the Bass (0.751), Tidal Wave (0.914). All `gridSource: "analyzed"`.
- Rejected in-range: Last Jungle (0.582), Departure (0.28), It Must Be (0.467), Like a Memory (free 175 vs published 176; reference 176 did not accept; `bpm` null).
- Complicated: **rejected** (published 125, OOR; not a folded wrong-tempo accept).
- Alone: `gridSource: "reference"` at **124** (OOR).
- No accepted in-range grid disagrees with published by > 0.5. Turn Up is listed as a disagreement only because the envelope row is 176 vs DSP 174.
- `gridSourceCounts` includes envelope rows as `analyzed` (14 envelope + 13 DSP analyzed + 1 reference = 28).

### Hour A/B

- Plan `281f09aa-5b07-455c-94fc-efc50624de24` “DnB hour (v2.2)” — `plan:clone --replan` of liked `0e2b79c6-…`
- Job `70606110-a320-4435-8c84-e3122bdfb422`, succeeded, **no** `--allow-low-confidence`
- `output/renders/hour-mix-v2.2.wav` sha256 `05f97db9d1f5ebb47d442e34fd20b8d6a9042b76d0c7d139be4a4235304a7f89` (same bytes as the job wav). Do not overwrite `hour-mix-old.wav` / `hour-mix-v2.1.wav`.
- Duration **3335606 ms** (~55:35). LUFS **−14**, true peak **−3.5**. Renderer **6.0.0**. Mix-wide −4.10 dB.
- `render:check` exit **0**, `interiorSilence: []`, no `windowInSilence`.
- Aligned joins report `alignmentMode: "beat"` (stored `downbeatConfidence` < 0.5). Bar mode is unit-tested, not exercised on this hour.

Joins:

- 0 Alone → Complicated — `crossfade` 30 s (`tempo-or-grid-mismatch`; 124 vs 125, Complicated grid rejected)
- 1 Complicated → Tidal Wave — `crossfade` **8 s** (`tempo-out-of-range`), overlap **490753 ms**
- 2 Tidal Wave → Coming Down — `phrase_mix` 32, beat align, offset 0, overlap 601098
- 3 Coming Down → Witchcraft — `phrase_mix` 16, beat align, offset **1 ms**, overlap **842486**
- 4 Witchcraft → It Must Be — `crossfade` 30 s (It Must Be grid rejected)
- 5 It Must Be → Turn Up the Bass — `crossfade` 30 s
- 6 Turn Up the Bass → Like a Memory — `crossfade` 30 s, mix-out **198623**, overlap **1438342** (not 27:06 / 1626 s)
- 7 Like a Memory → Departure — `crossfade` 30 s
- 8 Departure → Last Jungle — `crossfade` 30 s
- 9 Last Jungle → Basic Instinct — `crossfade` 30 s
- 10 Basic Instinct → Falling Down — `crossfade` **8 s** (`tempo-out-of-range`)
- 11 Falling Down → Saint Angel — `crossfade` **8 s** (`tempo-out-of-range`)
- 12 Saint Angel → Angel — `crossfade` 30 s

Ear-check (2026-09-03), hour `hour-mix-v2.2.wav` plus the two standalone previews. Overall **definitely better** than v2.1.

- Witchcraft → Tidal Wave `bass_swap` preview — **very good** (job `bd8c72e2-…`, sha256 `7bba62b0…`; planner type on this pair is `phrase_mix`, preview forced `bass_swap` 16). Did not overwrite `witchcraft-tidal-wave-bass-swap.wav`.
- Coming Down → Witchcraft — hour **okay** / preview **pretty good** (job `16fb2e60-…`, sha256 `4dbc5491…`).
- Complicated → Tidal Wave — **pairing fail**. 8 s cut is not the complaint; Complicated outro + Tidal Wave intro do not match. Preferred Tidal Wave in is the Witchcraft `bass_swap`.
- Tidal Wave → Coming Down — Tidal Wave **fades early**; vocals still going when Coming Down starts (`phrase_mix` 32, mix-out 110518).
- Witchcraft → It Must Be — **good**, but Witchcraft **fades a bit early** (30 s crossfade, mix-out 165554).
- It Must Be → Turn Up the Bass — **amazing**.
- Turn Up the Bass → Like a Memory — **very very good**; dead air gone.
- Like a Memory → Departure — **very good**.
- Departure → Last Jungle — **very good**.
- Last Jungle → Basic Instinct — **good**.
- Basic Instinct → Falling Down — **good**.
- Falling Down → Saint Angel — **okay**; tracks do not fit well together.
- Saint Angel → Angel — **quite perfect**.

Missing-grid + tempo-mismatch joins now use 8 s (Complicated → Tidal Wave; Basic Instinct → Falling Down; Falling Down → Saint Angel). Matching-tempo missing grids stay 30 s.

- `vitest run` — 18 files, **116 passed**; `tsc --noEmit` clean

## Mixing v2.2 — baseline (2026-09-03)

Harness only. `plan:clone --replan` rebuilds entries from current analysis; `render:check` flags interior silence (`-50 dB`, ≥ 1 s, not the first/last 500 ms) and per-join `windowInSilence`.

Reference artifacts (do not overwrite):

- Liked plan `0e2b79c6-4b8e-4b49-99f0-53aa1d6f4a56` — Alone → … → Angel, seed 1
- `output/renders/hour-mix-old.wav` — job `4385ca7f-…`, 56:09, sha256 `61ae9203…`
- `output/renders/hour-mix-v2.1.wav` — job `165c2a73-…`, 58:58, sha256 `55e29579…`, interior silence 1626.5–1628.5 s (Turn Up the Bass → Like a Memory)
- Liked preview `output/previews/witchcraft-tidal-wave-bass-swap.wav`

WP0 proof (2026-09-03): clone `7b99c6fa-6c20-497d-9de8-5241d1d54d29` “v2.2 baseline”, job `97061c12-46d2-4dbc-801e-fb6634aa983a`, sha256 `55e29579…` (byte-identical to v2.1). `render:check` exit 1 — interior silence `1626534–1628524` ms (1990 ms) at join 6 Turn Up the Bass → Like a Memory (`bass_swap`, overlap `1626473`). After WP1 the same check must pass.

## Mixing v2.2 — WP1 windows (2026-09-03)

Silence bounds on descriptors; shared `planning/cues.ts`; `buildEntries` windows from mix-out/mix-in; `applyTransition` keeps the outgoing start; `WINDOW_IN_SILENCE` warn/block.

- `vitest run` — 17 files, **97 passed**; `tsc --noEmit` clean
- Clone `2d733300-d0d6-48e1-8ec6-a6ec0bfda61a` “v2.2 wp1”: Turn Up mix-out **198623 ms** (breakdown), source end 220692 (was 264840)
- Job `11f9d1d6-5a99-4dc9-91b0-c55f377674ab`, sha256 `0a3f651c…`, 53:22. `render:check` exit **0**, interior silence none. Join 6 overlap now 1414078 ms (no 27:06 dead air).

## Mixing v2.2 — WP6 join type and short crossfade (2026-09-03)

Type from head/tail sections (drop / head ≥ 0.6 × drop / both hot). Tempo mismatch with grids → **8 s** crossfade. WP7 also shortens missing-grid + tempo-mismatch joins to 8 s; matching-tempo missing grids stay 30 s.

- `vitest run` — 18 files, **115 passed**; `tsc --noEmit` clean

## Mixing v2.2 — WP5 3-band mixer (2026-09-03)

`expandPreset` + `buildBandMixFilter` (`asplit=3`, `amix=inputs=6`, `afade` unity/silence). `RENDERER_VERSION` **6.0.0**.

- `vitest run` — 18 files, **111 passed** (includes FFmpeg bass_swap low-band drop ≥ 12 dB and 3-band sum < 0.5 LU)
- `tsc --noEmit` clean
- Manifest automation includes `outgoing_mid`. Fake runner advertises `hasAfadeUnity`.

## Mixing v2.2 — WP3–WP4 reference grids and calibration (2026-09-03)

WP3: published/manual BPM is a phase reference. Free grids that miss or disagree by > 0.5 are replaced only when the reference comb clears the logistic. `gridSource` is `analyzed` | `reference` | `anchor`. Migration `007_grid_source`.

- `vitest run` — 17 files, **106 passed**; `tsc --noEmit` clean
- Wrong reference (150 on 174, 170 on a 174 click) rejected; sparse 174 clicks recover via `gridSource: "reference"`

WP4: crate calibration script reads stored `tempoEvidence` (14 published/manual rows). Unconstrained MIN 0.795 would drop accepted-correct 5→1 (Like a Memory 175 vs 176). **Kept MIN 0.6 and existing weights.**

## Mixing v2.2 — WP2 bar alignment (2026-09-03)

`downbeatAlignmentOffsetMs` returns `{ offsetMs, periodMs, mode }`. Bar wrap when both downbeat confidences ≥ 0.5; otherwise beat. Negative nudges at start 0 add one period.

- `vitest run` — 17 files, **103 passed**; `tsc --noEmit` clean
- Re-render of WP1 plan: job `90eb6e1d-a66b-488e-873a-004a1ebbc72e`, `render:check` exit 0. Aligned joins report `alignmentMode: beat` (stored downbeatConfidence < 0.5). Bar mode is covered by unit tests (2-beat Δ no longer wraps to 0).

## Analysis v2.1 — grids to mixes (2026-09-02)

What works:

- Planner tempo-matched `phrase_mix` / `bass_swap` (canonical BPM, shared target, chain-stable rates; fallback `crossfade` with `tempo-out-of-range`)
- Comb-locked sub-hop beat times; downbeat alignment in output time (`alignmentPeriodMs` on the manifest)
- Key v2: spectral-peak chroma 165–3520 Hz, tuning, harmonic suppression, KK+Temperley
- Tempo confidence logistic (no 0.55 floor); reject below **0.6**
- Downbeat-anchored sections (8-bar minimum, merged labels, two-drop / drop-ending fixtures)
- Analyzer cues are inferred in `plan_transition` (reasons, not blockers); mix-out never uses drop
- `get_analysis_report` splits in-range vs out-of-range; CLI `analysis:gate`
- Optional Python sidecar timeout + `--input` batching (install/comparison skipped)

Evidence (2026-09-02, Node 24, Windows):

- `node ./node_modules/vitest/vitest.mjs run` — 17 files, **90 passed**
- `tsc --noEmit` — passed
- `analysis:gate` (DSP only; 14 published-BPM tracks; in-range = published 160–190):
  - In-range **9**, out-of-range **5** (124 / 125 / 140 / 159 / 159)
  - **6/9** in-range DSP BPM within 0.5 of published (same count as the v2.0 baseline)
  - Accepted exact 174: Coming Down, Basic Instinct, Witchcraft, Turn Up the Bass, Tidal Wave. Departure still estimates 174 but is rejected (confidence 0.28 — the old 0.55 floor was hiding this). Last Jungle 160 rejected at 0.58. Like a Memory 175 vs 176 (accepted). It Must Be 175 rejected.
  - No confidence plateau at 0.55. No accepted in-range grid at a wildly wrong tempo (Last Jungle is rejected).
  - Keys no longer collapse to F/Dm: Gm×3 is the mode; others unique or pairs. Target ≤3 tracks sharing one key holds.
- Default engine remains **`dnb-crate-dsp`**. Mix tempo still uses published/manual canonical BPM.
- Target in-range exact ≥ 8/10 is **not** met; synthetic fixtures are green. Python `beat-this` comparison not run.
- Ear-check (2026-09-02): drop cues correct on Basic Instinct, Angel, Witchcraft, Tidal Wave. Witchcraft → Tidal Wave `bass_swap` passed (no low-end phasing at the swap bar).

## Stage 5 — Analysis v2 + mix intelligence

What works:

- `dnb-crate-dsp` 2.0: spectral-flux onsets, tempogram, DP beats, downbeats, chroma key with mode, sections, descriptors, suggestedEnergy
- Optional Python sidecar (`beat-this` / `allin1`) behind the same result shape; merger keeps DSP key/descriptors
- Per-engine `track_analyses` + `track_sections`; provenance **manual > published > analyzed > tag**
- Planner auto-selects phrase_mix / bass_swap / crossfade from grids and section lengths
- Transition planner uses section/downbeat windows; `<=` overlap bug fixed
- Renderer downbeat-phase alignment (`downbeatOffsetMs` on the manifest)
- Scoring uses suggestedEnergy fallback + structure compatibility; search filters for sub-bass/brightness
- MCP: `compare_track_analyses`, `get_track_sections`, `get_analysis_report`, `create_cue_preview`

Evidence (2026-09-02, Node 24, Windows):

- `vitest run` — 17 files, **70 passed**
- `tsc --noEmit` — passed
- Crate gate (14 store-lookup BPMs, retagged `bpmSource: published`, DSP only; Python sidecar not installed):
  - **6/14** DSP BPM within 0.5 of the stored published value
  - **6/9** exact 174 on tracks whose published BPM is 174 (Coming Down, Basic Instinct, Witchcraft, Turn Up the Bass, Tidal Wave, Departure)
  - 4 published values are outside DnB range (124 / 125 / 140 / 159), so 12/14 vs raw published is not a DSP-quality metric
  - 10 drop cue previews in `output/previews/`
- Default engine remains **`dnb-crate-dsp`**. Mix tempo still uses published/manual canonical BPM.

## Stage 4 — complete (automated gate)

What works:

- `@dnb-crate/audio-analysis`: envelope BPM/grid, half/double fold into 160–190, rejected low-confidence grids, click-track fixtures
- Analysis jobs (`queued` / `running` / `succeeded` / `failed`); interrupted jobs marked failed/retryable
- Manual BPM/key/cues override analysis without deleting the analysis row
- `plan_transition` / `validate_transition`; `update_set_plan.applyTransition` and `setPlaybackRate`
- Renderer: `atempo` tempo matching (±3%), `phrase_mix` (high-pass fade-in), `bass_swap` (bounded crossover/ramp). Pairwise mix when templates are not a single acrossfade chain
- Aligned renders blocked on missing/low-confidence grids unless `allowLowConfidence`
- MCP tools: `start_track_analysis`, `get_analysis_status`, `get_track_analysis`, `plan_transition`, `validate_transition`; resource `dnbcrate://tracks/{trackId}/analysis`
- CLI: `analysis:*`, `transition:plan`, `transition:validate`

Evidence (2026-08-31, Node 24.16.0, Windows):

- `pnpm test` — 13 files, **56 passed**, 2 skipped (real-FFmpeg crossfade + atempo pitch tests: ffmpeg/ffprobe were not on PATH)
- Fake-process coverage: click-track grids, half-time fold, rejected sine/noise grids, manual BPM over analysis, aligned-render fail-closed, Stage 3 render regressions, MCP 26-tool list
- `pnpm typecheck` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed

## Stage 3 — complete (automated gate)

Equal-power WAV rendering, jobs, previews, manifests. Still passing as regressions (crossfade path unchanged).

## Stage 2 — complete (automated gate)

Cue points, deterministic planner, set-plan resources. Still passing.

## Stage 1 — complete (automated gate)

Catalog, scanner, search, CLI, MCP stdio. Still passing.

## Known limitations (through Stage 4)

- Envelope analyzer is click-track accurate; real-music grids are advisory (superseded by `dnb-crate-dsp`, still true for legacy envelope rows)
- Key estimation is weak on broadband material (DSP chroma is the v2 path)
- Listening QA for phrase mixes / bass swaps / long mixes is not in `manual-test-log.md` (no FFmpeg on the implementation machine)
- `double_drop` remains later work
- Fingerprint is size + first/last 64 KiB
- Apps run from TypeScript via `tsx`

## Next

Optional: enable the Python sidecar and compare `beat-this` on the same 14 tracks. Ear-check `output/previews/*-drop.wav`.
