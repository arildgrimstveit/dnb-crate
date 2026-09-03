# Mixing lessons from ear-check

Listening notes for improving later hours. Do not paste library paths or secrets. Reference files under `output/` are gitignored — keep them on disk, never overwrite the liked copies listed below.

Session dates: 2026-09-03. Canonical Peak listen copy: **`output/renders/hour-peak-v3.3.flac`**. Canonical Liquid listen copy: **`output/renders/hour-liquid-v3.wav`**.

## What “good” sounds like

- Beat-matched is necessary but not sufficient. Two kits on the same grid still sound noisy.
- A phrase mix should not announce itself. If you can hear the outgoing track drop a step when the overlap starts, the curve is wrong.
- Overlaps must keep punch and detail. If the blend feels squashed, two full-range kits are probably summing into the limiter.
- Pairing still beats template. A clean 8 s cut of two tracks that do not belong together fails; a 30 s crossfade of two tracks that belong together can be “amazing.”
- Liquid can be almost all equal-power crossfades and still sound excellent. Peak needed phrase-mix work because both sides were drum-heavy.

## Keep these files

Do not overwrite:

| File | Why |
| --- | --- |
| `output/renders/hour-peak-v4.flac` | Peak v4 mood hour (phrase-anchored, level-matched). Structural pass; ear-check pending |
| `output/renders/hour-liquid-v4.flac` | Liquid v4 mood hour. Structural pass; ear-check pending |
| `output/renders/hour-peak-v3.4.flac` | Peak v3 order re-planned with phrase windows (plan `5c5121fb-…`, job `ed06f32f-…`). Structural pass; ear-check pending |
| `output/renders/hour-peak-v3.3.flac` | Canonical Peak hour (mix 6.4.0; tags 6.5.0). Closer listen: joins 1–4 rough; from 20:26 much better |
| `output/renders/hour-peak-v3.2.flac` | Complementary-curve A/B (12:08 still bad) |
| `output/renders/hour-peak-v3.1.wav` | First listenably mixed Peak (6.1.0); source of the join-by-join notes |
| `output/renders/hour-peak-v3.wav` | Broken pairwise mash (6.0.0); LUFS −17.9 |
| `output/renders/hour-liquid-v3.wav` | Accepted Liquid hour; all transitions nice |
| `output/renders/hour-mix-v2.2.wav` | v2.2 hour A/B |
| `output/renders/hour-mix-v2.1.wav` / `hour-mix-old.wav` | Earlier hours |
| `output/previews/witchcraft-tidal-wave-bass-swap-v2.2.wav` | Liked bass swap |
| `output/previews/coming-down-witchcraft-phrase-mix-v2.2.wav` | Liked-enough phrase mix |
| Plan `0e2b79c6-4b8e-4b49-99f0-53aa1d6f4a56` | Liked v2.1 track order |
| Plan `5cb141aa-0b1a-4d22-882d-1f8163482503` | Peak hour v3 |
| Plan `c93a9f56-fa24-48e8-a06d-f5515d57e0ae` | Liquid hour v3 |

## Renderer versions that matter

| Version | What changed | Listen |
| --- | --- | --- |
| 6.0.0 | 3-band phrase-mix pairwise re-filtered the **whole** accumulated mix each step | `hour-peak-v3.wav` — unusable |
| 6.1.0 | Isolate 3-band work to the overlap tail; limiter off on intermediate pairwise steps | `hour-peak-v3.1.wav` — first real Peak ear-check |
| 6.2.0 | Publish 24-bit 48 kHz FLAC (same PCM as the mix) | later Peak copies |
| 6.3.0 | Phrase-mix mid/high complementary over the **whole** overlap (`hsin`); LR4 crossovers; graph limiter on tail only | `hour-peak-v3.2.flac` |
| 6.4.0 | `phraseShape: sequential` when a **drop outro** (energy ≥ 0.3) meets a **drum-heavy intro** (energy ≥ 0.15): incoming mid/high wait until mid-phrase | `hour-peak-v3.3.flac` — accepted |
| 6.5.0 | Strip first-track tags from published FLAC; write mix title, numbered tracklist, and CUESHEET | same Peak audio; tags only |

