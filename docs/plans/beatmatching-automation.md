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

**Goal:** give the planner the one signal aggregates can't provide: does this
window's percussion sit on a grid?

**Steps:**

1. Extend the DSP analyzer (`packages/audio-analysis/src/dsp-analyzer.ts`) with
   per-section groove metrics: hat-band transient phase dispersion vs. own grid,
   snare-backbeat concentration. Store on the analysis row (descriptors extension).
2. Bump `DSP_ANALYZER_VERSION`; run `analysis:run --scope stale` over the library
   (one-time cost, ~545 tracks here).
3. Calibrate thresholds against the labeled joins in `beatmatching-followups.md`
   §Calibration dataset: must separate Somewhere-build (conflict) from
   Rosewood-head (clean) and Livid-build (clean) with margin on both sides.
4. Tests: synthetic fixtures (straight vs. swung vs. sparse-syncopated builds).

**Risk:** high if miscalibrated (flips good joins). Mitigations: thresholds need
clearance on all three calibration cases; new metric is advisory-only until Phase 3
auditions pass. **Do not build Phase 3 on uncalibrated metrics.**

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
- **Chain tempo lock:** document the opening-tempo lock in `docs/mixing.md`, or
  implement gradual walking with a drift budget. Decision needed before code.
- **±2-beat swap detection:** research only. Needs a labeled real instance plus the
  audio-ground-truth harness from Phase 4. Do not build blind.

## Acceptance bar for all phases

- `pnpm typecheck`, `pnpm lint`, `prettier --check`, full `pnpm test` green.
- No previously-green auditioned join changes behavior without an explicit,
  auditioned reason (the fresh-mix join table is the regression oracle — see the
  byte-identical-positions check used this session).
- Audition gates are mandatory for Phases 1 and 3; previews are seconds, full
  renders are minutes — use previews.
