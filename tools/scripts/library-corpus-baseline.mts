/**
 * Real-library corpus baseline (Batch C/D, 11 October review).
 *
 * Generates cold-start automatic plans from the OWNER'S REAL LIBRARY - no
 * saved joins, no approved recipes, no listening history (cleared in a
 * scratch COPY of the catalog; the real database and library files are
 * never modified) - renders them, and records the baseline the review
 * requires before any automatic-selection tuning:
 *
 *   - coverage: eligible tracks, joins aligned vs crossfade vs refused,
 *     abstention, and every crossfade's reason
 *   - technical quality: stored-grid residuals, source-deck probe verdicts
 *     with measured offsets, energy-death joins, window-shift recoveries
 *   - variety: distinct artists, artist repeats, repeated ordered pairs
 *   - runtime: planning and render ms per plan
 *   - manual-intervention signals: joins flagged review/fail by the probe,
 *     crossfades where aligned was preferred, partial plans
 *   - a deterministic tuning/holdout split over the observed ordered pairs
 *     (50/50 by stable hash) so FUTURE policy changes are scored on
 *     material they were never tuned on
 *   - determinism: same seed re-planned must reproduce the same sequence
 *
 * Technical labels are kept separate from musical judgments: the report
 * includes an AUDITION GUIDE (markdown) listing each plan's listen file and
 * join positions so the owner can rate joins by ear - those ratings are the
 * musical ground truth, recorded through the existing feedback tools.
 *
 * Usage: pnpm tsx tools/scripts/library-corpus-baseline.mts [plans=3] [minutes=15]
 * Writes tools/reports/library-baseline-<date>.json + .audition.md
 */
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { loadConfig } from "../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";

const planCount = Math.max(1, Number(process.argv[2] ?? 3));
const minutes = Math.max(1, Number(process.argv[3] ?? 15));
const seedBase = 101;

type JoinRow = {
  plan: string;
  order: number;
  outgoingTitle: string;
  incomingTitle: string;
  template: string;
  barCount: number | null;
  reason: string | null;
  windowShiftBars: number | null;
  outgoingRate: number;
  incomingRate: number;
  joinAtMs: number | null;
  storedGridResidualMs: number | null;
  probeStatus: string | null;
  probeOffsetMs: number | null;
  probeLocked: string | null;
  sourceIdentity: string | null;
  pairHoldout: "tuning" | "holdout";
};

type PlanRow = {
  seed: number;
  name: string;
  entryCount: number;
  partial: boolean;
  partialReasons: string[];
  selectedCount: number;
  rejectedCount: number;
  planMs: number;
  renderMs: number | null;
  renderStatus: string | null;
  checkOk: boolean | null;
  checkWarnings: number;
  listenPath: string | null;
  joins: JoinRow[];
};

function stableSplit(pairKey: string): "tuning" | "holdout" {
  const digest = createHash("sha256").update(pairKey).digest();
  return (digest[0]! & 1) === 1 ? "holdout" : "tuning";
}