## Peak hour v3 — join-by-join

Plan `5cb141aa-…`, 16 tracks, duration **59:43** (3583076 ms). All 15 joins are `phrase_mix`, beat-aligned. Times are overlap starts in the listen files (same timestamps on v3.1 / v3.2 / v3.3).

Verdicts: **v3.1** is the detailed first listen. **v3.2** and **v3.3** only where they were re-checked. Canonical copy is **v3.3**. Closer listen of v3.3: joins **1–4 are a bit rough**; from **Inemuri → Calling for a Sign** (20:26) onward the transitions are much better. That later run is the quality bar, not the opening 20 minutes.

| # | Start | Outgoing → incoming | Bars | v3.1 | v3.2 | v3.3 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0:00 | Pendulum — Under The Waves | | | | |
| | **4:25** | → Logistics — Chant | 16 | very good | *(kept)* | closer: **rough** |
| 2 | 4:25 | Logistics — Chant | | | | |
| | **8:00** | → Sub Focus — Let The Story Begin | 16 | very good | *(kept)* | closer: **rough** |
| 3 | 8:00 | Sub Focus — Let The Story Begin | | | | |
| | **12:08** | → Technimatic — Let It Fall | **32** | uncomfortable: kits clash, noisy, beats OK. Let It Fall drums start on bar 1 of the intro | still two kits | sequential; closer still **rough** |
| 4 | 12:08 | Technimatic — Let It Fall | | | | |
| | **16:28** | → Logistics — Inemuri | 16 | too sudden: outgoing volume drops when the overlap starts | **good now** | closer: **rough** |
| 5 | 16:28 | Logistics — Inemuri | | | | |
| | **20:26** | → Sub Focus — Calling for a Sign (feat. Kelli-Leigh) | 16 | **absolutely beautiful** | *(not re-called; do not regress)* | closer: **much better from here** |
| 6 | 20:26 | Sub Focus — Calling for a Sign | | | | |
| | **23:32** | → Nu:Logic — Dreamweaver | **32** | Dreamweaver drums a bit abrupt; otherwise beat-matched and OK | **much better** | closer: still in the good half |
| 7 | 23:32 | Nu:Logic — Dreamweaver | | | | |
| | **27:23** | → Technimatic — Breathe In | 16 | **perfect** | *(kept)* | closer: good half |
| 8 | 27:23 | Technimatic — Breathe In | | | | |
| | **31:28** | → Technimatic — Hold on a While | 16 | **perfect** | *(kept)* | closer: good half |
| 9 | 31:28 | Technimatic — Hold on a While | | | | |
| | **34:24** | → Nu:Logic — Red Velvet | 16 | **perfect** | *(kept)* | closer: good half |
| 10 | 34:24 | Nu:Logic — Red Velvet | | | | |
| | **38:05** | → Technimatic — Moment to Moment | 16 | **perfect** | *(kept)* | closer: good half |
| 11 | 38:05 | Technimatic — Moment to Moment | | | | |
| | **41:54** | → Technimatic — Colour Me In | **32** | sudden outgoing drop; Colour Me In drums kick in roughly | **much better** | closer: good half |
| 12 | 41:54 | Technimatic — Colour Me In | | | | |
| | **45:57** | → Sub Focus — Until The End | 16 | **perfect** | *(kept)* | closer: good half |
| 13 | 45:57 | Sub Focus — Until The End | | | | |
| | **49:10** | → Sub Focus — Tidal Wave | **32** | very very good, but overlap feels compressed (detail/punch gone) | **compression gone** | closer: good half |
| 14 | 49:10 | Sub Focus — Tidal Wave | | | | |
| | **51:00** | → Pendulum — Streamline | **32** | very very good; same squash from 51:00 | **compression gone** | closer: good half |
| 15 | 51:00 | Pendulum — Streamline | | | | |
| | **55:39** | → Sub Focus — Vapourise | **32** | very good; same squash | **compression gone** | closer: good half |

