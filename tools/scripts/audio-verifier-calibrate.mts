/**
 * Audio-verifier calibration (batch 7, repository review 2026-10-08).
 *
 * Measures the independent deck-alignment verifier against historical
 * renders: for recent succeeded full renders it re-runs render:check with
 * full deck probes and compares each aligned join's verdict with the
 * recorded hour-feedback acceptance. The confusion matrix (accepted ×
 * verdict) is the false-positive evidence the review requires before any
 * audio signal may gate a render. Read-only (passive runtime); decodes
 * sources and masters but writes only temp scratch it cleans itself.
 *
 * Usage: pnpm tsx tools/scripts/audio-verifier-calibrate.mts [maxRenders]
 */
import path from "node:path";

import { loadConfig } from "../../packages/domain/src/index.ts";
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";

const maxRenders = Number(process.argv[2] ?? 8);

const config = loadConfig();
const runtime = createCatalogRuntime(config, undefined, { passive: true });
try {
  // Feedback labels live on their own rows; index them by render id first
  // so older audited renders are matched even outside the recent window.
  const feedbackByRender = new Map<string, boolean>();
  for (const row of runtime.service.listHourFeedback()) {
    if (row.renderJobId) {
      feedbackByRender.set(row.renderJobId, row.accepted === true);
    }
  }
  const labeled = [
    ...runtime.renderJobs.list({ limit: 50, status: "succeeded" }).jobs,
    ...[...feedbackByRender.keys()]
      .map((id) => runtime.renderJobs.findById(id))
      .filter((job): job is NonNullable<typeof job> => job != null && job.status === "succeeded"),
  ].filter(
    (job) =>
      job.kind === "full" && job.outputRootRelativePath != null && feedbackByRender.has(job.id),
  );
  const seenLabeled = new Set<string>();
  const dedupedLabeled = labeled.filter((job) => {
    if (seenLabeled.has(job.id)) return false;
    seenLabeled.add(job.id);
    return true;
  });
  const unlabeled = runtime.renderJobs
    .list({ limit: 50, status: "succeeded" })
    .jobs.filter(
      (job) =>
        job.kind === "full" && job.outputRootRelativePath != null && !feedbackByRender.has(job.id),
    );
  const jobs = [...dedupedLabeled, ...unlabeled].slice(
    0,
    Math.max(maxRenders, dedupedLabeled.length),
  );
  const tallies = {
    acceptedPass: 0,
    acceptedReview: 0,
    acceptedFail: 0,
    acceptedUnmeasured: 0,
    otherPass: 0,
    otherReview: 0,
    otherFail: 0,
    otherUnmeasured: 0,
  };
  let rendersChecked = 0;
  outer: for (const job of jobs) {
    if (rendersChecked >= maxRenders) {
      break;
    }
    const abs = path.resolve(config.outputRoot ?? ".", job.outputRootRelativePath!);
    // A missing master only disables master-side scans (silence/levels/
    // quality); the deck probes read the SOURCE files, so labeled renders
    // whose outputs were cleaned still calibrate the deck verifier.
    void abs;
    let checked;
    try {
      checked = await runtime.service.checkRender(job.id, undefined, {
        audioVerification: "full",
      });
    } catch (error) {
      console.log(`- render ${job.id}: check failed (${String(error)})`);
      continue;
    }
    rendersChecked += 1;
    const accepted = feedbackByRender.get(job.id) === true;
    const rejected = feedbackByRender.has(job.id) && !accepted;
    const label = accepted ? "accepted" : rejected ? "rejected" : "unlabeled";
    for (const join of checked.joins) {
      if (join.template !== "phrase_mix" && join.template !== "bass_swap") {
        continue;
      }
      const key = `${label}${join.audioStatus[0]!.toUpperCase()}${join.audioStatus.slice(1)}`;
      if (key in tallies) {
        tallies[key as keyof typeof tallies] += 1;
      }
      if (join.audioStatus === "fail" || join.audioStatus === "review") {
        console.log(
          `  render ${job.id.slice(0, 8)} (${label}) join ${join.order}: ${join.audioStatus} — ${join.audioFindings.join("; ")}`,
        );
      }
    }
    if (rendersChecked >= maxRenders) {
      break outer;
    }
  }
  console.log(`\nDeck-verifier confusion matrix over ${rendersChecked} renders:`);
  console.log(JSON.stringify(tallies, null, 2));
  const acceptedTotal =
    tallies.acceptedPass +
    tallies.acceptedReview +
    tallies.acceptedFail +
    tallies.acceptedUnmeasured;
  if (acceptedTotal > 0) {
    const fp = tallies.acceptedFail;
    const softFp = tallies.acceptedReview;
    console.log(
      `\nAccepted-listen joins: ${acceptedTotal} — measured fail on ${fp} (${((fp / acceptedTotal) * 100).toFixed(1)}%), review on ${softFp} (${((softFp / acceptedTotal) * 100).toFixed(1)}%), pass on ${tallies.acceptedPass}, unmeasured on ${tallies.acceptedUnmeasured}.`,
    );
    console.log(
      "Gate promotion rule from the review: only promote once the accepted-fail rate is understood join by join (each is either a real defect the audition missed or a verifier false positive to fix).",
    );
  } else {
    console.log(
      "\nNo hour-feedback-labeled renders found in range; run after the next audited mix.",
    );
  }
} finally {
  await runtime.close();
}
