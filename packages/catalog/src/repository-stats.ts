import type { LibraryStats } from "@dnb-crate/domain";
import { DSP_ANALYZER_NAME, resolveBpmHint } from "@dnb-crate/domain";

import type { SqliteDatabase } from "./db.ts";

export function tableExists(db: SqliteDatabase, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { ok: number } | undefined;
  return row !== undefined;
}

function hasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((item) => item.name === column);
}

function sourceCounts(db: SqliteDatabase, column: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT COALESCE(${column}, 'NULL') AS source, COUNT(*) AS n FROM tracks GROUP BY ${column}`,
    )
    .all() as { source: string; n: number }[];
  const out: Record<string, number> = {};
  for (const item of rows) {
    out[item.source] = item.n;
  }
  return out;
}

function percentileTriple(values: number[]): LibraryStats["descriptorPercentiles"]["energy"] {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[index]!;
  };
  return { p10: at(0.1), p50: at(0.5), p90: at(0.9) };
}

function descriptorPercentiles(db: SqliteDatabase): LibraryStats["descriptorPercentiles"] {
  const empty = {
    energy: null,
    danceability: null,
    valence: null,
    acousticness: null,
    melodicness: null,
    subBass: null,
    brightness: null,
  };
  if (!tableExists(db, "track_analyses") || !hasColumn(db, "track_analyses", "descriptors_json")) {
    return empty;
  }
  const rows = db
    .prepare("SELECT descriptors_json FROM track_analyses WHERE descriptors_json IS NOT NULL")
    .all() as { descriptors_json: string }[];
  const buckets: Record<string, number[]> = {
    energy: [],
    danceability: [],
    valence: [],
    acousticness: [],
    melodicness: [],
    subBass: [],
    brightness: [],
  };
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.descriptors_json) as Record<string, unknown>;
      const push = (key: string, value: unknown): void => {
        if (typeof value === "number" && Number.isFinite(value)) {
          buckets[key]?.push(value);
        }
      };
      push("energy", parsed.energy);
      push("danceability", parsed.danceability);
      push("valence", parsed.valence);
      push("acousticness", parsed.acousticness);
      push("melodicness", parsed.melodicness);
      push("subBass", parsed.subBassRatio);
      push("brightness", parsed.brightness);
    } catch {
      // skip malformed rows
    }
  }
  return {
    energy: percentileTriple(buckets.energy ?? []),
    danceability: percentileTriple(buckets.danceability ?? []),
    valence: percentileTriple(buckets.valence ?? []),
    acousticness: percentileTriple(buckets.acousticness ?? []),
    melodicness: percentileTriple(buckets.melodicness ?? []),
    subBass: percentileTriple(buckets.subBass ?? []),
    brightness: percentileTriple(buckets.brightness ?? []),
  };
}

function analysisCoverage(db: SqliteDatabase): LibraryStats["analysisCoverage"] {
  const statusRows = db
    .prepare("SELECT analysis_status AS status, COUNT(*) AS n FROM tracks GROUP BY analysis_status")
    .all() as { status: string; n: number }[];
  let analyzed = 0;
  let notAnalyzed = 0;
  for (const item of statusRows) {
    if (item.status === "complete") {
      analyzed = item.n;
    } else if (item.status === "not_analyzed") {
      notAnalyzed = item.n;
    }
  }

  const byEngineVersion: Record<string, number> = {};
  let accepted = 0;
  let rejected = 0;
  let reference = 0;
  let bpmHintOnly = 0;
  if (tableExists(db, "track_analyses")) {
    const engineRows = db
      .prepare(
        `SELECT analyzer_name || '@' || analyzer_version AS key, COUNT(*) AS n
         FROM track_analyses GROUP BY analyzer_name, analyzer_version`,
      )
      .all() as { key: string; n: number }[];
    for (const item of engineRows) {
      byEngineVersion[item.key] = item.n;
    }
    const dsp = db
      .prepare(
        `SELECT
           SUM(CASE WHEN grid_rejected = 0 AND IFNULL(grid_source, 'analyzed') <> 'reference' THEN 1 ELSE 0 END) AS accepted,
           SUM(CASE WHEN grid_rejected = 1 THEN 1 ELSE 0 END) AS rejected,
           SUM(CASE WHEN grid_source = 'reference' AND grid_rejected = 0 THEN 1 ELSE 0 END) AS reference
         FROM track_analyses WHERE analyzer_name = ?`,
      )
      .get(DSP_ANALYZER_NAME) as {
      accepted: number | null;
      rejected: number | null;
      reference: number | null;
    };
    accepted = dsp.accepted ?? 0;
    rejected = dsp.rejected ?? 0;
    reference = dsp.reference ?? 0;
    const hintRows = db
      .prepare(
        `SELECT bpm_raw, bpm_confidence, grid_rejected
         FROM track_analyses WHERE analyzer_name = ?`,
      )
      .all(DSP_ANALYZER_NAME) as Array<{
      bpm_raw: number | null;
      bpm_confidence: number | null;
      grid_rejected: number;
    }>;
    bpmHintOnly = hintRows.filter(
      (row) =>
        resolveBpmHint({
          gridRejected: row.grid_rejected === 1,
          bpmRaw: row.bpm_raw,
          bpmConfidence: row.bpm_confidence,
        }).bpm != null,
    ).length;
  }

  return { analyzed, notAnalyzed, byEngineVersion, accepted, rejected, reference, bpmHintOnly };
}

function metadataCoverage(db: SqliteDatabase): LibraryStats["metadataCoverage"] {
  const energy = (
    db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE energy IS NOT NULL").get() as {
      n: number;
    }
  ).n;
  const moods = tableExists(db, "track_moods")
    ? (
        db.prepare("SELECT COUNT(DISTINCT track_id) AS n FROM track_moods").get() as {
          n: number;
        }
      ).n
    : 0;
  const genres = tableExists(db, "track_genres")
    ? (
        db.prepare("SELECT COUNT(DISTINCT track_id) AS n FROM track_genres").get() as {
          n: number;
        }
      ).n
    : 0;
  const countNonEmpty = (column: string): number => {
    if (!hasColumn(db, "tracks", column)) {
      return 0;
    }
    return (
      db
        .prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${column} IS NOT NULL AND ${column} <> ''`)
        .get() as { n: number }
    ).n;
  };
  let duplicateGroups = 0;
  if (hasColumn(db, "tracks", "recording_key")) {
    duplicateGroups = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT recording_key FROM tracks
             WHERE recording_key IS NOT NULL
             GROUP BY recording_key
             HAVING COUNT(*) > 1
           )`,
        )
        .get() as { n: number }
    ).n;
  }
  return {
    bpmBySource: sourceCounts(db, "bpm_source"),
    keyBySource: sourceCounts(db, "key_source"),
    energy,
    moods,
    genres,
    isrc: countNonEmpty("isrc"),
    label: countNonEmpty("label"),
    releaseDate: countNonEmpty("release_date"),
    recordingMbid: countNonEmpty("recording_mbid"),
    duplicateGroups,
  };
}

/** Whole-library stats: counts, extension spread, analysis/metadata coverage,
 * and descriptor percentiles. */
export function buildLibraryStats(db: SqliteDatabase): LibraryStats {
  const row = db
    .prepare(
      `SELECT
          COUNT(*) AS track_count,
          SUM(file_missing) AS missing_file_count,
          IFNULL(SUM(duration_ms), 0) AS total_duration_ms,
          SUM(CASE WHEN artist IS NULL THEN 1 ELSE 0 END) AS missing_artist_count,
          SUM(CASE WHEN bpm IS NULL THEN 1 ELSE 0 END) AS missing_bpm_count,
          SUM(CASE WHEN musical_key IS NULL THEN 1 ELSE 0 END) AS missing_key_count,
          SUM(CASE WHEN energy IS NULL THEN 1 ELSE 0 END) AS missing_energy_count,
          SUM(CASE WHEN rating IS NULL THEN 1 ELSE 0 END) AS missing_rating_count
         FROM tracks`,
    )
    .get() as {
    track_count: number;
    missing_file_count: number | null;
    total_duration_ms: number;
    missing_artist_count: number;
    missing_bpm_count: number;
    missing_key_count: number;
    missing_energy_count: number;
    missing_rating_count: number;
  };

  const paths = db.prepare("SELECT title, file_path FROM tracks").all() as {
    title: string;
    file_path: string;
  }[];
  const extensionCounts: Record<string, number> = {};
  let missingTitleFromTagsCount = 0;
  for (const item of paths) {
    const ext = (/\.[^.]+$/.exec(item.file_path)?.[0] ?? "").toLowerCase();
    if (ext.length > 0) {
      extensionCounts[ext] = (extensionCounts[ext] ?? 0) + 1;
    }
    const stem = item.file_path
      .replaceAll("\\", "/")
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "");
    if (stem !== undefined && stem === item.title) {
      missingTitleFromTagsCount += 1;
    }
  }

  return {
    trackCount: row.track_count,
    missingFileCount: row.missing_file_count ?? 0,
    totalDurationMs: row.total_duration_ms,
    extensionCounts,
    missingTitleFromTagsCount,
    missingArtistCount: row.missing_artist_count,
    missingBpmCount: row.missing_bpm_count,
    missingKeyCount: row.missing_key_count,
    missingEnergyCount: row.missing_energy_count,
    missingRatingCount: row.missing_rating_count,
    analysisCoverage: analysisCoverage(db),
    metadataCoverage: metadataCoverage(db),
    descriptorPercentiles: descriptorPercentiles(db),
  };
}