Joins 9 and 10 still report `downbeatOffsetMs` ≈ 343 ms (`alignmentMode: beat`, ~one beat). That did not block the back half.

## Why the opening 20 minutes are rougher (v3.3 closer listen)

The template is the same all the way through: every join is `phrase_mix`, complementary except **12:08** (sequential). The split at **20:26** is not “we switched algorithm.”

| Join | Mix-out section | Mix-in section | Bars |
| --- | --- | --- | --- |
| 1 Under The Waves → Chant | **drop 0.33** | intro 0.07 | 16 |
| 2 Chant → Story Begin | breakdown 0.09 | intro 0.08 | 16 |
| 3 Story Begin → Let It Fall | **drop 0.33** | intro 0.22 (kit already on) | **32** sequential |
| 4 Let It Fall → Inemuri | **drop 0.41** | intro 0.08 | 16 |
| 5 Inemuri → Calling for a Sign | **build 0.38** | intro 0.11 | 16 |

Joins **1** and **4** leave a full drop hanging over a quiet intro for ~22 s. Join **3** is the known two-kit 32-bar. Join **2** looks like later breakdown→intro joins that sounded perfect (Dreamweaver → Breathe In, Hold on a While → Red Velvet), so that one is more pairing than curve.

The good half starts when mix-out is a **build** (Inemuri) into Calling for a Sign, then the Nu:Logic / Technimatic run. Drop→quiet-intro can still work (Breathe In → Hold on a While, drop 0.41 → intro 0.03, was perfect) — so do not blindly sequential every drop outro. The opening four are the ones to re-check on the next Peak pass: earlier mix-out, shorter phrase, or different pairing.

## Peak hour v3.4 — phrase-anchored replan of the v3 order

Plan `5c5121fb-da3b-4c2d-89b5-27675117dd95` (`plan:clone --replan` of `5cb141aa-…`), job `ed06f32f-f506-449c-b6ea-d8063d258797`, listen copy **`output/renders/hour-peak-v3.4.flac`**. Duration **36:55** (2214820 ms) — shorter because mix-ins are drop-anchored and mix-outs leave earlier. Do not overwrite v3.3.

`render:check` v2 exit **0**: every join has `exitKind` (`quietTail` or `dropLanding`); grid residual **0** on all 15 joins; no +1-period nudge; 13/15 joins `alignmentMode: phrase`. Gain-corrected LUFS delta is within 3 LU on every join. The 10 s arrangement step is large on Chant → Let The Story Begin (+7.6, quiet tail into the incoming drop) and Moment to Moment → Colour Me In (−7.9); those are phrase-window energy changes, not unmatched gains.

Ear-check of joins 1–4 and the old 20:26-onward run is **pending** (listen `hour-peak-v3.4.flac`; timestamps moved with the shorter windows).

## Why 12:08 was the hard one

Technimatic *Let It Fall* mix-in is **209 ms** into a **66 s intro** the analyzer labelled `intro` with section energy **0.217**. The drums are already fully there. Sub Focus *Let The Story Begin* mix-out sits in a **drop** (energy **0.334**).

The planner still picked `phrase_mix` (`matched-grid-phrase`) because `bothHot` needs head and tail ≥ **0.6**. It also picked **32 bars** because the incoming intro is ≥ 28 bars — which *lengthened* the kit stack.

Complementary mid/high (6.3.0) still left two kits in the room. Sequential (6.4.0) holds incoming mid/high until mid-phrase (~22 s into the 44 s overlap), then brings Let It Fall’s kit in. That made 12:08 listenable; a closer pass still files it with the rough opening, not with the back half.

**Rule now in code:** `choosePhraseShape` → `sequential` only when outgoing section is `drop` with energy ≥ **0.3** *and* incoming section energy ≥ **0.15**. On this Peak plan that fired **once** (Story Begin → Let It Fall). Streamline → Vapourise (incoming intro 0.204, outgoing drop 0.255) stays complementary on purpose.

