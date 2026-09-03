# Decisions

## 2026-09-03 — Peak v3.4 is the mix quality bar

Both Peak v4 and Liquid v4 are ear-check **fails**: stutters on almost every transition and early in the mix. `render:check` exit 0 on Peak v4 did not catch it. The direction is drop-anchored phrase-mix depth as on `hour-peak-v3.4.flac` (36:55), for Peak **and** Liquid. Do not pad Liquid with intro-start windows. Do not overwrite v3.4 or the v4 negatives.

Mixing v5 shipped the stutter fixes (keep landing, bake alignment, lock 174, no 32-bar duck on a quiet incoming) and new listen copies: `hour-peak-v3.5.flac` (v3.4-order A/B, 39:09), `hour-peak-v5.flac` (58:35), `hour-liquid-v5.flac` (59:46). Liquid v5 `render:check` still fails five sparse-grid residuals; that is not the v4 phrase-wrap stutter. Ear-check of the new files is the user’s.

## 2026-09-03 — Analyzed keys are gated at 0.5

`applyAnalyzedMetadata` used to write every analyzed key as canonical (216 rows, `key_confidence` p50 0.012). That bypassed `resolveCanonicalKey`’s 0.5 gate and fed noise into `harmonicScore`.

Analyzed keys now write only when `keyConfidence ≥ MIN_KEY_CONFIDENCE` (0.5). Below that, an existing analyzed key is cleared. Published and manual keys are untouched. The 3.1.0 stale pass loaded the old writer; **3.2.0** cleared the 216 ungated rows. After that pass: analyzed **0**, manual **8**, none **423**. `key_confidence` p50 **0.005**, max **0.461**, **0** rows ≥ 0.5. Peak/Liquid v4 `harmonicCoverage` is therefore 0 / N until the gold set is labelled or confidence improves.

Harmony scores Camelot **number** distance first (5A vs 5B is 0). Unknown keys score 0 and count toward `harmonicCoverage`. Aligned overlaps ≥ 16 bars with number distance ≥ 3 get `KEY_CLASH` and a shorter phrase.

## 2026-09-03 — Tempo logistic not re-fit; agreement is a bounded rescue

`tempoEvidence.agreement` is the free-fold vs kick/sub comb (1 if Δ≤1 BPM, 0.45 if ≤3). A kick-comb auto-accept of every in-range reject accepted constant-sine fixtures and was reverted.

beat-this labels are unavailable, so `calibrate-confidence.mts` was not given sidecar tempos. The 2026-09-03 synthetic weights and `MIN_ANALYSIS_CONFIDENCE` **0.6** stay. A rejected free grid is rescued only when agreement is **1**, prominence is **≥ 0.35**, logistic confidence is **≥ 0.45**, and the reject reason is the 0.6 floor — not a failed reference fit. Constant-sine fixtures stay rejected (logistic < 0.45) even when the two combs agree.

DnB-genre accepted grids stay **152 / 271** (56%) after the 3.2.0 rescue re-run — the ≥ 75% target is **not** met. No accepted in-range grid disagreed with published by > 1.0.

## 2026-09-03 — beat-this is not the rhythm source

`tools/analyzer-py/setup.ps1` now requires **Python 3.12** and CPU torch. This machine only has **3.14** (`py -0p` → `C:\Python314\python.exe`). beat-this / torch wheels cannot be installed, so `analysis:gate --engine beat-this` was not run.

DSP downbeat v2 (analyzer **3.1.0**) ships as the always-available rhythm path. The sidecar stays optional: adopt beat-this as the rhythm source only if it is ≥ 2 tracks better on in-range published BPM and adds < 10 s/track. Until a 3.12 venv exists, `gridSource: "sidecar"` is unused on this crate.

Merger still derives sidecar `downbeatConfidence` = downbeat-period IQR stability × DSP-phase agreement when a sidecar is present.

## 2026-09-03 — Level matching uses the set median, not −14

`gainDb` was always 0 even though the renderer already applied `volume=`. Plans now write `gainDb = clamp(setMedianLufs − trackLufs, −6, +3)`. The mix-wide −14 LUFS / −1.0 dBTP post-process is unchanged. A non-zero manual `gainDb` survives `--replan`. `render:check` gates the **gain-corrected** LUFS delta (3 LU); the 10 s arrangement step can be larger on quiet-tail and landing joins.

## 2026-09-03 — Intro-start Liquid hours overshoot the target