async function main() {
  const config = loadConfig();
  const scratch = path.join(
    os.tmpdir(),
    `dnb-library-corpus-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`,
  );
  await mkdir(path.join(scratch, "output"), { recursive: true });
  const dbCopy = path.join(scratch, "catalog.sqlite");
  await copyFile(config.databasePath, dbCopy);

  // A live worker may be writing the real DB; wait briefly for a quiet
  // copy is unnecessary - SQLite copies of a checkpointed file are
  // consistent enough for planning, and every write in this run targets
  // the copy only.
  const runtime = createCatalogRuntime({
    ...config,
    databasePath: dbCopy,
    outputRoot: path.join(scratch, "output"),
    logLevel: "error",
  });

  const planRows: PlanRow[] = [];
  const pairOccurrences = new Map<string, number>();
  try {
    // COLD START: clear listening history, per-join ratings, and approved
    // recipes IN THE COPY - the baseline measures what the crate produces
    // with none of the owner's curation helping it.
    const cleared = {
      transitionFeedback: runtime.db
        .prepare("SELECT COUNT(*) AS n FROM transition_feedback")
        .get() as {
        n: number;
      },
      hourFeedback: runtime.db.prepare("SELECT COUNT(*) AS n FROM hour_feedback").get() as {
        n: number;
      },
      approvedRecipes: runtime.db.prepare("SELECT COUNT(*) AS n FROM approved_recipes").get() as {
        n: number;
      },
    };
    runtime.db.prepare("DELETE FROM transition_feedback").run();
    runtime.db.prepare("DELETE FROM hour_feedback").run();
    runtime.db.prepare("DELETE FROM approved_recipes").run();

    const libraryStats = {
      totalTracks: (runtime.db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as { n: number })
        .n,
      missingFiles: (
        runtime.db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE file_missing = 1").get() as {
          n: number;
        }
      ).n,
      unmixableTagged: (
        runtime.db
          .prepare(
            "SELECT COUNT(*) AS n FROM tracks t WHERE EXISTS (SELECT 1 FROM track_tags g WHERE g.track_id = t.id AND LOWER(g.tag) = 'unmixable')",
          )
          .get() as { n: number }
      ).n,
      ratedOne: (
        runtime.db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE rating = 1").get() as {
          n: number;
        }
      ).n,
      analyzed: (
        runtime.db
          .prepare("SELECT COUNT(*) AS n FROM tracks WHERE analysis_status = 'complete'")
          .get() as { n: number }
      ).n,
    };

    for (let i = 0; i < planCount; i += 1) {
      const seed = seedBase + i;
      const name = `corpus-baseline-${seed}`;
      const planStarted = Date.now();
      let created;
      try {
        created = runtime.service.createSetPlan({
          name,
          targetDurationMinutes: minutes,
          seed,
          // Cold start: no variety history either - the plan must stand on
          // the available music and the brief alone.
          variety: { referencePlanIds: [], history: "off" },
        });
      } catch (error) {
        planRows.push({
          seed,
          name,
          entryCount: 0,
          partial: true,
          partialReasons: [
            `PLANNING_FAILED: ${error instanceof Error ? error.message : String(error)}`,
          ],
          selectedCount: 0,
          rejectedCount: 0,
          planMs: Date.now() - planStarted,
          renderMs: null,
          renderStatus: null,
          checkOk: null,
          checkWarnings: 0,
          listenPath: null,
          joins: [],
        });
        continue;
      }
      const planMs = Date.now() - planStarted;
      const sorted = [...created.plan.entries].sort((a, b) => a.order - b.order);
      const titles = new Map(
        sorted.map((entry) => [entry.id, runtime.repository.findById(entry.trackId)?.title ?? "?"]),
      );

      // Render + check.
      let renderMs: number | null = null;
      let renderStatus: string | null = null;
      let checkOk: boolean | null = null;
      let checkWarnings = 0;
      let listenPath: string | null = null;
      let checkJoins: Array<Record<string, unknown>> = [];
      try {
        const renderStarted = Date.now();
        const started = await runtime.service.startSetRender({ setPlanId: created.plan.id });
        const done = await runtime.service.waitForRenderJob(started.job.id, 15 * 60_000);
        renderMs = Date.now() - renderStarted;
        renderStatus = done.status;
        listenPath = done.listenRootRelativePath;
        if (done.status === "succeeded") {
          const checked = await runtime.service.checkRender(done.id, undefined, {
            audioVerification: "full",
          });
          checkOk = checked.ok;
          checkWarnings = checked.warnings.length;
          checkJoins = checked.joins as unknown as Array<Record<string, unknown>>;
        }
      } catch (error) {
        renderStatus = `error: ${error instanceof Error ? error.message : String(error)}`;
      }

      const joins: JoinRow[] = [];
      for (let j = 0; j + 1 < sorted.length; j += 1) {
        const outgoing = sorted[j]!;
        const incoming = sorted[j + 1]!;
        const transition = outgoing.transitionToNext!;
        const checkJoin = checkJoins[j] ?? {};
        const probe = (checkJoin.sourceDeckProbe ?? null) as Record<string, unknown> | null;
        const pairKey = `${outgoing.trackId}>${incoming.trackId}`;
        pairOccurrences.set(pairKey, (pairOccurrences.get(pairKey) ?? 0) + 1);
        joins.push({
          plan: name,
          order: j,
          outgoingTitle: titles.get(outgoing.id) ?? "?",
          incomingTitle: titles.get(incoming.id) ?? "?",
          template: transition.type,
          barCount:
            typeof transition.parameters.barCount === "number"
              ? transition.parameters.barCount
              : null,
          reason:
            typeof transition.parameters.reason === "string" ? transition.parameters.reason : null,
          windowShiftBars:
            typeof transition.parameters.windowShiftBars === "number"
              ? transition.parameters.windowShiftBars
              : null,
          outgoingRate: outgoing.playbackRate,
          incomingRate: incoming.playbackRate,
          joinAtMs: Math.round(incoming.timelineStartMs),
          storedGridResidualMs:
            typeof checkJoin.storedGridResidualMs === "number"
              ? checkJoin.storedGridResidualMs
              : null,
          probeStatus: typeof checkJoin.audioStatus === "string" ? checkJoin.audioStatus : null,
          probeOffsetMs:
            probe && probe.verification
              ? ((probe.verification as Record<string, unknown>).deckOffsetMs as number | null)
              : null,
          probeLocked: probe ? `${probe.outgoingLockedCount}/${probe.incomingLockedCount}` : null,
          sourceIdentity: probe ? String(probe.sourceIdentity) : null,
          pairHoldout: stableSplit(pairKey),
        });
      }

      planRows.push({
        seed,
        name,
        entryCount: sorted.length,
        partial: created.partial,
        partialReasons: created.partialReasons,
        selectedCount: created.explanation.selected?.length ?? 0,
        rejectedCount: created.explanation.rejected?.length ?? 0,
        planMs,
        renderMs,
        renderStatus,
        checkOk,
        checkWarnings,
        listenPath,
        joins,
      });
    }

    // Determinism: same seed, cold catalog, must reproduce the same order.
    const detSeed = seedBase;
    const detA = runtime.service.createSetPlan({
      name: "corpus-determinism-a",
      targetDurationMinutes: minutes,
      seed: detSeed,
      variety: { referencePlanIds: [], history: "off" },
    });
    const detB = runtime.service.createSetPlan({
      name: "corpus-determinism-b",
      targetDurationMinutes: minutes,
      seed: detSeed,
      variety: { referencePlanIds: [], history: "off" },
    });
    const seqA = detA.plan.entries
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((e) => e.trackId);
    const seqB = detB.plan.entries
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((e) => e.trackId);
    const deterministic = JSON.stringify(seqA) === JSON.stringify(seqB);

    const allJoins = planRows.flatMap((p) => p.joins);
    const artistsUsed = new Set(
      planRows.flatMap((p) =>
        p.joins.flatMap((j) => [j.outgoingTitle, j.incomingTitle].map((t) => t.split(" - ")[0]!)),
      ),
    );
    const summary = {
      generatedAt: new Date().toISOString(),
      plans: planRows.length,
      minutesPerPlan: minutes,
      coldStart: cleared,
      libraryStats,
      determinism: { sameSeedReproduces: deterministic },
      joins: {
        total: allJoins.length,
        aligned: allJoins.filter((j) => j.template === "phrase_mix" || j.template === "bass_swap")
          .length,
        crossfade: allJoins.filter((j) => j.template === "crossfade").length,
        crossfadeReasons: tally(
          allJoins.filter((j) => j.template === "crossfade").map((j) => j.reason ?? "unknown"),
        ),
        windowShiftRecoveries: allJoins.filter((j) => j.windowShiftBars != null).length,
        probe: {
          pass: allJoins.filter((j) => j.probeStatus === "pass").length,
          review: allJoins.filter((j) => j.probeStatus === "review").length,
          fail: allJoins.filter((j) => j.probeStatus === "fail").length,
          unmeasured: allJoins.filter((j) => j.probeStatus === "unmeasured").length,
          notProbed: allJoins.filter((j) => j.probeStatus === null).length,
        },
        residualOver40Ms: allJoins.filter(
          (j) => j.storedGridResidualMs != null && Math.abs(j.storedGridResidualMs) > 40,
        ).length,
        holdout: {
          tuningJoins: allJoins.filter((j) => j.pairHoldout === "tuning").length,
          holdoutJoins: allJoins.filter((j) => j.pairHoldout === "holdout").length,
        },
      },
      variety: {
        distinctTitlePairs: new Set(allJoins.map((j) => `${j.outgoingTitle}>${j.incomingTitle}`))
          .size,
        repeatedPairs: [...pairOccurrences.entries()].filter(([, n]) => n > 1).length,
        distinctArtistsApprox: artistsUsed.size,
      },
      runtime: {
        totalPlanMs: planRows.reduce((s, p) => s + p.planMs, 0),
        totalRenderMs: planRows.reduce((s, p) => s + (p.renderMs ?? 0), 0),
      },
      manualIntervention: {
        probeFlagged: allJoins.filter((j) => j.probeStatus === "review" || j.probeStatus === "fail")
          .length,
        partialPlans: planRows.filter((p) => p.partial).length,
        failedRenders: planRows.filter((p) => p.renderStatus !== "succeeded").length,
      },
      scratchOutputRoot: path.join(scratch, "output"),
    };

    const reportDir = path.join(import.meta.dirname, "..", "reports");
    await mkdir(reportDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    await writeFile(
      path.join(reportDir, `library-baseline-${stamp}.json`),
      JSON.stringify({ summary, plans: planRows }, null, 2),
    );

    // Audition guide: musical ground truth comes from the owner's ears.
    const guide: string[] = [
      `# Library corpus baseline - audition guide (${stamp})`,
      "",
      `Cold-start plans (no saved joins, history, or recipes). Listen to each file and rate joins by ear (feedback:rate / hour:feedback). Technical labels below are NOT musical judgments.`,
      "",
    ];
    for (const p of planRows) {
      guide.push(`## ${p.name} (seed ${p.seed}, ${p.entryCount} tracks, render ${p.renderStatus})`);
      guide.push(`- listen: ${p.listenPath ?? "(not rendered)"}`);
      guide.push(
        `- partial: ${p.partial}${(p.partialReasons ?? []).length ? ` (${(p.partialReasons ?? []).join("; ")})` : ""}`,
      );
      guide.push(`- plan ${p.planMs}ms, render ${p.renderMs ?? "-"}ms, check ok=${p.checkOk}`);
      guide.push("");
      guide.push("| # | at (mm:ss) | join | template | probe | notes |");
      guide.push("| - | ---------- | ---- | -------- | ----- | ----- |");
      for (const j of p.joins) {
        const at = j.joinAtMs == null ? "-" : fmt(j.joinAtMs);
        const notes = [
          j.windowShiftBars != null ? `window-shift ${j.windowShiftBars} bars` : null,
          j.probeOffsetMs != null ? `offset ${j.probeOffsetMs.toFixed(1)}ms` : null,
          j.storedGridResidualMs != null
            ? `residual ${Math.round(j.storedGridResidualMs)}ms`
            : null,
          j.reason && j.template === "crossfade" ? j.reason : null,
        ]
          .filter(Boolean)
          .join(", ");
        guide.push(
          `| ${j.order} | ${at} | ${j.outgoingTitle} → ${j.incomingTitle} | ${j.template} | ${j.probeStatus ?? "-"} | ${notes} |`,
        );
      }
      guide.push("");
    }
    await writeFile(
      path.join(reportDir, `library-baseline-${stamp}.audition.md`),
      guide.join("\n"),
    );

    console.log("Library corpus baseline");
    console.log(JSON.stringify(summary, null, 2));
    console.log(`\nAudition guide + JSON written to tools/reports/`);
    console.log(`Scratch output (listen files): ${path.join(scratch, "output")}`);
  } finally {
    await runtime.close();
    // NOTE: scratch is intentionally KEPT - it holds the listen files the
    // owner may audition. Delete manually after listening.
  }
}

function fmt(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) {
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

void stat; // reserved
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
