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

## 3. Feel-conformance analysis (prerequisite for item 1) — RESOLVED October 2026

To trigger item 1 safely the planner needs a per-section groove-conformance signal.
Shipped as `descriptors.grooveSyncopation` (DSP 3.9.1): the fraction of **kick+snare
backbone** onset energy between beats vs at beats. The originally proposed hat-band
dispersion was measured and rejected first: hats sit off-beat in nearly every DnB
track, so broadband/hat metrics compress the whole library into one high band
(X-Ray 0.63 vs Somewhere 0.76 — no separation). The backbone metric separates the
ear-labeled conflict pair decisively (X-Ray 0.84 vs Somewhere 0.44; gap 0.40 vs a
library IQR width of ~0.11). `backbeatConcentration` ships alongside it.

Planner consumption: a syncopation-gap penalty in `grooveCompatibility` (tolerance
0.12, slope 3, whole-track — soft steering) and a structural-conflict fallback in
`chooseTransition` gated on the **overlap-local** per-bar gap (each side measured
over the join's actual bar count from its mix-out/mix-in — corrected October 2026
per repository review F3; the previous K=16 window sampled the outgoing's bars
_before_ its overlap, material the blend never plays) with threshold 0.58 and
drum-sparse windows abstaining explicitly (`grooveAbstain` parameter) → crossfade
(reason `groove-syncopation-conflict`, evidence in `grooveGap`/`grooveOutBars`/
`grooveInBars`) because no grid-aligned template can blend structurally
incompatible backbones — bass_swap still crossfades mids/highs and
gallops (verified by audition). Approved recipes recall first and keep precedence.
See §Calibration dataset for why the gate is local-only: user-praised joins at
whole-track gaps up to 0.425 falsify any whole-track threshold. The 0.58 threshold
and the labeled-pair numbers above were measured with the pre-correction window;
remeasure the labeled pairs on the overlap-local window before tuning further.

Distinct failure mode confirmed by the same metric: Sakura → I Don't Wanna Wake Up
(0.753 vs 0.671, gap 0.08 — correctly NOT structural) gallops from misalignment,
not pattern conflict. Structural conflict and alignment error are now separable
before rendering.

## 4. Post-render audio verification — PARTIALLY IMPLEMENTED, reopened October 2026

The repository review (8 October 2026, F2) reopened this phase: the shipped
`render:check` audio path decodes the mixed master only. That scan measures mix
quality (stutter, clipping, holes, clicks) and reports it as `audioFindings`,
but it has no deck-attributed onset evidence, so it cannot verify kick/snare
coincidence versus shift — `audioStatus` honestly reports `unmeasured` for
alignment, and an inconclusive scan no longer clears a stored-grid failure
(the previous `advisory` state could). Historical green checks were real
listening evidence but not independent alignment verification.

Remaining for full resolution: the independent verifier over the two placed,
stretched deck probes and the final blend - coverage across overlap
start/middle/end, per-region confidence, ambiguity reporting, and calibration
against labeled good/bad joins (including whole-beat phase-equivalent shifts,
offbeat hats, and drifting grids) before any audio signal gates a render.

October 2026 (batch 7 first slice): an independent **deck-probe verifier**
now exists. `render:check` decodes each deck's OWN placed source window,
beat-locks the measured onset trains to the projected frozen grids, and
compares the trains in output time (`verifyDeckAlignment`): inter-deck
offset, start/end-half drift, and honest abstention when either train is
too sparse. Modes: `--audio fast` (default; a 10 s window at the overlap
midpoint) and `--audio full` (whole overlap, also reporting half-drift);
`--audio off` skips. Whole-beat relationships stay phase-equivalent
(bar-phase judgment needs downbeat anchors and belongs to the grid
checks). First calibration (`tools/scripts/audio-verifier-calibrate.mts`,
the two accepted-listen renders, 47 aligned joins): **0 measured fails,
12 pass, 7 review (14.9%), 28 unmeasured** - no hard false positives on
praised mixes; measured fails appear only on unlabeled draft renders. The
signal stays ADVISORY (warnings) until the labeled corpus grows and each
accepted-review is understood; the stored-grid residual remains the only
alignment gate.

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
- October 2026 groove-metric calibration (544-track library, DSP 3.9.1):
  X-Ray (Metrik Remix) 0.841 / Somewhere (Grafix) 0.442 — gap 0.399, gallops under
  every grid-aligned template including bass_swap; crossfade is the only clean
  treatment. Sakura 0.753 / I Don't Wanna Wake Up 0.671 — gap 0.082, within
  tolerance (its gallop is alignment, not structure). Library distribution:
  min 0.243 (Technimatic — You Call Me), median 0.558, max 0.883 (DJ Crystl —
  Mind Games); face-valid ordering (liquid rollers lowest, choppy/jungle highest).
- October 2026 local recalibration (DSP 3.10.0, per-bar syncopation): the
  whole-track gate at 0.25 was falsified by replaying 5457 historical joins —
  four user-praised joins sit at whole-track gaps 0.354–0.425 (Look At Me Go →
  Barren "Very very good / deep. More of this"; Deep Space → Look At Me Go
  "very nice"; Sanctuary → Look At Me Go "Almost perfect"), overlapping the
  bad X-Ray → Somewhere pair (0.400). Overlap-local windows (K=16 bars per
  side) separate all four labeled pairs cleanly: praised pairs 0.174 / 0.176 /
  0.447 vs bad 0.706 — threshold 0.58 in the empty band. Gate fires only on
  local measurement; sparse or unmeasured windows leave it silent.
