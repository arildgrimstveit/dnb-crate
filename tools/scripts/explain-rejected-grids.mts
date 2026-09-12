/** Bucket unused rejected grids by reason. Read-only. */
import { createCatalogRuntime } from "../../packages/catalog/src/index.ts";
import { loadConfig, resolveBpmHint } from "../../packages/domain/src/index.ts";

const HEARD_PLAN_IDS = [
  "69918656-5223-4412-ba29-1883a489999a",
  "1e7c6ad1-7d7f-4b51-8278-86e2ea674295",
  "0cfe6e0e-af83-499b-a5ba-e8e360e07b09",
  "5c5121fb-da3b-4c2d-89b5-27675117dd95",
  "6da27a44-20cb-4eb0-9682-2f159827cd61",
  "b398f343-7cbc-47dd-afd6-2426ab0d1048",
  "6ae04b7f-b03e-4996-af60-534c462451d8",
  "35b4d66e-6204-44f3-a662-41b6b559a0c4",
  "de668db6-77a2-4d9d-a0dc-822f9e7f9711",
  "266d3a51-900e-434c-a9d5-c816c9a4b962",
  "341aa849-8dea-4ede-a2b6-b71b7a7529b0",
  "7df37661-8d1b-4d38-8ee3-dba0981c494e",
  "08cc11ef-bf26-40df-a884-c5201e78b306",
  "fead3fc9-361f-424f-9e01-fe9feabe52ba",
  "88e7551b-8f83-4f2e-9699-65e5940cba03",
  "d133711c-0735-4e3a-86c4-84894a32fac4",
  "8bbeb770-20c4-4c44-9f92-ba25ebb52381",
  "9a21bb42-e8dc-44ee-9dc6-9ba73589c6d9",
  "9a52b7fa-4f1a-4859-8dd6-99676defdab6",
  "1e0fdbad-5c8f-43bf-bb17-55a34351b91a",
  "956ad7c5-7571-48e6-9312-d420739193db",
];

function reasonBucket(reason: string | null): string {
  if (!reason) return "no_reason";
  if (reason.includes("No plausible DnB tempo")) return "no_dnb_tempo";
  if (reason.includes("Beat-grid confidence")) return "low_confidence";
  if (reason.includes("Reference tempo")) return "reference_mismatch";
  if (reason.includes("disagrees with published")) return "disagrees_published";
  if (reason.toLowerCase().includes("3:2") || reason.toLowerCase().includes("3/2"))
    return "ratio_confusion";
  return reason.length > 80 ? `${reason.slice(0, 80)}…` : reason;
}

const config = loadConfig();
const runtime = createCatalogRuntime(config, undefined, { passive: true });
try {
  const tracks = runtime.repository.listAll();
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const usedKeys = new Set<string>();
  for (const id of HEARD_PLAN_IDS) {
    const stored = runtime.setPlans.findById(id);
    if (!stored) continue;
    for (const entry of stored.plan.entries) {
      usedKeys.add(byId.get(entry.trackId)?.recordingKey ?? entry.trackId);
    }
  }
  const rows = [];
  for (const track of tracks) {
    if (track.fileMissing) continue;
    if (usedKeys.has(track.recordingKey ?? track.id)) continue;
    const analysis = runtime.analyses.findByTrackId(track.id);
    if (!analysis || !analysis.gridRejected) continue;
    const hint = resolveBpmHint(analysis);
    rows.push({
      title: `${track.artist ?? "?"} – ${track.title}`,
      reason: analysis.gridRejectionReason,
      bucket: reasonBucket(analysis.gridRejectionReason),
      bpmRaw: analysis.bpmRaw,
      bpm: analysis.bpm,
      confidence: analysis.bpmConfidence,
      publishedBpm: track.bpm,
      bpmSource: track.bpmSource,
      hint: hint.bpm,
      hintConfidence: hint.confidence,
      gridSource: analysis.gridSource,
      referenceBpm: analysis.referenceBpm ?? null,
      analyzer: `${analysis.analyzerName} ${analysis.analyzerVersion}`,
    });
  }
  const buckets: Record<string, number> = {};
  const nearMiss = rows.filter(
    (row) =>
      row.bucket === "low_confidence" &&
      row.confidence != null &&
      row.confidence >= 0.45 &&
      row.bpmRaw != null,
  );
  const hasPublished = rows.filter(
    (row) => row.publishedBpm != null && row.publishedBpm >= 160 && row.publishedBpm <= 190,
  );
  const noPublished = rows.filter(
    (row) => row.publishedBpm == null || row.publishedBpm < 160 || row.publishedBpm > 190,
  );
  for (const row of rows) buckets[row.bucket] = (buckets[row.bucket] ?? 0) + 1;
  const byBucket: Record<string, typeof rows> = {};
  for (const row of rows) (byBucket[row.bucket] ??= []).push(row);
  for (const list of Object.values(byBucket)) {
    list.sort((a, b) => a.title.localeCompare(b.title));
  }
  console.log(
    JSON.stringify(
      {
        unusedRejectedPlayable: rows.length,
        buckets,
        analyzers: [...new Set(rows.map((row) => row.analyzer))],
        nearMissLowConfidence: nearMiss.length,
        unusedRejectedWithPublishedDnbBpm: hasPublished.length,
        unusedRejectedWithoutPublishedDnbBpm: noPublished.length,
        recoverableIfWeTrustFreeGrid: rows.filter(
          (row) =>
            row.bucket === "reference_mismatch" &&
            row.hint != null &&
            row.confidence != null &&
            row.confidence >= 0.6,
        ).length,
        referenceMismatchWithDnbHint: rows.filter(
          (row) => row.bucket === "reference_mismatch" && row.hint != null,
        ).length,
        lowConfidenceWithHint: rows.filter(
          (row) => row.bucket === "low_confidence" && row.hint != null,
        ).length,
        strongFreeGridKilledByPublished: rows
          .filter(
            (row) =>
              row.bucket === "reference_mismatch" &&
              row.hint != null &&
              row.confidence != null &&
              row.confidence >= 0.6,
          )
          .map((row) => ({
            title: row.title,
            free: row.hint,
            confidence: row.confidence,
            publishedBpm: row.publishedBpm,
          })),
        examples: Object.fromEntries(
          Object.entries(byBucket).map(([bucket, list]) => [
            bucket,
            list.slice(0, 8).map((row) => ({
              title: row.title,
              reason: row.reason,
              bpmRaw: row.bpmRaw,
              confidence: row.confidence,
              publishedBpm: row.publishedBpm,
              hint: row.hint,
            })),
          ]),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await runtime.close();
}