## Liquid hour v3

Plan `c93a9f56-…`, `output/renders/hour-liquid-v3.wav`, **1:06:42**. User: **all transitions nice**. Do not chase Peak-style phrase-mix complexity here.

| # | Start | Track | Join |
| --- | --- | --- | --- |
| 1 | 0:00 | Form Form — New Element | **4:05** phrase mix 23 s |
| 2 | 4:05 | Goldie — Sensual | **11:43** crossfade 8 s |
| 3 | 11:43 | Gavin Bryars — Raising the Titanic (Big Drum Mix) | **19:55** xf 8 s |
| 4 | 19:55 | JMJ & Flytronic — In Too Deep | **25:32** xf 8 s |
| 5 | 25:32 | Nu:Logic — Pathways (feat. BLAKE) | **29:07** xf 30 s |
| 6 | 29:07 | Logistics — Microdot | **30:57** xf 30 s |
| 7 | 30:57 | Maduk, Amanda Collis — Fire Away | **34:11** xf 8 s |
| 8 | 34:11 | Calibre — Feeling Normal | **38:45** xf 30 s |
| 9 | 38:45 | PFM — Danny's Song | **46:49** xf 30 s |
| 10 | 46:49 | Calibre — Say Enough (with DRS) | **50:33** xf 30 s |
| 11 | 50:33 | Calibre — Time to Breathe (with Cimone) | **55:54** xf 30 s |
| 12 | 55:54 | PFM — One & Only | runs out |

Only 1→2 is a phrase mix. The rest are crossfades. That is a feature: liquid intros/outros do not need a 3-band kit hand-over.

## Peak / Liquid hour v4

Listen copies (do not overwrite keep-table files): `output/renders/hour-peak-v4.flac` and `output/renders/hour-liquid-v4.flac`. Ear-check is **pending** — judge joins against the v3.3 back-half bar (no “rough”, first 20 minutes of Peak as good as 20:26 onward; Liquid stays “nice” with more aligned joins).

`dropAnchored: true` on Peak (mix-in at the incoming drop). `dropAnchored: false` on Liquid (intro-start windows). Analyzer **3.2.0**. Canonical keys were gated off, so both hours warn “missing key” on almost every track and `harmonicCoverage` is 0 / N.

### Peak v4 — structural

Plan `994a70d4-adac-4ff7-9ca6-c827bb5ffb39`, job `d3d1ed60-a780-4b42-b133-bdd47398f994`, **24** tracks, **59:22** (3562606 ms). 21 `phrase_mix` + 2 `bass_swap`. `render:check` v2 exit **0**: every join `exitKind` set, `alignmentMode: phrase`, residual **0**. Opens Technimatic feat. Pat Fulgoni — Like a Memory → Logistics — Hayling → Sub Focus — Timewarp; ends Pendulum — Sounds Of Life.