`dropAnchored: false` keeps mix-in at the intro start. Combined with phrase-boundary mix-outs, each playable window is nearly the full track. Liquid v4 planned **30** tracks and rendered **2:03:26** against a 1-hour target (`DURATION_OFF_TARGET`). Peak v4 (`dropAnchored: true`) stayed at **59:22**. Do not treat the Liquid v4 file as a one-hour listen.

## 2026-09-03 — Mix-out is a phrase boundary, not audioEnd − overlap

`constrainMixOut` used to snap mix-out to `audioEnd − overlap` whenever the outro was shorter than the phrase, which put Peak v3’s rough opening joins inside the final drop. Aligned windows now pick the latest phrase-grid boundary that fits `B`. `constrainMixOut` only clamps to `audioEndMs`; it never relocates a mix-out into a drop. `exitKind` is `quietTail` or `dropLanding`.

## 2026-09-03 — Mix FLACs carry the tracklist, not the first song

FFmpeg copies tags from the first `-i` unless told not to, so hour renders were showing the opening track's title/artist. Published FLACs now strip source tags (`-map_metadata -1`) and write mix-level Vorbis comments: plan name as title/album, artist `dnb-crate`, the full numbered tracklist in `comment`/`description`, and an embedded `CUESHEET` for per-track markers (FFmpeg does not persist native chapters on FLAC). Cue-snippet WAVs under `previews/` are stripped only. Renderer **6.5.0**.

## 2026-09-03 — Ear-check is the mix spec

Automated `render:check` only catches silence and timestamps. What sounded good or bad on Liquid v3, Peak v3.1–v3.3, and the v2.2 hour is written in **`docs/mixing-lessons.md`**. That file is the keep-list, join-by-join Peak table, and the rules for later hours (one kit at a time, no halfway volume cliff, no limiter on the mix so far, do not 32-bar a drum intro). Session rows stay in `docs/manual-test-log.md`.

Canonical Peak copy: `output/renders/hour-peak-v3.3.flac` (closer listen: joins 1–4 rough; from 20:26 much better). Accepted Liquid copy: `output/renders/hour-liquid-v3.wav`. Do not overwrite them.

## 2026-09-03 — Metadata enrichment is network opt-in

MusicBrainz, Deezer, and AcoustID run only when `enrichment.enabled` is true. Tests never hit the network (injectable `HttpClient`). The AcoustID key and contact string never appear in logs, tool results, `get_server_status`, reports, cache file names, or docs. `get_server_status` reports only `{ enabled, musicbrainz, deezer, acoustidConfigured }`. Logged URLs redact `client=`. Example config keeps `apiKey` empty.

Source files stay read-only: enrichment never writes tags to audio files.

## 2026-09-03 — Deezer published BPM

Write `tracks.bpm` with `bpmSource: "published"` only when the track has no `manual`/`published` BPM and Deezer `bpm > 0`. Fold ×2/÷2 into 160–190 when genres say drum and bass; round to the nearest integer when within 0.3 (173.7 → 174). If an accepted DSP grid disagrees by more than 1.0 BPM, do not write; record `bpmDisagreement` in the enrichment report. Published values never replace `manual`.

## 2026-09-03 — Enrichment matcher threshold

Score = 0.5·title + 0.3·artist + 0.2·duration. Accept ≥ 0.85 with artist Jaccard ≥ 0.6 and a duration hit. 0.6–0.85 is `needsReview` and writes no track fields. Remix/edit/VIP tokens must match, so a remix never matches an original.

MusicBrainz `/isrc/{code}` rejects `inc=release-groups+genres+tags` with HTTP 400. The client now tries `inc=artist-credits+releases`, then `recording?query=isrc:…`, and treats 4xx as no-hit so later tiers still run.

FFmpeg nightly writes a bare URL-safe Base64 chromaprint (`-`/`_`) on stdout, not JSON. AcoustID lookups use the first 120 s of audio and the file’s full duration. A fingerprint score ≥ 0.85 plus remix-token agreement and duration within 6 s is enough to accept (title/artist Jaccard often fails on `feat.` / punctuation).

## 2026-09-03 — Descriptor pack is heuristic

`energy`, `danceability`, `acousticness`, `melodicness`, and `valence` are same-pass DSP heuristics on the existing STFT/chroma/onset features. They are not trained mood models. `valence` in particular is low-confidence (major-vs-minor chroma margin plus brightness). Values are advisory, 0–1, and nullable on old rows. Integer `suggestedEnergy` is now `round(1 + 9·energy)`.

