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
| Harmonic (Camelot)      | 10 × `harmonicImportance` | 0 same, 1 relative/neighbour, then wheel distance          |
| Personal rating         | 6                         | 1–5 scaled to 0–1                                          |
| Preferred-artist bonus  | 8                         |                                                            |
| Exploration             | 4 × `explorationWeight`   | Seeded hash of `seed + trackId`                            |
| Repeated-artist penalty | −20                       | Inside `artistRepeatSpacing` (default 1 = no back-to-back) |
| Recently-used penalty   | −8                        | Already in the plan                                        |
| Missing BPM/key/energy  | −10                       | Split across the three fields                              |

Identical catalog + constraints + seed → identical plan.

## Timing model

- Default transition overlap: **30 seconds** (timing only; Stage 2 does not render audio)
- Minimum playable window: **90 seconds** when the source is long enough
- Duration tolerance: **90 seconds** vs `targetDurationMs` (default one hour)
- Trims default to the full file; cue points are never invented

## Energy arc default

`3` at 0 → `9` at 0.75 → `6` at 1.0 through the set.

## Known planning limitations

- Cue points are never invented; missing mix-in/out cues produce validation warnings, not guessed positions
- Missing BPM/key/energy penalizes a candidate; it does not fabricate values
- A library that cannot fill the target duration returns a **partial** plan (`partial: true`) plus warnings
- Harmonic scoring uses Camelot wheel distance, not audio analysis
- Exploration is a seeded hash, not embeddings
- Ten live natural-language host evaluations are not part of the automated gate