| # | Outgoing → incoming | Bars | Shape | Exit | Residual | Arr. step LU |
| --- | --- | ---: | --- | --- | ---: | ---: |
| 0 | Like a Memory → Hayling | 32 | landing | dropLanding | 0 | +0.2 |
| 1 | Hayling → Timewarp | 16 | sequential | quietTail | 0 | +0.8 |
| 2 | Timewarp → Picton Blues | 16 | sequential | quietTail | 0 | +10.1 |
| 3 | Picton Blues → The Fountain | 8 | landing | dropLanding | 0 | −3.7 |
| 4 | The Fountain → Tidal Wave | 16 | sequential | quietTail | 0 | +0.7 |
| 5 | Tidal Wave → Broken Light | 32 | landing | dropLanding | 0 | −0.2 |
| 6 | Broken Light → Freedom | 16 | sequential | quietTail | 0 | +3.3 |
| 7 | Freedom → Triple X | 8 | sequential | quietTail | 0 | +5.9 |
| 8 | Triple X → Hologram | 8 | complementary | quietTail | 0 | +5.2 |
| 9 | Hologram → Hold Your Colour | 32 | complementary | quietTail | 0 | +4.9 |
| 10 | Hold Your Colour → Deep Space | 16 | sequential | quietTail | 0 | +6.7 |
| 11 | Deep Space → Breathe In | 8 | complementary | quietTail | 0 | +6.4 |
| 12 | Breathe In → Red Velvet | 32 | complementary | quietTail | 0 | +7.4 |
| 13 | Red Velvet → Let The Story Begin | 16 | sequential | quietTail | 0 | +11.2 |
| 14 | Let The Story Begin → Heatwave | 32 | landing | dropLanding | 0 | +0.8 |
| 15 | Heatwave → Propane Nightmares | 32 | complementary | quietTail | 0 | +11.2 |
| 16 | Propane Nightmares → Rock It | 8 | landing | dropLanding | 0 | +0.7 |
| 17 | Rock It → Safe In Your Arms | 8 | complementary | quietTail | 0 | +5.3 |
| 18 | Safe In Your Arms → 9,000 Miles | 8 | sequential | quietTail | 0 | +1.6 |
| 19 | 9,000 Miles → In Your Eyes | 16 | landing | dropLanding | 0 | +2.4 |
| 20 | In Your Eyes → Waiting | 8 | complementary | quietTail | 0 | +0.1 |
| 21 | Waiting → Been Dreaming | 32 | complementary | quietTail | 0 | +8.9 |
| 22 | Been Dreaming → Sounds Of Life | 16 | sequential | quietTail | 0 | +4.1 |

Joins 16 and 19 are `bass_swap`. Arrangement steps ≥ 5 LU are phrase-window energy changes (quiet tail into a drop), not gain mismatch.

### Liquid v4 — structural

Plan `b85cd3fb-5540-48a0-ba80-554d94edf4b3`, job `9be8dba1-d7cf-4641-a04d-c4f7f3d0e9b0`, **30** tracks, **2:03:26** (7406070 ms) — overshoots the hour because intro-start playable windows stay long. 21 `phrase_mix` + 2 `bass_swap` + 6 `crossfade` (**79% aligned**). Opens Technimatic feat. Lucy Kitchen — Looking for Diversion → Nu:Logic — Side By Side. `render:check` v2 exit **1** on five phrase-mix residuals (100–160 ms). Pathways and Microdot have no accepted grid (30 s crossfades). Ear-check pending — do not treat the extra hour of runtime as a listen of the same shape as Liquid v3.

## v2.2 hour (keep for pairing)

`output/renders/hour-mix-v2.2.wav`. Overall better than v2.1. Full join list is in `docs/progress.md`. Carry-forward:

- **Pairing fail:** Complicated → Tidal Wave (8 s cut is fine structurally; the records do not belong together). Preferred Tidal Wave in: Witchcraft `bass_swap` preview.
- **Early fade / leftover vocal:** Tidal Wave → Coming Down; Witchcraft a bit early into It Must Be.
- **Tracks don’t fit:** Falling Down → Saint Angel (okay technically).
- **Reference good:** It Must Be → Turn Up the Bass (amazing); Turn Up → Like a Memory (very very good, dead air gone); Like a Memory → Departure; Departure → Last Jungle; Saint Angel → Angel (quite perfect).
- Witchcraft → Tidal Wave **bass_swap** (forced 16 bars) is the liked swap, even though the planner wanted `phrase_mix` on that pair.

## Principles to use on the next mix

### Do