## 2026-09-03 — WP5 descriptor retune (fixtures first)

The 583-track 3.0.0 pass clustered several sliders (energy p90−p10 = 0.228, acousticness 0.236, melodicness 0.113). Energy and acousticness got one output stretch dated 2026-09-03 so those spreads exceed 0.3. Melodicness stayed on `2.2·keyConfidence`: chromaClarity ranks white-noise fixtures above most crate tracks, and key confidence on this crate is still ~0.001–0.05 (calibration is deferred). A liquid cutoff of 0.55 therefore matches zero rows; the liquid hour brief uses crate p80 (`melodicness.min` 0.12). Mood-preset words keep the designed 0.55 scale. Sub-bass and brightness are raw spectral ratios and were not remapped.

## 2026-09-03 — Sequential drums on drop-into-hot-intro

Complementary phrase-mix still stacked kits on Let The Story Begin → Let It Fall: mix-out is a drop (section energy 0.33) and Let It Fall’s intro already has drums (0.22) from bar one. Renderer **6.4.0** holds incoming mid/high until mid-phrase on that pattern only (`incoming ≥ 0.15` and outgoing drop `≥ 0.3`). Other Peak joins stay complementary.

## 2026-09-03 — Phrase-mix mid/high are complementary

Peak hour v3.1 (`hour-peak-v3.1.wav`) showed stacked drum kits on hot joins (Let The Story Begin → Let It Fall, 32 bars) and a sudden outgoing drop at the halfway mark (Let It Fall → Inemuri). Later 32-bar overlaps also felt limited: two full kits plus `amix=6` hit the ceiling.

Renderer **6.3.0** fades outgoing and incoming mid/high across the **whole** phrase (`hsin`), so hats/snares hand over instead of layering. Lows still swap at bar 12 / 24. Band splits are Linkwitz–Riley 4th-order. The graph `alimiter` sits on the overlap tail only, not the accumulated prefix. Liked hours stay untouched.

## 2026-09-03 — Published renders are 24-bit FLAC

The mixer still works in 48 kHz stereo `pcm_s24le`. Intermediate pairwise files, loudness, true-peak, and `render:check` stay on that PCM. The last write encodes the finished mix to FLAC (`-compression_level 8`) so the file is lossless and typically about half a WAV. Older jobs may still point at `.wav`. Cue-snippet previews under `previews/` stay WAV.

Renderer **6.2.0**.

## 2026-09-03 — Pairwise phrase-mix must not re-filter the mix so far

Peak hour v3 (`hour-peak-v3.wav`) chained 15 `phrase_mix` joins pairwise. Each step band-split and `alimiter`'d the **entire** accumulated mix, then a mix-wide `volume` + limiter cut another 1.6 dB. Integrated LUFS landed at **−17.9** (target −14) and the early tracks sounded wrong. Liquid stayed good because only its first join is a phrase mix.

Renderer **6.1.0** isolates the 3-band graph to the overlap tail and concatenates the unprocessed prefix, skips the graph limiter on intermediate pairwise steps, and true-peak post-process tries limiter-only first. A mix-wide volume duck is only the fallback if true peak is still over the ceiling.

## 2026-09-03 — Mix-wide true-peak limiter when LUFS is already in range

The first Peak hour v3 render failed because aligned overlaps measured **+1.5 dBTP** while integrated LUFS was already at target, so the existing LUFS-only attenuation never ran. `mix.ts` now applies a second limiter pass when true peak is more than 0.3 dB above the ceiling. Do not pre-attenuate the whole hour by the peak excess.

## 2026-09-02 — `-filter_complex` fallback

`-filter_complex_script` is probed at detect time (`ffmpeg -filter_complex_script` with no file). If FFmpeg reports `Unrecognized option`, mixes use inline `-filter_complex` instead. Observed on Windows nightly `N-125875` (2026-07-31), which has `acrossfade`/`atempo`/`ebur128` but not the script option. The script path stays preferred when present so long graphs do not inflate argv.

## 2026-08-31 — MCP TypeScript SDK v2 packages

The implementation spec named `@modelcontextprotocol/sdk`. The stable TypeScript line for MCP revision 2026-07-28 ships as `@modelcontextprotocol/server` and `@modelcontextprotocol/client` (v2.0.0). Stage 1 uses those packages, `registerTool` / `registerResource`, `serveStdio`, and Zod 4 schemas (`zod/v4`).

