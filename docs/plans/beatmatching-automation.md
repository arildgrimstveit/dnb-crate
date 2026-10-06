# Implementation plan: beatmatching automation follow-ups

Companion to [`../beatmatching-followups.md`](../beatmatching-followups.md), which holds
the evidence. Nothing here is started. Proposed build order is by risk, cheapest
verification first. Every policy change ships behind a preview audition, never straight
to a full render.

## Phase 0 — already shipped (reference only)

Anchored onset-lock, sub-beat composition, `SCORE_FLOOR`, feasibility tempo gate,
`TEMPO_MISMATCH`, `maxBars` plumbing, breakdown-entry 32s, `onsetLockBeats`
provenance, check attribution fix, lock-aware tripwire, `lowFadeBars`, `plan:delete`.
Covered by: `planning/onset-lock.test.ts`, `windows.test.ts`, `planning.test.ts`,
`check-metrics.test.ts`, `mix-presets.test.ts`, `render.test.ts`.

## Phase 1 — held incoming fades for sparse heads (S–M)

**Goal:** planner sets `landingIncomingFadeBars` (8 for ≤16-bar, 12 for 32-bar
landings) when the incoming head's first half is drum-empty but drums enter later
in the window (measured from stored `bars.onsetDensity`, same currency as
`breakdownEntry`).

**Steps:**

1. Add the rule in `planPhraseWindow` where `landingFadeBars` is currently derived
   (`scoreHandoff` in `planning/handoff.ts` is the natural home — it already sees
   `incomingBars`).
2. Unit tests mirroring the breakdown-entry tests: sparse-head fixture gets the
   hold; dense-head fixture does not.
3. **Audition gate:** preview one sparse-head landing before/after on a real pair.
   Ship only if ears agree.

**Risk:** low — opt-in param path already tested; default behavior unchanged when the
head has drums. **Out of scope:** changing fade shapes, touching the lock.

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

1. Calibration against the labeled joins in `beatmatching-followups.md`
   §Calibration dataset beyond the X-Ray/Somewhere pair — especially
   confirming the 0.25 structural threshold doesn't crossfade joins that
   used to pass.
2. Tests: synthetic fixtures (straight vs swung vs sparse-syncopated builds).

**Risk:** high if miscalibrated (flips good joins). Mitigations: thresholds
need clearance on all calibration cases; the planner penalty is advisory
scoring, but the structural fallback changes template choice — audition every
pair it fires on before trusting it. **Do not build Phase 3 on uncalibrated
metrics.**

## Phase 3 — automatic bass_swap-plus-glide (M, needs Phase 2 + audition)

**Goal:** planner selects `bass_swap` + hats crossfade + `lowFadeBars` glide when
outgoing tail is drum-dense AND incoming head shows positive groove conflict
(Phase 2 metric), instead of blending two incompatible grooves.

**Steps:**

1. Add the selection rule where transition types are ranked (`planTransition`
   proposal ranking + set-plan path), gated on the Phase 2 metric — never on
   aggregates (proven unable to separate the calibration cases).
2. Set `lowFadeBars` 12 for 32-bar / 8 for 16-bar in that branch.
3. **Audition gate:** the exact Final Hours → Somewhere pair must render
   indistinguishable-or-better vs. the hand-pinned approved version; plus one
   fresh dense-out/sparse-in pair where the old code was already fine (must not
   regress — this is the join-5 guard).
4. Full-suite green + a fresh full-mix render:check green before merge.

**Risk:** medium. Explicit non-goal: touching pairs the rule doesn't fire on.

## Phase 4 — post-render audio verification (M–L)

**Goal:** `render:check` measures onset coincidence on rendered overlaps instead of
only correlating frozen grids.

**Steps:**

1. Prototype offline (throwaway script, as done this session): decode overlap
   regions from the two sources, band-split transients, coincidence-vs-shift curves.
2. Define pass/review/fail bands calibrated on green vs. flagged historical renders.
3. Wire into `checkRender` as an additional signal (advisory first, gating later).

**Risk:** medium — measurement must be robust to sparse builds (few transients =
"unmeasured", never "fail").

## Phase 5 — small items (S, any order)

- **Recipe persistence:** save hand-tuned joins (params + windows) as reusable
  approved recipes; surface "sounds like a previous approval" in planning. Needs
  UX decisions first.
- **Chain tempo lock:** RESOLVED October 2026 — the opening-tempo lock (with the
  crossfade re-anchor rule) is now documented in `docs/mixing.md`. Gradual walking
  with a drift budget stays out of scope unless an auditioned need appears.
- **±2-beat swap detection:** research only. Needs a labeled real instance plus the
  audio-ground-truth harness from Phase 4. Do not build blind.

## Acceptance bar for all phases

- `pnpm typecheck`, `pnpm lint`, `prettier --check`, full `pnpm test` green.
- No previously-green auditioned join changes behavior without an explicit,
  auditioned reason (the fresh-mix join table is the regression oracle — see the
  byte-identical-positions check used this session).
- Audition gates are mandatory for Phases 1 and 3; previews are seconds, full
  renders are minutes — use previews.
