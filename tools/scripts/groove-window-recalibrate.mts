/**
 * Groove-window recalibration (F3, repository review 2026-10-08).
 *
 * The structural groove gate measured the outgoing's 16 bars BEFORE its
 * overlap until 8 October 2026; it now measures each side's bars inside the
 * actual overlap over the join's bar count. The labeled calibration pairs
 * and the 0.58 threshold were measured with the pre-fix window. This script
 * remeasures each labeled pair on both windows — without retuning anything —
 * and enumerates stored-plan joins whose template decision changes under the
 * corrected window, as the targeted-audition list the review asks for.
 *
 * Usage: pnpm tsx tools/scripts/groove-window-recalibrate.mts [--decisions]
 * (passive catalog runtime; no writes, no workers)
 */
import {
  PLANNER_GROOVE_LOCAL_WINDOW_BARS,
  PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP,
  loadConfig,
  pairTargetBpm,
} from "../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";
import { structuralGrooveConflict } from "../../packages/catalog/src/planning/shared.ts";
import {
  chooseTransition,
  type TimelineTrack,
} from "../../packages/catalog/src/planning/timeline.ts";
import { planPhraseWindow } from "../../packages/catalog/src/planning/windows.ts";

const LABELED_PAIRS: Array<{
  outgoing: string;
  incoming: string;
  label: string;
}> = [
  {
    outgoing: "X-Ray",
    incoming: "Somewhere",
    label: "BAD — gallops under every grid-aligned template",
  },
  { outgoing: "Look At Me Go", incoming: "Barren", label: "praised" },
  { outgoing: "Sanctuary", incoming: "Look At Me Go", label: "praised" },
  { outgoing: "Deep Space", incoming: "Look At Me Go", label: "praised" },
];

function meanGap(
  outgoing: TimelineTrack,
  incoming: TimelineTrack,
  window: { mixOutMs: number; mixInMs: number; barCount: number },
  mode: "pre-overlap" | "overlap-local",
): { gap: number | null; outBars: number; inBars: number } {
  const barMs = (4 * 60_000) / (outgoing.analysis?.bpm ?? 174);
  const result = structuralGrooveConflict(
    {
      syncopation: outgoing.analysis?.descriptors?.bars?.syncopation,
      bpm: outgoing.analysis?.bpm,
      downbeat0Ms: outgoing.analysis?.downbeatTimesMs?.[0] ?? null,
      windowStartMs:
        mode === "overlap-local"
          ? window.mixOutMs
          : window.mixOutMs - PLANNER_GROOVE_LOCAL_WINDOW_BARS * barMs,
      windowBars: mode === "overlap-local" ? window.barCount : PLANNER_GROOVE_LOCAL_WINDOW_BARS,
    },
    {
      syncopation: incoming.analysis?.descriptors?.bars?.syncopation,
      bpm: incoming.analysis?.bpm,
      downbeat0Ms: incoming.analysis?.downbeatTimesMs?.[0] ?? null,
      windowStartMs: window.mixInMs,
      windowBars: mode === "overlap-local" ? window.barCount : PLANNER_GROOVE_LOCAL_WINDOW_BARS,
    },
    Number.POSITIVE_INFINITY,
  );
  return {
    gap: result.gap == null ? null : Number(result.gap.toFixed(3)),
    outBars: structuralBars(result.outgoing),
    inBars: structuralBars(result.incoming),
  };
}

function structuralBars(side: { measuredBars: number } | null): number {
  return side?.measuredBars ?? 0;
}

function resolveWindow(
  outgoing: TimelineTrack,
  incoming: TimelineTrack,
): { mixOutMs: number; mixInMs: number; barCount: number } {
  const chosen = chooseTransition(outgoing, incoming, {});
  if (chosen.window) {
    return {
      mixOutMs: chosen.window.mixOutMs,
      mixInMs: chosen.window.mixInMs,
      barCount: chosen.window.barCount,
    };
  }
  const outBpm = outgoing.analysis?.canonicalBpm ?? outgoing.bpm ?? null;
  const inBpm = incoming.analysis?.canonicalBpm ?? incoming.bpm ?? null;
  const target = outBpm != null && inBpm != null ? pairTargetBpm(outBpm, inBpm) : null;
  const fallback = planPhraseWindow(outgoing, incoming, {
    dropAnchored: true,
    ...(target != null ? { targetBpm: target } : {}),
  });
  return {
    mixOutMs: fallback.mixOutMs,
    mixInMs: fallback.mixInMs,
    barCount: fallback.barCount,
  };
}

