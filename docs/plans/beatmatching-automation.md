# Implementation plan: beatmatching automation follow-ups

> **Status: HISTORICAL SNAPSHOT.** Superseded by the
> [10 October implementation review](implementation-review-2026-10-10.md) as the active
> backlog. Shipped diagnostics (grid-phase suspicion consumed by the planning pool,
> groove gates, bass-swap trigger) are marked shipped in [`../beatmatching-followups.md`](../beatmatching-followups.md).

Companion to [`../beatmatching-followups.md`](../beatmatching-followups.md), which holds
the evidence. Every policy change ships behind a preview audition, never straight
to a full render.

**Status October 2026:** Phases 2, 3, 4 shipped; Phase 1 implemented pending
audition; Phase 5 remains (research item open). See each phase below.

## Phase 0 — already shipped (reference only)

Anchored onset-lock, sub-beat composition, `SCORE_FLOOR`, feasibility tempo gate,
`TEMPO_MISMATCH`, `maxBars` plumbing, breakdown-entry 32s, `onsetLockBeats`
provenance, check attribution fix, lock-aware tripwire, `lowFadeBars`, `plan:delete`.
Covered by: `planning/onset-lock.test.ts`, `windows.test.ts`, `planning.test.ts`,
`check-metrics.test.ts`, `mix-presets.test.ts`, `render.test.ts`.

## Phase 1 — held incoming fades for sparse heads (S–M)

**Status: implemented October 2026, pending audition.** `scoreHandoff` now
derives `landingIncomingFadeBars` (8 for 16-bar / 16 for 32-bar landings)
when the incoming head's first half is drum-empty but drums enter later in
the window (front/back split of `bars.onsetDensity`, thresholds 0.15/0.30).
Drop-aligned landings are excluded — the renderer's drop-anchored fade
(`incomingDropMs`) is more precise than the onset-density heuristic. The
non-drop-anchored window path (previously no continuity at all) computes
the hold. Covered by `handoff.test.ts`.

**Remaining:** one before/after preview audition on a real sparse-head pair
(Ship only if ears agree).

## Phase 2 — feel-conformance analysis (L, prerequisite for Phase 3)

