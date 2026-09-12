# Scoring and planning

The planner is deterministic. A host model turns “soulful liquid, peak at 45 minutes” into `create_set_plan` fields. Scores are not embeddings. Same catalog + constraints + seed → same plan.

## Default weights

| Component               | Weight                    | Notes                                                                            |
| ----------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| Mood overlap            | 8                         | Requested moods present on the candidate                                         |
| Tag overlap             | 4                         | Half the mood weight                                                             |
| Subgenre overlap        | 8                         |                                                                                  |
| Target-energy proximity | 12                        | Interpolated from `requestedArc`                                                 |
| BPM compatibility       | 12                        | Falls off over ±8 BPM                                                            |
| Harmonic (Camelot)      | 10 × `harmonicImportance` | Same 1.0; relative / adjacent same-mode 0.85; else by number distance; unknown 0 |
| Feedback                | 6                         | Pair bonus from stored likes/dislikes                                            |
| Join level              | 6                         | −(max(0, abs(ΔLUFS) − 3) / 6)                                                    |
| Join structure          | 8                         | Incoming drop ≥ 16 bars and/or outgoing quiet tail                               |
| Join aligned            | 10                        | Both grids accepted and BPM within ±3%                                           |
| Join harmonic           | 8                         | Same as harmonic, used in lookahead                                              |
| Genre prior             | 4                         | liquid funk / neurofunk / jump up / jungle                                       |
| Personal rating         | 6                         | 1–5 scaled to 0–1                                                                |
| Preferred-artist bonus  | 8                         |                                                                                  |
| Exploration             | 4 × `explorationWeight`   | Seeded hash of `seed + trackId`                                                  |
| Repeated-artist penalty | −20                       | Inside `artistRepeatSpacing`                                                     |
| Recently-used penalty   | −8                        | Already in the plan                                                              |
| Missing BPM/key/energy  | −10                       | Split across the three fields                                                    |
| Structure               | 6                         | Outro/intro length similarity                                                    |

Effective energy is `track.energy ?? round(1 + 9·descriptors.energy)`. Suggested-only energy keeps a ×0.6 weight. `bpmHint` scores BPM at half weight and satisfies pool filters; aligned templates still need an accepted grid. Empty manual moods fall back to mood presets. Duplicate `recording_key` is rejected. Artist spacing uses `artist_canonical`.

The planner shortlists the top 12 candidates, looks ahead one join (up to 8 strict continuations), and re-ranks `total + 0.35 * lookahead`. When `explorationWeight` is above 0 it may draw a seeded near-best candidate from that shortlist. Ties break on `id.localeCompare`. Descriptor relaxation is ±0.08 / ±0.16 / ±0.24 from the original brief.

## Quality

New plans default to `qualityPolicy: "strict"`. Conservative harmonic joins and aligned phrase-mix / bass-swap are the eligible set. Unexplained `other` / unknown / crossfade fails quality. `requiredTransitions` pin a pair only when you ask. `qualityPolicy: "off"` is a fixture/draft hatch. Ready mixes need to land within **5 minutes** of the requested `targetDurationMs`.

## Timing

- Default overlap: **30 s**. Tempo-mismatched pairs use an **8 s** crossfade.
- Minimum playable window: **90 s** when the source is long enough.
- Duration tolerance: **90 s** vs `targetDurationMs` for planner fill and `DURATION_OFF_TARGET` warnings. Quality / ready-to-render uses **5 minutes**.
- Aligned pairs tempo-match within ±3%. Same-integer pairs stay on that integer. New briefs omit `targetBpm`.

## Energy arc default

`3` at 0 → `9` at 0.75 → `6` at 1.0.

## Limits

- Cues are never invented.
- Missing BPM/key/energy penalizes a candidate; values are not fabricated.
- A library that cannot fill the target returns a **partial** plan.
- Unknown keys score 0 for harmony.
- A large crate whose relaxed pool is still ≤ 12 stops (`POOL_TOO_SMALL`).
