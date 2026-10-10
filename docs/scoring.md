# Scoring and planning

The planner is deterministic. A host model turns “soulful liquid, peak at 45 minutes” into `create_set_plan` fields. Scores are not embeddings. Same catalog + constraints + seed + **resolved planning history** → same plan: automatic freshness history (the default when a brief names no reference plans) is itself a planning input — it changes when qualifying plans are added, edited or deleted, and each plan records exactly which references it resolved against (`explanation.variety.historyMode`, `referencePlanIds`, `recentArtistUses`, `policyVersion` in `summarize-plan`). Pass `variety.history: "off"` to plan against zero history.

## Default weights

| Component                   | Weight                    | Notes                                                                                                                                     |
| --------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Mood overlap                | 8                         | Requested moods present on the candidate                                                                                                  |
| Tag overlap                 | 4                         | Half the mood weight                                                                                                                      |
| Subgenre overlap            | 8                         |                                                                                                                                           |
| Target-energy proximity     | 12                        | Interpolated from `requestedArc`                                                                                                          |
| BPM compatibility           | 12                        | Falls off over ±8 BPM                                                                                                                     |
| Harmonic (Camelot)          | 10 × `harmonicImportance` | Same 1.0; relative / adjacent same-mode 0.85; else by number distance; unknown 0                                                          |
| Feedback                    | 6                         | Dislike penalty on the pair. Stored likes do not boost set-plan selection; they feed interactive transition planning and approved recipes |
| Join level                  | 6                         | −(max(0, abs(ΔLUFS) − 3) / 6)                                                                                                             |
| Join structure              | 8                         | Incoming drop ≥ 16 bars and/or outgoing quiet tail                                                                                        |
| Join aligned                | 10                        | Both grids accepted and BPM within ±3%                                                                                                    |
| Join harmonic               | 8                         | Same as harmonic, used in lookahead                                                                                                       |
| Join mood                   | 7                         | Valence/brightness continuity between adjacent tracks; ≥0.3 valence gap penalized (`JOIN_MOOD_CLASH`)                                     |
| Genre prior                 | 4                         | liquid funk / neurofunk / jump up / jungle                                                                                                |
| Personal rating             | 6                         | 1–5 scaled to 0–1                                                                                                                         |
| Preferred-artist bonus      | 8                         |                                                                                                                                           |
| Exploration                 | 4 × `explorationWeight`   | Seeded hash of `seed + trackId`                                                                                                           |
| Repeated-artist penalty     | −20                       | Inside `artistRepeatSpacing`                                                                                                              |
| Recently-used penalty       | −8                        | Already in the plan                                                                                                                       |
| Variety: repeated recording | −8 × variety weight       | Same `recording_key` appeared in recent mixes (`RECENT_MIX_RECORDING`)                                                                    |
| Variety: repeated pair      | −4 × variety weight       | Same pair appeared in recent mixes (`RECENT_MIX_PAIR`)                                                                                    |
| Missing BPM/key/energy      | −10                       | Split across the three fields                                                                                                             |
| Structure                   | 6                         | Outro/intro length similarity                                                                                                             |

Effective energy is `track.energy ?? round(1 + 9·descriptors.energy)`. Suggested-only energy keeps a ×0.6 weight. `bpmHint` scores BPM at half weight and satisfies pool filters; aligned templates still need an accepted grid. Empty manual moods fall back to mood presets. Duplicate `recording_key` is rejected. Artist spacing uses `artist_canonical`.

The planner shortlists the top 12 candidates, looks ahead one join (up to 8 strict continuations), and re-ranks `total + 0.35 * lookahead`. When `explorationWeight` is above 0 it may draw a seeded near-best candidate from that shortlist. Ties break on `id.localeCompare`. Descriptor relaxation is ±0.08 / ±0.16 / ±0.24 from the original brief. Beyond the single-pass ranking, planning also retries: a chain search over alternative continuations, up to three opener attempts, and a bounded repair search that swaps tracks to satisfy pinned transitions.

## Quality

New plans default to `qualityPolicy: "strict"`. Conservative harmonic joins are required, and the preferred aligned template is `phrase_mix` — it preserves volume and energy where it works. The set-plan path auto-picks `bass_swap` only on a **decisive** kick-placement conflict (`PLANNER_BASS_SWAP_TRIGGER_GROOVE = -0.45`, audition-calibrated October 2026); bass swaps also arrive through approved recipes or explicit transition planning, and all three count as aligned for quality. Template thresholds and triggers live in [mixing.md](mixing.md); this document covers scoring only. Unexplained `other` / unknown / crossfade fails quality. `requiredTransitions` pin a pair only when you ask. `qualityPolicy: "off"` is a fixture/draft hatch. Ready mixes need to land within **5 minutes** of the requested `targetDurationMs`.

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