## 2026-08-31 — TypeScript executed with tsx

Apps run from TypeScript source via `tsx` rather than a `dist/` compile step. Workspace `exports` point at `src/index.ts`. This keeps Stage 1 iteration short; a compile pipeline can be added when packaging for non-dev hosts.

## 2026-08-31 — File fingerprint

A track fingerprint is SHA-256 over file size plus the first and last 64 KiB (the tail is omitted when the file is smaller than 64 KiB). Modification time is **not** mixed into the hash: including it made copy/rewrite moves look like new files. Two different files that share size and those windows can still collide. That is accepted for Stage 1 move detection. A full-file hash can replace this later if collisions appear.

## 2026-08-31 — Missing title statistic

`missingTitleFromTagsCount` is approximated as “title equals the filename stem”. Embedded title tags that happen to match the filename are counted as missing. Good enough for Stage 1 hygiene; a dedicated provenance flag can be added later.

## 2026-08-31 — Stage 2 timing overlap

Stage 2 treats a 30-second crossfade as a **timing assumption only**. Transition type is stored on the plan so Stage 3 can render it; no audio is mixed yet.

## 2026-08-31 — Manual BPM/key vs rescan

File scans no longer overwrite BPM or key when `bpmSource` / `keySource` is `manual`. Energy, rating, moods, tags, and notes were already preserved.

`fileMissing` is included on public tracks so a search can still find a renamed/deleted file without exposing `filePath`. `filePath` is omitted from every MCP and default CLI search result.

## 2026-08-31 — Prompt schemas live in domain

`apps/mcp-server` does not depend on `zod`. `build-dnb-set` argument schemas are exported from `@dnb-crate/domain` (`buildDnbSetPromptArgsSchema`) so the MCP server can pass them to `registerPrompt` without a direct Zod import.

## 2026-08-31 — get_track vs update_track_metadata output

`get_track` returns a public track **plus** `cuePoints` (`getTrackDataSchema`). `update_track_metadata` still returns a public track without requiring cue points (`publicTrackSchema`).

## 2026-08-31 — Stage 3 renderer and loudness

Mixing uses FFmpeg `acrossfade` with `hsin` curves (equal-power) at 48 kHz stereo `pcm_s24le`. The published file is 24-bit FLAC (see the 2026-09-03 FLAC decision). Argument arrays only; filter graphs use stream labels, never source paths.

Loudness: mix-wide target **-14 LUFS**, true-peak ceiling **-1 dBTP**. Individual tracks are not loudnormed. If integrated LUFS is more than 0.5 LU above target, one mix-wide attenuation is applied. Stage 3 does not promise bit-identical output across FFmpeg builds.

Jobs persist in SQLite. `cancel_render_job` aborts the child process. Running jobs leftover after a crash are marked `RENDER_INTERRUPTED`.

The in-process fake FFmpeg runner is used in catalog/MCP tests so the gate does not require a system FFmpeg install. A real-FFmpeg integration test skips when binaries are missing.

## 2026-08-31 — Stage 4 analyzer and atempo

Beat grids come from a TypeScript onset-envelope analyzer (`dnb-crate-envelope`) plus WAV decode. No Python worker and no native aubio: Windows native builds were rejected, and a second runtime would split the product. Key estimation is a coarse pitch/zero-crossing hint and is often omitted (confidence 0) on broadband/click material; tags and manual keys remain canonical.

Pitch-preserving stretch uses FFmpeg `atempo` after `atrim`/`asetpts`. `asetrate` is not used because it would shift pitch.

Bass-swap EQ frequencies, swap bar, and ramp are clamped template parameters (crossover 120–250 Hz, ramp 20–80 ms). The model cannot pass raw filter expressions.

## 2026-09-02 — Analysis v2 engines

Stage 4's envelope analyzer stays as `dnb-crate-envelope` for migrated rows. The default engine is in-process TypeScript DSP (`dnb-crate-dsp` 2.0): STFT spectral flux, tempogram, Ellis-style DP beat tracking, chroma key with mode, novelty sections, descriptors.

