# Scoring and planning (Stage 2)

The planner is deterministic. The host model translates “soulful liquid, peak at 45 minutes” into structured `create_set_plan` fields. Scores are not embeddings.

## Default weights

| Component               | Weight                    | Notes                                                      |
| ----------------------- | ------------------------- | ---------------------------------------------------------- |
| Mood overlap            | 8                         | Fraction of requested moods present on the candidate       |
| Tag overlap             | 4                         | Uses half the mood weight                                  |
| Subgenre overlap        | 8                         |                                                            |
| Target-energy proximity | 12                        | Interpolated from `requestedArc`                           |
| BPM compatibility       | 12                        | Falls off over ±8 BPM                                      |
| Harmonic (Camelot)      | 10 × `harmonicImportance` | Number distance first (5A/5B = 0), scaled by `min(keyConf)` |
| Join level              | 6                         | −(|ΔLUFS| − 3)⁺ / 6                                       |
| Join structure          | 8                         | Incoming drop ≥ 16 bars and/or outgoing quiet tail          |
| Join aligned            | 10                        | Both grids accepted and BPM within ±3%                      |
| Join harmonic           | 8                         | Same as harmonic, used in lookahead                         |
| Genre prior             | 4                         | liquid funk / neurofunk / jump up / jungle                  |
| Personal rating         | 6                         | 1–5 scaled to 0–1                                          |
| Preferred-artist bonus  | 8                         |                                                            |
| Exploration             | 4 × `explorationWeight`   | Seeded hash of `seed + trackId`                            |
| Repeated-artist penalty | −20                       | Inside `artistRepeatSpacing` (default 1 = no back-to-back) |
| Recently-used penalty   | −8                        | Already in the plan                                        |
| Missing BPM/key/energy  | −10                       | Split across the three fields                              |
| Structure               | 6                         | Outro/intro length similarity when both exist              |

Effective energy is `track.energy ?? round(1 + 9·descriptors.energy)` in scoring and arc validation. Suggested-only energy keeps the ×0.6 weight. `bpmHint` scores BPM at half weight (`BPM_HINT_ONLY`) and satisfies pool BPM filters; aligned templates still need an accepted grid. When manual moods are empty, `preferredMoods` score mood presets (`MOOD_PRESET`). Duplicate `recording_key` is rejected (`DUPLICATE_RECORDING`). Artist spacing uses `artist_canonical`.

The planner scores the top 5 candidates, looks ahead one join (beam 3), and re-ranks `total + 0.35 * lookahead`. Ties break on `id.localeCompare`.

Identical catalog + constraints + seed → identical plan.

## Timing model

- Default transition overlap: **30 seconds**. Tempo-mismatched pairs use an **8 second** `crossfade` at the mix-out/mix-in (`SHORT_CROSSFADE_MS`), whether or not both grids are accepted. Missing grids keep the 30 s crossfade only when the BPMs already sit within 3%.
- Minimum playable window: **90 seconds** when the source is long enough
- Duration tolerance: **90 seconds** vs `targetDurationMs` (default one hour)
- Trims default to the full file; cue points are never invented
- Aligned `phrase_mix` / `bass_swap` pairs tempo-match within ±3%. Same-integer pairs stay on that integer (174/174 → 174). A later 176 does not average the chain to 175. Peak briefs may set `targetBpm: 174`. `|rate − 1| < 0.002` is treated as 1.0 (no `atempo`). Manual `setPlaybackRate` survives a rebuild.

## Energy arc default

`3` at 0 → `9` at 0.75 → `6` at 1.0 through the set.

## Known planning limitations

- Cue points are never invented; missing mix-in/out cues produce validation warnings, not guessed positions
- Missing BPM/key/energy penalizes a candidate; it does not fabricate values
- A library that cannot fill the target duration returns a **partial** plan (`partial: true`) plus warnings
- Harmonic scoring uses Camelot **number** distance, confidence-weighted. Unknown keys score 0 (`harmonicCoverage` on the plan explanation)
- Mood presets may use crate percentiles (`minPct` / `maxPct` against stored p10/p50/p90)
- Pool floor: if the crate is large and the pool is still ≤ 12 after relaxing descriptor ranges, planning stops (`POOL_TOO_SMALL`). A relaxed pool records `POOL_RELAXED`
- Exploration is a seeded hash, not embeddings
- Ten live natural-language host evaluations are not part of the automated gate
