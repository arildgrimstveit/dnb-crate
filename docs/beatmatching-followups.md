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
0.12, slope 3) and a structural-conflict fallback in `chooseTransition` (gap > 0.25
→ crossfade, reason `groove-syncopation-conflict`) because no grid-aligned template
can blend structurally incompatible backbones — bass_swap still crossfades
mids/highs and gallops (verified by audition).

Distinct failure mode confirmed by the same metric: Sakura → I Don't Wanna Wake Up
(0.753 vs 0.671, gap 0.08 — correctly NOT structural) gallops from misalignment,
not pattern conflict. Structural conflict and alignment error are now separable
before rendering.

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
- October 2026 groove-metric calibration (544-track library, DSP 3.9.1):
  X-Ray (Metrik Remix) 0.841 / Somewhere (Grafix) 0.442 — gap 0.399, gallops under
  every grid-aligned template including bass_swap; crossfade is the only clean
  treatment. Sakura 0.753 / I Don't Wanna Wake Up 0.671 — gap 0.082, within
  tolerance (its gallop is alignment, not structure). Library distribution:
  min 0.243 (Technimatic — You Call Me), median 0.558, max 0.883 (DJ Crystl —
  Mind Games); face-valid ordering (liquid rollers lowest, choppy/jungle highest).
- October 2026 groove-sync plan audition (23 tracks, same seed/brief as the
  kick-weighted plan): X-Ray drops out of the set entirely, all 22 joins
  phrase_mix within a 0.44–0.65 syncopation band, render:check green, and the
  user reports all joins mostly good — the first full mix with no gallop
  complaints after four iterations (4 → 6 → 2 → 0 problem joins).