essentia.js was evaluated and rejected (last release 0.1.3 in 2021, AGPL-3.0, Node slowest in the authors' benchmarks, WASM heap OOM on full-length files, mood models need native `@tensorflow/tfjs-node`).

An optional Python sidecar (`beat-this`, `allin1`) is allowed behind the same `AudioAnalyzer` JSON shape when `analysis.engines.python.enabled` is true. The TypeScript engine remains the always-available default so the product never depends on Python. Sidecar rhythm is merged with DSP key/descriptors. Python 3.12 is pinned because torch wheels lag 3.14.

Provenance for BPM/key is **manual > published > analyzed > tag**. `update_track_metadata` accepts `bpmSource: "published"` for store/label lookups.

The 2026-08-31 wording "No Python worker and no native aubio" is superseded for the *optional adapter only*; native aubio remains rejected.

## 2026-09-02 — Key estimation v2 and confidence calibration

DSP key uses HPCP-style chroma in **165–3520 Hz** (spectral peaks rather than every FFT bin, global tuning histogram, suppression of energy explained as the 2nd/3rd harmonic of a lower note), median of L1-normalised frames after dropping the quietest 20 %, and the average of Krumhansl–Kessler and Temperley rank scores. The low cutoff is 165 Hz so a kick's 2nd harmonic (~110 Hz) cannot alias into a neighbouring pitch class. `chromaVector` is stored on descriptors for inspection.

Tempo confidence is a 3-feature logistic (prominence, stability, grid-vs-rival) fitted on synthetic click/DnB/sine/noise. The **0.55 clamp is gone**. After the v2.1 onset/tempo path, Last Jungle was a false accept at 0.58 (160 vs published 174), so `MIN_ANALYSIS_CONFIDENCE` is **0.6**. `allowLowConfidence` remains the override. Re-run `tools/scripts/calibrate-confidence.mts` when the onset/tempo path changes.

## 2026-09-02 — Default analysis engine

`dnb-crate-dsp` stays the default. The Python sidecar is optional; a `beat-this` crate comparison was not required to ship v2.1. Switch the default only if beat-this is ≥ 2 tracks better on in-range published BPM and adds < 10 s/track.

## 2026-09-03 — Reference grids from canonical BPM

Published/manual BPM is a **phase reference**, not a new canonical source. The analyzer still estimates freely; if that grid is rejected or disagrees by > 0.5 BPM, it fits `bestOffsetForBpm` at the reference and runs the same logistic. Features are measured on the reference comb (grid-vs-rival, on-grid ratio, windowed comb stability) so a clean free estimate cannot carry a wrong tempo over the threshold. Accept → `gridSource: "reference"`. Reject → never keep a wrong-tempo free grid. Applies to out-of-range references (125 still gets a 125 grid for cues/sections). `007_grid_source` stores the provenance.

## 2026-09-03 — Confidence calibration on the crate

`calibrate-confidence.mts --config` now loads stored `tempoEvidence` for published/manual tracks (no re-analysis), labels `|bpmRaw − canonical| ≤ 0.5` (out-of-range refs = 0), and fits with those rows at weight 2 plus the synthetic click/DnB/sine/noise rows.

Unconstrained fit on the 14 labelled crate rows (2026-09-03): bias −3.4732, prominence 4.0339, stability 0.2045, tempoConf 4.3950. Zero-false-accept MIN would be **0.795**, but that drops in-range accepted-correct from **5 → 1**. Fitted weights at MIN 0.6 drop it to **3**. The driver is Like a Memory (free 175 vs published 176) scoring as a false accept alongside true 174s. Last Jungle (160 vs 174) is already rejected at 0.582.

**Kept** the 2026-09-02 synthetic weights and **MIN 0.6**. Fixtures stay green; accepted-correct does not drop. Re-run after a reference-grid re-analysis if Like a Memory locks to 176.

## 2026-09-03 — Short crossfade on tempo mismatch

A 125 → 174 pair cannot share a phrase. The planner now uses `SHORT_CROSSFADE_MS` (8 s) at the mix-out/mix-in instead of a 30 s full-range blend, including when grids are missing. Type still comes from the join (head/tail sections), not track-level energy, when sections exist. Missing grids keep 30 s only when the BPMs already sit within 3%.

## 2026-09-03 — 3-band mix presets

Phrase-mix and bass-swap are no longer two hard-coded graphs. `expandPreset` builds per-band automation (low / mid / high) that both the planner and the renderer compile. The graph is `asplit=3` → band filters → chained `afade` → `amix=inputs=6`. Crossfade stays `acrossfade`. `RENDERER_VERSION` is **6.0.0** so preview cache keys change. Partial fades need FFmpeg `afade` `unity`/`silence`; the local build has them, and the fake runner advertises them.