- October 2026 overlap-local correction remeasurement (repository review F3;
  `tools/scripts/groove-window-recalibrate.mts`): the numbers above were
  taken with the pre-fix window, which sampled the outgoing's 16 bars
  _before_ its mix-out. Replaying every stored join of the 50 most recent
  plans (576 aligned joins) at each join's own mix-out/mix-in found **zero
  gate decisions that differ between the old and corrected windows** — no
  existing plan changes treatment, so no forced auditions. At the fresh
  planner's current windows the four labeled pairs all measure 0.186–0.33 on
  both windows (gate silent; the labeled 0.706 lived at the historical
  join's mix-out, and fresh planning now lands elsewhere — one stored
  "Sparse-aware" join X-Ray → Somewhere does crossfade on replan for exactly
  this reason). Threshold 0.58 retained: it still catches the labeled bad
  pair where that conflict is actually placed and rejects none of the
  praised pairs. The larger fresh-plan change comes from the bass-swap
  trigger's own overlap-local rescoring, which flips a few dozen fresh
  template choices in both directions — audition those on the next replan,
  not the whole library.
- **October 2026 first A/B audition of the overlap-local trigger**
  (`tools/scripts/audition-previews.mts`, 9 October): six recurring flip
  pairs rendered OLD vs NEW on the same frozen windows. Verdicts: 4/6 fresh
  choices confirmed (Hayling→Pieces and Still In Love→Pathways prefer
  bass_swap+glide; Signs→Picton Blues and Pathways→All Our Yesterdays
  prefer the blend), 2/6 preferred the old phrase_mix (Moment to
  Moment→Better Perspective, Coming Down→In The Woods). User principle:
  _phrase_mix is always better when it works — it preserves volume and
  keeps energy flowing; bass_swap fades the outgoing out too much before
  the incoming fades in, leaving a volume/energy dip._ Measurement: all
  four automatic triggers sat in a −0.002..−0.207 groove-score band with
  no separation by outcome (the phrase_mix-preferring pair scored MORE
  negative than one bass_swap-preferring pair) — the old `groove < 0.0`
  bar fired on rounding noise (~10% of library pairs). Library-wide
  distribution (173 distinct pairs): p10 −0.002, median 0.26, only 5
  pairs below −0.2, 1 below −0.45; the designed kick/snare label-swap
  case scores ≈−0.95. **The automatic trigger now requires a decisive
  conflict (`PLANNER_BASS_SWAP_TRIGGER_GROOVE = −0.45`)**: mild negatives
  stay phrase_mix; joins that prefer bass_swap without decisive conflict
  belong in approved recipes. All 12 A/B verdicts were recorded as
  transition feedback on the exact preview renders, so the two hand-liked
  bass swaps are recallable while the trigger is tight. Provisional
  pending more labeled pairs.
- October 2026 groove-sync plan audition (23 tracks, same seed/brief as the
  kick-weighted plan): X-Ray drops out of the set entirely, all 22 joins
  phrase_mix within a 0.44–0.65 syncopation band, render:check green, and the
  user reports all joins mostly good — the first full mix with no gallop
  complaints after four iterations (4 → 6 → 2 → 0 problem joins).
- October 2026 groove-fresh audition (26 tracks, seed 7): all five
  groove-triggered bass_swap+glide joins passed by ear. Two joins flagged
  "slightly off, drums don't line up" — both diagnosed by measurement and
  both tracks quarantined to `Music/unmixable`:
  - Heatwave → We Can Have It All (Sigma Remix): WCHIA's stored grid ran
    93 ms early against its own audio (region-verified; tempo also wanders
    174.3–175.5 across the track). Grid corrected +93 ms, but the variable
    tempo makes every long window a drift risk → quarantined.
  - Everything Is Possible → Snow: grids correct; Snow's blend region is
    triplet-groove (beat-phase histogram peaks at ⅓/⅔ beat, local sync
    0.70) under a straight dense tail. An 8-bar landing into Snow's
    straighter bars (sync 0.30–0.60) still wasn't fully clean → quarantined.
    Both join types are now measurable: grid phase error via per-region
    phase scan, triplet content via beat-phase histogram — candidates for
    analyzer diagnostics (see item 6).
    After quarantine, the plan was surgically rebuilt (24 of 26 entries kept
    their auditioned transitions; only the two orphaned joins recomputed) and
    the final mix passed audition: "two new joins hold up. mix is good."
    The beatmatching plan is fully auditioned.
- October 2026 grid-phase detector calibration (DSP 3.12.0–3.12.3, three
  iterations on the live library): broadband scan flagged 44% at exactly
  half a beat (172ms) — off-beat hats; the kick+snare backbone still
  flagged 296 at half a beat — syncopated basslines share the sub band;
  the decisive-margin rule (>25%) didn't separate them. The discriminator
  that worked is scale: genuine grid errors are sub-beat (the WCHIA class
  measures ~90–100ms), half-beat dominance is content. 3.12.3 bounds
  flaggable shifts to 20–110ms: the half-beat cluster is eliminated
  (0 tracks >130ms), leaving 159 suspects in the 40–110ms gray zone where
  16th-note syncopation (~86ms at 174) overlaps real drift. Advisory-only
  — no planner path consumes it. Calibration continues opportunistically:
  each future "slightly off" ear report carries the track's measured
  error, building the labeled set that separates the gray zone (Sakura
  106ms was audibly bad; Starchild's Theme 110ms auditioned clean — the
  band is genuinely mixed).
