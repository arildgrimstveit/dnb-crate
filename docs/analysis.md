# Analysis

The analyzer measures each file. It does not pick a mix. Every BPM, key, downbeat, section, and cue has confidence and provenance.

Canonical BPM/key order: **manual > published > analyzed > tag**. A general library should not need manual keys or tempos. KeyFinder writes analyzed keys at confidence 0.7. DSP chroma keys stay unused.

## Engines

| Engine          | Role                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `dnb-crate-dsp` | The only `analysis:run` / `start_track_analysis` engine. Onsets, tempogram, beat grid, downbeats, sections, descriptors. |

KeyFinder runs as an internal key stage during ordinary analysis and stores a separate evidence row; it is not a public rhythm engine. Older catalogs may still have `dnb-crate-envelope` rows or `gridSource: "sidecar"`; those are read so existing plans keep working, and they are not written again.

Planning, previews, rendering and reports resolve rhythm, structure and key independently from
`track_evidence_selection`. Rhythm supplies BPM and the beat grid; structure supplies sections and
cues; key supplies the analyzed key. A missing selection falls back to the rhythm row. Selecting an
engine that has no stored row is rejected. Rows are stored per `(track_id, analyzer_name)`.

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
- `analysis:run --scope stale --wait` measures missing/stale KeyFinder evidence and promotes it when no conflicting explicit evidence choice exists. The maintenance scripts are retired.

## Sections and cues

Accepted grids label `intro | build | drop | breakdown | bridge | outro`. Cues (`intro_start`, `drop`, `breakdown`, `outro_start`) come from those sections. Analyzer cues never overwrite a manual cue of the same type.

## Run analysis

```bash
pnpm cli analysis:run --scope unanalyzed --wait --timeout-min 90
pnpm cli analysis:get --track-id UUID
pnpm cli analysis:report
```

| Scope           | Selects                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `ids`           | Explicit `trackIds`                                                                                |
| `unanalyzed`    | Incomplete analysis, file present                                                                  |
| `stale`         | Missing DSP row, old analyzer version, failed, reference BPM drift, or missing/stale automatic key |
| `planningReady` | Tracks that already pass readiness                                                                 |
| `all`           | Every non-missing file                                                                             |

## Automatic KeyFinder stage

Ordinary analysis includes separately persisted key work by default. Use `analysis.keyAnalysis: "off"` to disable it, and `keyfinderPath` / `DNB_CRATE_KEYFINDER_PATH` to select an executable. KeyFinder remains internal: the public rhythm-engine enum still contains only `dnb-crate-dsp`. `analysis:run --scope stale --wait` replaces the key maintenance scripts. Job `keyStages` distinguish key failures/skips from successful DSP work. The fixed recognized-key confidence is a 0.7 heuristic, not measured probability. See [first-mix configuration, freshness, recovery and native tests](first-mix.md).
