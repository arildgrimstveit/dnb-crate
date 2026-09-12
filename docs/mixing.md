# Mixing

Rules for new plans and renders. They apply to any local DnB folder. They are not locked to a particular crate, title, or accepted hour.

## Defaults

- Phrase windows are scored for energy continuity. Sequential joins use the supported kit-on shape. Timing is `rateRegionsVersion: 2`.
- `qualityPolicy: "strict"` — refuse unexplained risky/unknown keys and unexplained crossfades.
- Omit `targetBpm`. Each overlap beatmatches at the pair tempo. Featured bodies stay native. A mix-wide tempo lock is opt-in only.
- `dropAnchored: true` so the incoming drop lands at overlap end.
- Phrase-mix (or bass-swap) when both grids are usable and tempo is within ±3%. Crossfade is the mismatch fallback.

## Joins

- Compare 16- and 32-bar windows on the actual source material. Do not maximize bar count.
- Do not auto-pick 8 bars when 16 or 32 is feasible.
- Drop-anchored landing: incoming already running, drop at overlap end.
- Complementary quiet-tail prefers 16-bar `lift`. Sequential and landing stay `sustain`.
- Stretch is **join only** (Rubber Band R3 when present). Do not stretch whole tracks.
- Conservative harmonic = same key, relative, or adjacent same-mode. Unknown is not compatible.

## Quality

A plan is ready to render when it is structurally valid, quality checks pass, and duration is within **5 minutes** of the requested length. The planner still aims within **90 s**; the wider quality window is so a good last-track choice is not rejected for being a few minutes short or long. `plan:quality --id` prints the report. Request length with `targetDurationMinutes` or `targetDurationMs` (default **60 minutes** if omitted).

`requiredTransitions` can pin a pair if you ask for it. Fresh mixes should not pin historical pairs or recipes.

`qualityPolicy: "off"` is for fixtures and drafts only.

## Briefs

Start from `docs/examples/liquid-hour.example.brief.json` or `docs/examples/peak-hour.example.brief.json`. Change `targetDurationMinutes` (or `targetDurationMs`), moods, descriptor floors, and seed. Do not copy title lists or exclude IDs from another library. Natural-language asks and the CLI short path: README **Ask for a mix**.
