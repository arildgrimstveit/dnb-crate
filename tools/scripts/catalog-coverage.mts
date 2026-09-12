/** Compact catalog coverage for planning. Read-only. */
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";
import { loadConfig } from "../../packages/domain/src/index.ts";
import { percentileToValue } from "../../packages/domain/src/mood-presets.ts";

const runtime = createCatalogRuntime(loadConfig());
const stats = runtime.service.getLibraryStats();
const ready = runtime.service.getPlanningReadiness();
const report = runtime.service.getAnalysisReport();
const recipes = runtime.service.listApprovedRecipes();

const missing = { bpm: 0, key: 0, energy: 0, file: 0, bpmAndKey: 0, keyOnly: 0, bpmOnly: 0 };
const missingKeyTitles: string[] = [];
for (const row of ready.tracks) {
  if (row.missing.includes("bpm")) missing.bpm += 1;
  if (row.missing.includes("key")) {
    missing.key += 1;
    if (missingKeyTitles.length < 12) missingKeyTitles.push(row.title);
  }
  if (row.missing.includes("energy")) missing.energy += 1;
  if (row.missing.includes("file")) missing.file += 1;
  if (row.missing.includes("bpm") && row.missing.includes("key")) missing.bpmAndKey += 1;
  if (row.missing.includes("key") && !row.missing.includes("bpm")) missing.keyOnly += 1;
  if (row.missing.includes("bpm") && !row.missing.includes("key")) missing.bpmOnly += 1;
}

const tracks = runtime.repository.listAll();
const gridRejected = tracks.filter((track) => {
  const analysis = runtime.analyses.findByTrackId(track.id);
  return analysis?.gridRejected === true;
}).length;
const acceptedGrid = tracks.filter((track) => {
  const analysis = runtime.analyses.findByTrackId(track.id);
  return analysis != null && analysis.gridRejected === false;
}).length;
const alignedReady = ready.tracks.filter((row) => row.ready).length;

const energyP70 = stats.descriptorPercentiles.energy;
const melodicP60 = stats.descriptorPercentiles.melodicness;
let peakEnergyHits = 0;
let liquidMelodicHits = 0;
let peakReady = 0;
let liquidReady = 0;
for (const track of tracks) {
  const desc = runtime.analyses.findByTrackId(track.id)?.descriptors;
  const plan = ready.tracks.find((row) => row.trackId === track.id);
  if (energyP70 && desc?.energy != null && desc.energy >= energyP70.p10) {
    /* placeholder */
  }
}

function pctAt(values: number[], pct: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((pct / 100) * (sorted.length - 1))));
  return sorted[i]!;
}

const energies = tracks
  .map((track) => runtime.analyses.findByTrackId(track.id)?.descriptors?.energy)
  .filter((value): value is number => typeof value === "number");
const melodics = tracks
  .map((track) => runtime.analyses.findByTrackId(track.id)?.descriptors?.melodicness)
  .filter((value): value is number => typeof value === "number");
const energyMin = pctAt(energies, 70);
const melodicMin = pctAt(melodics, 60);
const liquidEnergyMin = pctAt(energies, 15);
const liquidEnergyMax = pctAt(energies, 80);

for (const track of tracks) {
  const desc = runtime.analyses.findByTrackId(track.id)?.descriptors;
  const row = ready.tracks.find((item) => item.trackId === track.id);
  const isReady = row?.ready === true;
  if (energyMin != null && desc?.energy != null && desc.energy >= energyMin) {
    peakEnergyHits += 1;
    if (isReady) peakReady += 1;
  }
  if (
    melodicMin != null &&
    liquidEnergyMin != null &&
    liquidEnergyMax != null &&
    desc?.melodicness != null &&
    desc.energy != null &&
    desc.melodicness >= melodicMin &&
    desc.energy >= liquidEnergyMin &&
    desc.energy <= liquidEnergyMax
  ) {
    liquidMelodicHits += 1;
    if (isReady) liquidReady += 1;
  }
}

console.log(
  JSON.stringify(
    {
      trackCount: stats.trackCount,
      missingFiles: stats.missingFileCount,
      analysis: stats.analysisCoverage,
      missingCounts: {
        bpm: stats.missingBpmCount,
        key: stats.missingKeyCount,
        energy: stats.missingEnergyCount,
        rating: stats.missingRatingCount,
      },
      bpmBySource: stats.metadataCoverage.bpmBySource,
      keyBySource: stats.metadataCoverage.keyBySource,
      energySet: stats.metadataCoverage.energy,
      moodsSet: stats.metadataCoverage.moods,
      genresSet: stats.metadataCoverage.genres,
      planning: {
        ready: ready.readyCount,
        total: ready.totalCount,
        missing,
        missingKeySample: missingKeyTitles,
      },
      grids: { accepted: acceptedGrid, rejected: gridRejected },
      analysisReport: {
        publishedOrManualCompared: report.publishedOrManualCompared,
        inRange: report.inRange,
        outOfRange: report.outOfRange,
        gridSourceCounts: report.gridSourceCounts,
        keyAgreementCounts: report.keyAgreementCounts,
        needsReview: report.needsReview.length,
        disagreements: report.disagreements.length,
      },
      briefPools: {
        peakEnergyMin: energyMin,
        peakDescriptorHits: peakEnergyHits,
        peakPlanningReady: peakReady,
        liquidMelodicMin: melodicMin,
        liquidEnergyBand: [liquidEnergyMin, liquidEnergyMax],
        liquidDescriptorHits: liquidMelodicHits,
        liquidPlanningReady: liquidReady,
      },
      approvedRecipes: recipes.length,
      briefQuality: (() => {
        const peakE = percentileToValue(70, stats.descriptorPercentiles.energy);
        const peakD = percentileToValue(60, stats.descriptorPercentiles.danceability);
        const liqM = percentileToValue(60, stats.descriptorPercentiles.melodicness);
        const liqEmin = percentileToValue(15, stats.descriptorPercentiles.energy);
        const liqEmax = percentileToValue(80, stats.descriptorPercentiles.energy);
        const bump = (s: { n: number; keyed: number; bpm: number; gridOk: number; keyedGrid: number }, track: (typeof tracks)[number]) => {
          const analysis = runtime.analyses.findByTrackId(track.id);
          s.n += 1;
          if (track.camelotKey) s.keyed += 1;
          if (track.bpm != null) s.bpm += 1;
          if (analysis && !analysis.gridRejected) s.gridOk += 1;
          if (track.camelotKey && analysis && !analysis.gridRejected) s.keyedGrid += 1;
        };
        const peak = { n: 0, keyed: 0, bpm: 0, gridOk: 0, keyedGrid: 0 };
        const liquid = { n: 0, keyed: 0, bpm: 0, gridOk: 0, keyedGrid: 0 };
        for (const track of tracks) {
          const d = runtime.analyses.findByTrackId(track.id)?.descriptors;
          if (d?.energy != null && peakE != null && d.energy >= peakE && d.danceability != null && peakD != null && d.danceability >= peakD) {
            bump(peak, track);
          }
          if (
            d?.melodicness != null &&
            liqM != null &&
            d.melodicness >= liqM &&
            d.energy != null &&
            liqEmin != null &&
            liqEmax != null &&
            d.energy >= liqEmin &&
            d.energy <= liqEmax
          ) {
            bump(liquid, track);
          }
        }
        return { peak, liquid, thresholds: { peakE, peakD, liqM, liqEmin, liqEmax } };
      })(),
    },
    null,
    2,
  ),
);
runtime.close();
