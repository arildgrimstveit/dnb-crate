import {
  DNB_BPM_MAX,
  DNB_BPM_MIN,
  MIN_ANALYSIS_CONFIDENCE,
  keyAgreement,
  normalizeDnbBpm,
  type Track,
} from "@dnb-crate/domain";
import type { AnalysisRepository } from "../analysis-repository.ts";
import type { TrackRepository } from "../repository.ts";

export type AnalysisReport = {
  trackCount: number;
  engineCounts: Record<string, number>;
  inRange: { count: number; withinHalf: number; accepted: number; acceptedExact: number };
  outOfRange: { count: number };
  publishedOrManualCompared: number;
  dspWithinHalfBpm: number;
  engines: Array<{
    trackId: string;
    title: string;
    analyzerName: string;
    bpm: number | null;
    bpmConfidence: number | null;
    gridRejected: boolean;
    gridSource: "analyzed" | "reference" | "anchor" | "sidecar" | null;
    keyAgreement: "exact" | "relative" | "number_pm1" | "clash" | null;
    sectionCount: number;
  }>;
  gridSourceCounts: { analyzed: number; reference: number; anchor: number; sidecar: number };
  keyAgreementCounts: {
    exact: number;
    relative: number;
    number_pm1: number;
    clash: number;
    unknown: number;
  };
  needsReview: Array<{
    trackId: string;
    title: string;
    reason: "out-of-range" | "disagreement";
    canonicalBpm: number | null;
    canonicalSource: string | null;
    publishedFolded: number | null;
    dspBpm: number | null;
    engines: Record<string, number | null>;
  }>;
  disagreements: Array<{
    trackId: string;
    title: string;
    canonicalBpm: number | null;
    canonicalSource: string | null;
    engines: Record<string, number | null>;
  }>;
};

/** Whole-library analysis report: engine coverage, published/manual BPM
 * agreement, key agreement, and rows needing review. */
export function buildAnalysisReport(
  repository: TrackRepository,
  analyses: AnalysisRepository,
): AnalysisReport {
  const engineCounts: Record<string, number> = {};
  const disagreements: AnalysisReport["disagreements"] = [];
  const needsReview: AnalysisReport["needsReview"] = [];
  const engineRows: AnalysisReport["engines"] = [];
  const gridSourceCounts = { analyzed: 0, reference: 0, anchor: 0, sidecar: 0 };
  const keyAgreementCounts = {
    exact: 0,
    relative: 0,
    number_pm1: 0,
    clash: 0,
    unknown: 0,
  };
  let inRangeCount = 0;
  let withinHalf = 0;
  let accepted = 0;
  let acceptedExact = 0;
  let outOfRangeCount = 0;
  const allTracks: Track[] = repository.listAll();
  for (const track of allTracks) {
    const rows = analyses.listByTrackId(track.id);
    if (rows.length === 0) {
      continue;
    }
    for (const row of rows) {
      engineCounts[row.analyzerName] = (engineCounts[row.analyzerName] ?? 0) + 1;
    }
    const view = analyses.toView(track, analyses.findByTrackId(track.id));
    if (!view) {
      continue;
    }
    const engines: Record<string, number | null> = {};
    for (const row of rows) {
      engines[row.analyzerName] = row.bpm;
      const refKey =
        view.canonicalKeySource === "manual" || view.canonicalKeySource === "published"
          ? view.canonicalKey
          : null;
      engineRows.push({
        trackId: track.id,
        title: track.title,
        analyzerName: row.analyzerName,
        bpm: row.bpm,
        bpmConfidence: row.bpmConfidence,
        gridRejected: row.gridRejected,
        gridSource: row.gridSource ?? "analyzed",
        keyAgreement: keyAgreement(row.musicalKey, refKey),
        sectionCount: row.sections.length,
      });
      const agreement = keyAgreement(row.musicalKey, refKey);
      if (agreement) {
        keyAgreementCounts[agreement] += 1;
      } else {
        keyAgreementCounts.unknown += 1;
      }
      const source = row.gridSource ?? "analyzed";
      if (
        source === "reference" ||
        source === "anchor" ||
        source === "analyzed" ||
        source === "sidecar"
      ) {
        gridSourceCounts[source] += 1;
      }
    }
    const ref =
      view.canonicalBpmSource === "manual" || view.canonicalBpmSource === "published"
        ? view.canonicalBpm
        : null;
    if (ref == null) {
      continue;
    }
    const dsp = engines["dnb-crate-dsp"];
    const inRange = ref >= DNB_BPM_MIN - 1e-6 && ref <= DNB_BPM_MAX + 1e-6;
    const folded = normalizeDnbBpm(ref)?.bpm ?? null;
    if (!inRange) {
      outOfRangeCount += 1;
      needsReview.push({
        trackId: track.id,
        title: track.title,
        reason: "out-of-range",
        canonicalBpm: view.canonicalBpm,
        canonicalSource: view.canonicalBpmSource,
        publishedFolded: folded,
        dspBpm: dsp ?? null,
        engines,
      });
      continue;
    }
    inRangeCount += 1;
    if (dsp != null && Math.abs(dsp - ref) <= 0.5) {
      withinHalf += 1;
    }
    const dspRow = rows.find((row) => row.analyzerName === "dnb-crate-dsp");
    const dspAccepted =
      dspRow != null &&
      !dspRow.gridRejected &&
      (dspRow.bpmConfidence ?? 0) >= MIN_ANALYSIS_CONFIDENCE &&
      dspRow.bpm != null;
    if (dspAccepted) {
      accepted += 1;
      if (Math.abs(dspRow.bpm! - ref) <= 0.5) {
        acceptedExact += 1;
      }
    }
    const values = Object.values(engines).filter((bpm): bpm is number => bpm != null);
    const spread = values.length >= 2 && Math.max(...values) - Math.min(...values) > 1;
    const off = dsp != null && Math.abs(dsp - ref) > 0.5;
    if (spread || off) {
      const row = {
        trackId: track.id,
        title: track.title,
        canonicalBpm: view.canonicalBpm,
        canonicalSource: view.canonicalBpmSource,
        engines,
      };
      disagreements.push(row);
      needsReview.push({
        ...row,
        reason: "disagreement",
        publishedFolded: folded,
        dspBpm: dsp ?? null,
      });
    }
  }
  return {
    trackCount: allTracks.length,
    engineCounts,
    inRange: { count: inRangeCount, withinHalf, accepted, acceptedExact },
    outOfRange: { count: outOfRangeCount },
    publishedOrManualCompared: inRangeCount + outOfRangeCount,
    dspWithinHalfBpm: withinHalf,
    gridSourceCounts,
    keyAgreementCounts,
    engines: engineRows.slice(0, 200),
    needsReview: needsReview.slice(0, 50),
    disagreements: disagreements.slice(0, 50),
  };
}