**Status: core metric shipped October 2026 (DSP 3.9.x).** The X-Ray (Metrik
Remix) → Somewhere (Grafix) investigation replaced the planned hat-band
dispersion with a stronger discriminator: **backbone (kick+snare)
syncopation** — the fraction of kick+snare onset energy between beats vs at
beats, stored as `descriptors.grooveSyncopation` (plus
`descriptors.backbeatConcentration` for snare placement). Broadband/hat-band
energy was measured first and rejected: hats sit off-beat in nearly every DnB
track, so it compressed all tracks into the same high range (X-Ray 0.63 vs
Somewhere 0.76 — no separation). The backbone metric separates the
ear-diagnosed pair decisively: X-Ray 0.84 (syncopated two-step, "boom bap
**boombap**") vs Somewhere 0.44 (straight two-step, "boom bap boom bap").

Shipped with it, calibrated on that pair:

- `grooveCompatibility` syncopation-gap penalty (tolerance 0.12, slope 3,
  `PLANNER_GROOVE_*` constants) — steers the planner away from
  structurally incompatible pairs.
- `chooseTransition` structural-conflict fallback: gap > 0.25 → `crossfade`
  ("groove-syncopation-conflict"), because **no grid-aligned template works**
  for such pairs — phrase_mix aligns grids and the off-grid hits collide;
  bass_swap still crossfades mids/highs and gallops (verified by audition,
  October 2026). Approved recipes recall first and keep precedence.

**Remaining for this phase:**

1. ~~Calibration against the labeled joins~~ — **done October 2026, and it
   reshaped the gate**: replaying every historical join showed four
   user-praised joins at whole-track gaps 0.35–0.43 (Look At Me Go → Barren
   "Very very good", Deep Space → Look At Me Go "very nice", …) overlapping
   the X-Ray→Somewhere bad pair (0.40). Whole-track syncopation cannot
   separate praised from bad — the difference is _where the overlap lands_.
   DSP 3.10.0 added per-bar syncopation (`bars.syncopation`, null = no
   measurable backbone); the structural gate fires only on the
   **overlap-local** gap — each side measured over the join's actual bar
   count starting at its mix-out/mix-in (corrected October 2026, repository
   review F3: the earlier fixed K=16 window sampled the outgoing's bars
   _before_ its overlap) — with threshold 0.58 sitting in the
   empty calibration band (praised max 0.447 vs bad 0.706, both measured
   with the pre-correction window; remeasure before tuning). Drum-sparse
   windows abstain explicitly (`grooveAbstain`) and missing series leave
   the gate silent — no gate beats a wrong gate. The whole-track
   syncopation-gap **penalty** stays in planner
   scoring as soft steering.
2. ~~Tests~~ — synthetic separation + per-bar locality tests shipped
   (`dsp-analyzer.test.ts`, `groove.test.ts`). The planned "swung" fixture
   was closed as not-constructible: uniform swing is invisible to a
   grid-relative measurement by construction (and correctly so — two
   uniformly-pocketed grooves blend fine).

**Risk:** high if miscalibrated (flips good joins). Mitigations: thresholds
need clearance on all calibration cases; the planner penalty is advisory
scoring, but the structural fallback changes template choice — audition every
pair it fires on before trusting it. **Do not build Phase 3 on uncalibrated
metrics.**

## Phase 3 — automatic bass_swap-plus-glide (M, needs Phase 2 + audition)

**Status: implemented October 2026 in reduced scope, pending audition.**
Groove-triggered bass_swaps (`groove-kick-conflict`: incompatible kick
placement with compatible syncopation) now carry `lowFadeBars` — 12 for
32-bar / 8 for 16-bar — so the low end glides across the handover instead
of hard-dumping. Re-scoped from the original plan: structurally
incompatible pairs (overlap-local gap > 0.58) crossfade instead of
bass_swapping, because the auditioned evidence showed bass_swap's
mid/high crossfade still gallops on those. The original Final Hours →
Somewhere audition pair no longer triggers the rule (Final Hours' grid is
rejected, so no beat profiles), which is itself correct behavior: its
approved treatment lives in the recipe registry.

**Remaining:** one audition of a groove-triggered bass_swap with the glide
(preview, before/after vs no `lowFadeBars`), plus the join-5 guard: a pair
the old code handled well must not change.

## Phase 4 — post-render audio verification (M–L)

**Status: partially shipped; reopened October 2026 (repository review F2).**
`checkRender` decodes a window of the rendered master around each suspicious
join and measures mix quality (stutter, clipping, overlap holes, boundary
discontinuities) as `audioFindings`. A mixed waveform cannot attribute
transients to decks, so beat alignment stays honestly `unmeasured` per join and
an inconclusive scan never clears a stored-grid failure (the earlier
`advisory`-clears-failure behavior was removed). The documented
onset-coincidence verifier over the two placed decks and the final blend is
still to be built and calibrated against labeled good/bad joins; until then no
audio signal gates a render. The October 2026 groove-sync full mix checked
green end to end and auditioned well — that is listening evidence, not
independent alignment verification.

## Phase 5 — small items (S, any order)

- **Recipe persistence:** the approved-recipe registry is live (fingerprinted
  payloads, `recallApprovedHandoff` in planning with precedence over fresh
  selection, `feedback:rate` ingestion). Remaining UX: surfacing "sounds like
  a previous approval" at plan-review time.
- **Chain tempo lock:** RESOLVED October 2026 — the opening-tempo lock (with the
  crossfade re-anchor rule) is now documented in `docs/mixing.md`. Gradual walking
  with a drift budget stays out of scope unless an auditioned need appears.
- **±2-beat swap detection:** research, now with labeled candidate material:
  X-Ray (Metrik Remix) gallops under every grid-aligned alignment including
  downbeat-snapped ones — consistent with a mislabeled downbeat (the lock
  inherits the swap, so no whole-beat shift fixes it). Counterexample-driven
  caution: Deep Space → Look At Me Go has the same syncopation shape and
  sounds great, so the label swap must be confirmed by the Phase 4
  audio-ground-truth harness (kick-train coincidence at 0 vs ±2 beats in
  the overlap) before any analysis-level fix is built.

## Acceptance bar for all phases

- `pnpm typecheck`, `pnpm lint`, `prettier --check`, full `pnpm test` green.
- No previously-green auditioned join changes behavior without an explicit,
  auditioned reason (the fresh-mix join table is the regression oracle — see the
  byte-identical-positions check used this session).
- Audition gates are mandatory for Phases 1 and 3; previews are seconds, full
  renders are minutes — use previews.
