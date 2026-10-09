# Mixing

Rules for new plans and renders. They apply to any local DnB folder. They are not locked to a particular crate, title, or accepted hour.

## Defaults

- Phrase windows are scored for energy continuity. After the usual downbeat snap, joins also search nearby beat/bar slips so overlapping kicks, snares, and vocals share a grid. Sequential joins use the supported kit-on shape. Timing is `rateRegionsVersion: 2`.
- `qualityPolicy: "strict"` — refuse unexplained risky/unknown keys and unexplained crossfades.
- Omit `targetBpm`. Each overlap beatmatches at the pair tempo, and from the first aligned join onward the mix runs on a **chain tempo lock**: every later pair targets the outgoing deck's effective BPM, which carries the opening pair's tempo forward. Decks join that tempo as the mix proceeds instead of pulling the chain back toward native tempos. A tempo-mismatch crossfade leaves both decks native and re-anchors the chain at the next track's tempo. Featured bodies stay native. An explicit `targetBpm` is an additional opt-in lock on top.
- `dropAnchored: true` so the incoming drop lands at overlap end.
- The set-plan path picks `phrase_mix` whenever both grids are usable, tempo is within ±3%, and the overlap-local grooves are structurally compatible; a syncopation conflict in the actual overlap crossfades instead (`groove-syncopation-conflict`, measured over the join's real bar count from each side's mix-out/mix-in). Automatic `bass_swap` requires a **decisive** kick-placement conflict (`PLANNER_BASS_SWAP_TRIGGER_GROOVE = −0.45`, audition-calibrated October 2026: mild negatives were noise, and phrase_mix — which preserves volume and energy — is preferred whenever the blend works); bass swaps also enter through approved recipes or `plan_transition` / `update_set_plan`. Crossfade is the mismatch fallback everywhere.

## Joins

- Compare 16- and 32-bar windows on the actual source material. Prefer a 32-bar drop-anchored landing when the first drop is in the opening and the mix-in is not a dead intro. A late first drop (after 90 s) stays 16 unless that 32-bar prefix already has body. Do not auto-pick 8 bars when 16 or 32 is feasible.
- Onset-lock then tries ±1–8 beats (or whole bars when only bar energy exists). It keeps the incoming drop at overlap end and moves mix-out when a nearby slip makes the two drumlines lock. Beat profiles are anchored to bar 0 (bars are collected from the first downbeat) so a downbeat phase cannot inject a bogus slip, and only the sub-beat part of the downbeat snap is added on top — a whole-beat slip never discards it. Downbeat labels alone are not enough: a one-beat kick/snare swap still looks “on grid.”
- Drop-anchored landing: incoming already running, first labeled drop at overlap end. A late first drop mixes in 16 bars before that drop.
- Complementary quiet-tail prefers 16-bar `lift`. Sequential and landing stay `sustain`.
- Stretch is **join only** (Rubber Band R3 when present). Do not stretch whole tracks.
- Conservative harmonic = same key, relative, or adjacent same-mode. Unknown is not compatible.

## Quality

A plan is ready to render when it is structurally valid, quality checks pass, and duration is within **5 minutes** of the requested length. The planner still aims within **90 s**; the wider quality window is so a good last-track choice is not rejected for being a few minutes short or long. `plan:quality --id` prints the report. Request length with `targetDurationMinutes` or `targetDurationMs` (default **60 minutes** if omitted).

`requiredTransitions` can pin a pair if you ask for it. Fresh mixes should not pin historical pairs or recipes.

`qualityPolicy: "off"` is for fixtures and drafts only.

## Briefs

Start from `docs/examples/liquid-hour.example.brief.json` or `docs/examples/peak-hour.example.brief.json`. Change `targetDurationMinutes` (or `targetDurationMs`), moods, descriptor floors, and seed. Do not copy title lists or exclude IDs from another library. Natural-language asks and the CLI short path: README **Ask for a mix**.

## Listening-session findings (2026-10)

Confirmed by owner verdicts over two auditioned hours (one liquid, one peak):

- **Grid stability is the strongest unmixable predictor.** Every track retired as unmixable measured `tempo_stability` ≤ 0.18 (Half Light 0.175, Break The Cycle 0.131) or flamed both of its joins despite clean stored-grid residuals. Tracks at ≥ 0.65 held up. Pool candidates below ~0.6 stability should be excluded or heavily penalized before planning.
- **Never mix in over a drumless head.** When drop-anchored candidates fail (late first drop), the fallback can place mix-in at source 0 over an intro measuring ~0.01 energy — the owner hears "completely quiet when it comes in" every time. An incoming head energy floor (or falling back to a later drop) belongs in window selection.
- **The gallop signature is a 32-bar phrase_mix between two busy break patterns.** Beat grids read 0 ms residual — the interleave is at the 16th-note level — and the owner hears galloping. Two confirmed cases both resolved with a 16-bar `bass_swap`. Drum coexistence through the overlap is the observable; low coexistence on an aligned 32-bar pair should steer to `bass_swap`.
- **Plan-time body check.** A drop-anchored window whose body is thinner than head + tail join regions only fails at render ("no native body"). The renderer's rule (body > incoming + outgoing join duration) is knowable at planning; single-late-drop tracks in short windows routinely violate it.
- **Variant edits are duplicate recordings.** Radio and extended edits carry different `recording_key`s and both can be selected (Heartbeat Loud twice, four slots apart). Normalize edit variants (extended/version/radio/edit) into one recording family for variety and duplicate rejection.
- **Editing gotchas that cost debugging time.** `applyTransition` sets `incomingSourceEndMs` only on the last entry — trim middle entries with `setTrim`. Hand-edited windows must drop the pinned `downbeatOffsetMs`/`alignmentMode`/`alignmentPeriodMs`/`onsetLockBeats`/`recipeVersion` parameters, or the renderer skips re-deriving alignment and stale offsets become audible flams.
