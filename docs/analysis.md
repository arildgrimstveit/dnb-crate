# Analysis

The analyzer measures each file. It does not pick a mix. Every BPM, key, downbeat, section, and cue has confidence and provenance.

Canonical BPM/key order: **manual > published > analyzed > tag**. A general library should not need manual keys or tempos. KeyFinder writes analyzed keys at confidence 0.7. DSP chroma keys stay unused.

## Engines

| Engine | Role |
| --- | --- |
| `dnb-crate-dsp` | Default. Onsets, tempogram, beat grid, downbeats, sections, descriptors. |
| `keyfinder` | Local key-only row (WAV decode + libkeyfinder). Not labelled `published`. |
| `beat-this` / `allin1` | Optional Python sidecars. Off by default. |
| `dnb-crate-envelope` | Legacy rows only. |

Planning uses the selected rhythm engine when `track_evidence_selection` is set; otherwise DSP. Key and loudness still come from the selected key engine / DSP. Rows are stored per `(track_id, analyzer_name)`.

Descriptors (`energy`, `danceability`, `acousticness`, `melodicness`, `valence`) are deterministic heuristics on a 0–1 scale, not a trained model.

## Grids

- Tempo folds into **160–190 BPM** (half/double, then 2:3 / 3:2 and similar).
- Confidence below **0.6** rejects the grid. A rejected grid cannot phrase-mix.
- A published or leftover BPM is scored as a reference lock when it agrees with a passing free grid.
- `set_cue_points` with `beatAnchorMs` rebuilds the grid as `gridSource: "anchor"` and raises stored confidence to at least 0.6. Pass existing cues or they are wiped.
- A rejected grid whose raw estimate still folds into range at ≥ 0.3 exposes `bpmHint`. Hints never write `tracks.bpm` and cannot align a phrase-mix.

## Keys

- Analyzed keys write only when `keyConfidence ≥ 0.5`.
- KeyFinder is the local key route. DSP chroma stays unused.
- Unknown is not compatible for harmonic scoring.
- Optional: `tools/scripts/fill-crate-keys-and-bpm.mts` measures missing KeyFinder rows and promotes them.

## Sections and cues

Accepted grids label `intro | build | drop | breakdown | bridge | outro`. Cues (`intro_start`, `drop`, `breakdown`, `outro_start`) come from those sections. Analyzer cues never overwrite a manual cue of the same type.

## Run analysis

```bash
pnpm cli analysis:run --scope unanalyzed --wait --timeout-min 90
pnpm cli analysis:get --track-id UUID
pnpm cli analysis:report
```

| Scope | Selects |
| --- | --- |
| `ids` | Explicit `trackIds` |
| `unanalyzed` | Incomplete analysis, file present |
| `stale` | Missing DSP row, old analyzer version, failed, or reference BPM drift |
| `planningReady` | Tracks that already pass readiness |
| `all` | Every non-missing file |
