# Beatmatching follow-ups

Larger items deferred during the September 2026 beatmatching sessions. Everything here
was observed on real renders and auditioned (or explicitly marked not-yet-auditioned).
The implementation plan lives in [`plans/beatmatching-automation.md`](plans/beatmatching-automation.md).

Shipped in this tree already: anchored onset-lock (`planning/onset-lock.ts`, `downbeatBeatOffset`),
sub-beat composition (`bakeWindowAlignment`), evidence floor (`SCORE_FLOOR`),
feasibility-first tempo gate (`chooseTransition`), joint tempo validation (`TEMPO_MISMATCH`),
explicit `barCount` → `maxBars`, 32-bar breakdown entries (`breakdownEntry`),
`onsetLockBeats` provenance (planner → manifest → check), render:check attribution fix,
lock-aware period tripwire, `lowFadeBars` sub-glide preset, `plan:delete`, and a clearer
short-trim validation error. Full suite green (55 files, 463+ tests).

## 1. Dense-out / sparse-in pairs need automatic handling

**Status:** understood, manually workaround-able, not yet automatic.

Final Hours (dense drop tail) → Somewhere (sparse syncopated build, ~5 snares in 44 s)
gallops under every phrase_mix automation tried (landing, held incoming fade,
complementary). The approved treatment is bass_swap with hats crossed early and a
12-bar sub glide (`lowFadeBars`), which the planner never selects on its own.

**Why naive triggers fail:** the perfect join 5 (Somewhere tail → Rosewood sparse head)
has the same dense-out/sparse-in shape on paper. Verified against stored data that
_no_ aggregate/profile feature separates them: identical kick/snare means (9 vs 12,
33 vs 35), identical score shapes, near-identical window sparsity. The difference is
groove conformance (Somewhere's chops are syncopated off-grid; Rosewood's head is
effectively empty pads), which no stored feature captures.

**What was ruled out (with evidence):**

- Whole-beat shift selection: ±8/−4/0 all gallop; ±1/±2/±3 score low.
- Bar-domain phrase tie-break (midFlux/sub): made 5 of 8 auditioned joins worse
  offline (bar energy is bar-periodic too). Tested, discarded, not shipped.
- Fade-shape changes alone (held, complementary): gallop persists — the conflict
  is in the content, not the envelope.

## 2. Held incoming fades are never chosen automatically

`landingIncomingFadeBars` exists in the preset schema but no planner path sets it, so
every landing fades incoming mids/highs from bar 0. For sparse incoming heads, holding
the fade until drums enter is strictly better behaved. Needs one audition on a fresh
pair before encoding (the one held-fade preview that shipped galloped for content
reasons, not envelope reasons — see item 1).

## 3. Feel-conformance analysis (prerequisite for item 1)

To trigger item 1 safely the planner needs a per-section groove-conformance signal:
hat-band transient phase dispersion vs. own grid, plus backbeat concentration, measured
at analysis time and stored on the analysis row. Today's `beatKick`/`beatSnare` profiles
are sampled _at_ beats, so off-grid content is invisible to them by construction —
this is the same blind spot behind the ±2-beat label-swap ambiguity below.

Requires an analyzer version bump and a one-time library re-analysis.

## 4. Post-render audio verification

`render:check` correlates frozen beat timestamps (`storedGridResidualMs`), never audio
(`audioStatus: "unmeasured"` on every join). A real onset-coincidence measurement on
rendered overlaps would catch what grids can't. See item 6 for why grids can lie.

## 5. Recipe persistence for hand-tuned joins

Join treatments pinned by hand (`updateSetPlan` + preview + approve, as done for the
Final Hours → Somewhere glide) live only on that plan's params. The approved-recipe
system should carry them to future mixes with the same pair. Workflow exists in
pieces (`feedback:rate`, approved-recipe repository); needs UX decisions.

## 6. ±2-beat label-swap blind spot (research)

If a track's downbeat labels are off by exactly 2 beats (kick↔snare swap), the lock's
own profiles inherit the swap (its kick-vs-snare penalty then _protects_ the wrong
answer) and the geometric snap trusts the labels. Detection needs audio ground truth
(kick-train coincidence at 0 vs ±172 ms in the overlap region), not grid correlation.
Unproven on real cases; do not build until a labeled instance exists.

## 7. Chain tempo lock contradicts the docs — RESOLVED (documented)

`buildEntries` locks the whole mix to the opening tempo after the first aligned
join; `docs/mixing.md` now documents this chain tempo lock explicitly (including
the crossfade re-anchor rule). Gradual tempo walking remains unimplemented and
out of scope until there is an auditioned reason to risk drift across long mixes.

## Calibration dataset

Labeled joins from this session (all on 174 BPM material, all verified by ear):

- Fresh liquid twenty (9 tracks, 8 joins): 6 perfect with slips (+8/−4/−2/+8/−8),
  1 abstention-correct (weak evidence), 1 content-conflict (Final Hours → Somewhere).
- Remaining liquid rise re-render (21 tracks, 20 joins): all phrase_mix, residuals 0.
- High energy twenty-two (6 tracks, 5 joins): green; Scorpio Moon quarantined to
  `Music/unmixable` as unmixable after audition.