1. **One kit at a time on hot joins.** Complementary mid/high over the whole phrase is the default phrase-mix. If a drop outro meets a drum-heavy intro, sequential (incoming kit waits). Do not fade incoming drums *on top of* a still-full outgoing kit.
2. **Start the overlap gradually.** Outgoing mid/high must begin moving at bar 0 of the phrase, not at the halfway cliff. Sudden “the mix just started” is a fail.
3. **Keep the limiter off the mix so far.** Pairwise 3-band + `alimiter` on the accumulated prefix destroys early tracks and integrated LUFS (Peak v3.0). Limit the overlap tail only; loudness post-process is mix-wide volume then true-peak, not a second mash of every previous join.
4. **Protect punch in long overlaps.** 32-bar phrase mixes with two kits were the compressed-sounding ones (Until The End → Tidal Wave, Tidal Wave → Streamline, Streamline → Vapourise). Complementary + tail-only limiter fixed that. Do not bring back full-file graph limiting to chase true peak.
5. **Treat analyzer “intro” as a weak drum signal.** Section type `intro` can still be a full kit (Let It Fall 0.217). `bothHot` at 0.6 will miss it. Sequential thresholds (0.15 / 0.3 drop) are the workaround; a better drum/onset-at-mix-in feature would be stronger.
6. **Do not lengthen a bad overlap.** 32 bars because “intro ≥ 28 bars” made 12:08 worse. Long intro ≠ long blend when the intro is drums.
7. **Re-render to a new filename.** Liked hours stay. New Peak copies: v3.1 WAV, v3.2 FLAC, v3.3 FLAC.
8. **Deliver FLAC.** Mixing stays 24-bit 48 kHz PCM; the published file is lossless FLAC. Peak v3.3 is ~768 MB vs ~984 MB WAV. The file should be tagged as the mix (plan name + tracklist + CUESHEET), never as the first song.

### Do not

- Do not regress Inemuri → Calling for a Sign (“absolutely beautiful” on v3.1). That was a 16-bar phrase mix into a relatively quiet incoming intro (Inemuri mix-out is a build; Calling for a Sign intro energy 0.114).
- Do not turn every Peak join into sequential. The Technimatic run (Dreamweaver → … → Moment to Moment) and Colour Me In → Until The End were already perfect on complementary after the halfway-cliff fix.
- Do not force phrase-mix onto liquid hours. Crossfade was correct for almost every Liquid v3 join.
- Do not use 8 s tempo-mismatch cuts as a pairing strategy (Complicated → Tidal Wave).
- Do not overwrite the files in the keep table.

## Gaps for later (not done)

These showed up in ear-check or analysis dumps; they are not implemented:

- **Drop hanging over a quiet intro.** Under The Waves → Chant and Let It Fall → Inemuri mix out of drops (0.33 / 0.41) into intros ~0.07. Do not sequential those blindly (Breathe In → Hold on a While is the same shape and was perfect). Prefer an earlier mix-out or a shorter phrase on the next Peak pass.
- **Drum-aware mix-in.** Detect kit-on-from-bar-1 even when the section is labelled `intro` (onset density / mid energy in the first 8 bars of the incoming window). Sequential thresholds are a coarse proxy.
- **32-bar policy.** Do not auto-extend to 32 bars solely because the intro is long if that intro is already a kit. Consider 16 bars + sequential instead.
- **Bar-phase alignment on this crate.** Downbeat v2 put accepted-grid p50 at **1.0**, so Peak v4 is `alignmentMode: phrase` on every join. Liquid v4 still has five phrase-mix residuals 100–160 ms (sparse onsets / interludes).
- **Planner `bothHot` vs sequential.** `bass_swap` on both-hot (≥ 0.6) never fired on Story Begin → Let It Fall. Either lower that gate or route this pattern to sequential phrase-mix in the planner, not only at render time.
- **Midpoint hole.** Sequential can leave a short drum gap at the handoff. Accepted on 12:08; if a later join feels empty, overlap the kits by a few bars rather than going back to full complementary.
- **Forced bass_swap.** Witchcraft → Tidal Wave is still the liked Tidal Wave *in*; the planner’s `phrase_mix` on that pair is the wrong call.

## How to log the next hour

1. `render:check` first (silence, timestamps, template, bars).
2. Listen join by join. Write **one line per overlap**: timestamp, titles, bars, verdict, *why* (kit stack / sudden drop / squash / pairing / early fade).
3. Add a row to `docs/manual-test-log.md` and a short pointer here if a new pattern appears.
4. Copy the listen file to a named `output/renders/hour-…` path. Never overwrite an accepted copy.