const runtime = createCatalogRuntime(loadConfig(), undefined, { passive: true });
try {
  const tracks = runtime.repository.listAll();
  const byTitle = (needle: string) =>
    tracks.find((track) => track.title.toLowerCase().includes(needle.toLowerCase()));

  console.log(
    `Groove gate recalibration — threshold ${PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP} unchanged; windows compared at the planner-chosen join window.\n`,
  );
  const newGaps: Array<{ pair: string; gap: number | null; label: string }> = [];
  for (const pair of LABELED_PAIRS) {
    const out = byTitle(pair.outgoing);
    const inc = byTitle(pair.incoming);
    if (!out || !inc) {
      console.log(`!! missing track for ${pair.outgoing} → ${pair.incoming}`);
      continue;
    }
    const outTl = { ...out, analysis: runtime.service.toTimeline(out) };
    const inTl = { ...inc, analysis: runtime.service.toTimeline(inc) };
    const chosen = chooseTransition(outTl, inTl, {});
    const window = resolveWindow(outTl, inTl);
    const oldM = meanGap(outTl, inTl, window, "pre-overlap");
    const newM = meanGap(outTl, inTl, window, "overlap-local");
    newGaps.push({
      pair: `${pair.outgoing} → ${pair.incoming}`,
      gap: newM.gap,
      label: pair.label,
    });
    console.log(`${pair.outgoing} → ${pair.incoming}  [${pair.label}]`);
    console.log(
      `  window: mixOut ${Math.round(window.mixOutMs)}ms, mixIn ${Math.round(window.mixInMs)}ms, ${window.barCount} bars — planner now chooses ${chosen.transition.type}`,
    );
    console.log(
      `  pre-overlap (old): gap ${oldM.gap ?? "null"} over ${oldM.outBars}/${oldM.inBars} bars   overlap-local (new): gap ${newM.gap ?? "null"} over ${newM.outBars}/${newM.inBars} bars`,
    );
    const oldFires = oldM.gap != null && oldM.gap > PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP;
    const newFires = newM.gap != null && newM.gap > PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP;
    console.log(
      `  gate @ ${PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP}: old window ${oldFires ? "CONFLICT" : "silent"} → new window ${newFires ? "CONFLICT" : "silent"}\n`,
    );
  }
  const measured = newGaps.filter((row) => row.gap != null);
  const bad = measured.filter((row) => row.label.startsWith("BAD"));
  const good = measured.filter((row) => !row.label.startsWith("BAD"));
  if (bad.length > 0 && good.length > 0) {
    const minBad = Math.min(...bad.map((row) => row.gap!));
    const maxGood = Math.max(...good.map((row) => row.gap!));
    console.log(
      `Summary on the corrected window: worst praised gap ${maxGood} vs best bad gap ${minBad} — threshold ${PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP} sits ${minBad > maxGood ? "inside the empty band" : "NOT inside the empty band (labeled pairs overlap or abstain)"} .`,
    );
  }

  if (process.argv.includes("--decisions")) {
    console.log("\nStored-plan joins whose template decision changes under the corrected gate:");
    const byId = new Map(tracks.map((track) => [track.id, track]));
    const summaries = runtime.setPlans.list(50).plans;
    let changes = 0;
    let alignedJoins = 0;
    for (const summary of summaries) {
      let stored: ReturnType<typeof runtime.setPlans.findById>;
      try {
        stored = runtime.setPlans.findById(summary.id);
      } catch {
        // Legacy rows that predate a persisted-schema change; skip them.
        continue;
      }
      if (!stored) continue;
      const plan = stored.plan;
      const entries = [...plan.entries].sort((a, b) => a.order - b.order);
      for (let i = 0; i < entries.length - 1; i += 1) {
        const out = byId.get(entries[i]!.trackId);
        const inc = byId.get(entries[i + 1]!.trackId);
        if (!out || !inc) continue;
        const outTl = { ...out, analysis: runtime.service.toTimeline(out) };
        const inTl = { ...inc, analysis: runtime.service.toTimeline(inc) };
        const storedType = entries[i]!.transitionToNext?.type ?? "none";
        if (storedType === "crossfade") continue;
        alignedJoins += 1;
        // Judge at the stored join's own window: the historical mix-out is
        // where the labeled praise/complaints were actually heard.
        const mixOutRaw = entries[i]!.transitionToNext?.parameters.mixOutMs;
        const mixInRaw = entries[i]!.transitionToNext?.parameters.mixInMs;
        const barCountRaw = entries[i]!.transitionToNext?.parameters.barCount;
        const mixOutMs = typeof mixOutRaw === "number" ? mixOutRaw : null;
        const mixInMs = typeof mixInRaw === "number" ? mixInRaw : null;
        const barCount = (typeof barCountRaw === "number" ? barCountRaw : 16) as 8 | 16 | 32;
        if (mixOutMs != null && mixInMs != null) {
          const atJoinOld = meanGap(outTl, inTl, { mixOutMs, mixInMs, barCount }, "pre-overlap");
          const atJoinNew = meanGap(outTl, inTl, { mixOutMs, mixInMs, barCount }, "overlap-local");
          const oldFires =
            atJoinOld.gap != null && atJoinOld.gap > PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP;
          const newFires =
            atJoinNew.gap != null && atJoinNew.gap > PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP;
          if (oldFires !== newFires) {
            changes += 1;
            console.log(
              `  ${plan.name}: join ${i} ${out.title} → ${inc.title} (${storedType}, ${barCount} bars): gate ${oldFires ? "fired" : "silent"} → ${newFires ? "FIRES" : "silent"} (gaps ${atJoinOld.gap ?? "null"} → ${atJoinNew.gap ?? "null"})${newFires ? "  ← AUDITION: planner would now crossfade" : ""}`,
            );
          }
        }
        const chosen = chooseTransition(outTl, inTl, {
          recall: runtime.service.recipeLookupFor(plan),
        });
        if (
          chosen.transition.type !== storedType &&
          !entries[i]!.transitionToNext?.parameters.appliedRecipeId
        ) {
          console.log(
            `  ${plan.name}: join ${i} ${out.title} → ${inc.title}: stored ${storedType} → fresh plan would choose ${chosen.transition.type} (${chosen.transition.parameters.reason})  ← AUDITION if replanned`,
          );
        }
      }
    }
    console.log(
      `  (${alignedJoins} aligned joins checked across the ${summaries.length} most recent plans; ${changes} gate decisions differ between windows)`,
    );
  }
} finally {
  await runtime.close();
}
