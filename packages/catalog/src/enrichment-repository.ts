import type { EnrichmentReport } from "@dnb-crate/domain";

import type { SqliteDatabase } from "./db.ts";

export type StoredEnrichment = {
  trackId: string;
  releaseMbid: string | null;
  releaseGroupMbid: string | null;
  artistMbidsJson: string | null;
  catalogNumber: string | null;
  originalDate: string | null;
  deezerTrackId: string | null;
  deezerBpm: number | null;
  deezerGain: number | null;
  acoustidId: string | null;
  matchMethod: "file-tags" | "isrc" | "acoustid" | "search" | null;
  matchScore: number | null;
  matchedAt: string | null;
  rawJson: string | null;
};

export class EnrichmentRepository {
  constructor(private readonly db: SqliteDatabase) {}

  upsert(row: StoredEnrichment): void {
    this.db
      .prepare(
        `INSERT INTO track_enrichment (
          track_id, release_mbid, release_group_mbid, artist_mbids_json, catalog_number,
          original_date, deezer_track_id, deezer_bpm, deezer_gain, acoustid_id,
          match_method, match_score, matched_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(track_id) DO UPDATE SET
          release_mbid = excluded.release_mbid,
          release_group_mbid = excluded.release_group_mbid,
          artist_mbids_json = excluded.artist_mbids_json,
          catalog_number = excluded.catalog_number,
          original_date = excluded.original_date,
          deezer_track_id = excluded.deezer_track_id,
          deezer_bpm = excluded.deezer_bpm,
          deezer_gain = excluded.deezer_gain,
          acoustid_id = excluded.acoustid_id,
          match_method = excluded.match_method,
          match_score = excluded.match_score,
          matched_at = excluded.matched_at,
          raw_json = excluded.raw_json`,
      )
      .run(
        row.trackId,
        row.releaseMbid,
        row.releaseGroupMbid,
        row.artistMbidsJson,
        row.catalogNumber,
        row.originalDate,
        row.deezerTrackId,
        row.deezerBpm,
        row.deezerGain,
        row.acoustidId,
        row.matchMethod,
        row.matchScore,
        row.matchedAt,
        row.rawJson,
      );
  }

  findByTrackId(trackId: string): StoredEnrichment | null {
    const row = this.db
      .prepare("SELECT * FROM track_enrichment WHERE track_id = ?")
      .get(trackId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      trackId: String(row.track_id),
      releaseMbid: (row.release_mbid as string | null) ?? null,
      releaseGroupMbid: (row.release_group_mbid as string | null) ?? null,
      artistMbidsJson: (row.artist_mbids_json as string | null) ?? null,
      catalogNumber: (row.catalog_number as string | null) ?? null,
      originalDate: (row.original_date as string | null) ?? null,
      deezerTrackId: (row.deezer_track_id as string | null) ?? null,
      deezerBpm: (row.deezer_bpm as number | null) ?? null,
      deezerGain: (row.deezer_gain as number | null) ?? null,
      acoustidId: (row.acoustid_id as string | null) ?? null,
      matchMethod: (row.match_method as StoredEnrichment["matchMethod"]) ?? null,
      matchScore: (row.match_score as number | null) ?? null,
      matchedAt: (row.matched_at as string | null) ?? null,
      rawJson: (row.raw_json as string | null) ?? null,
    };
  }

  listUnmatchedIds(): string[] {
    return (
      this.db
        .prepare(
          `SELECT t.id FROM tracks t
           LEFT JOIN track_enrichment e ON e.track_id = t.id
           WHERE t.file_missing = 0 AND (
             e.track_id IS NULL
             OR e.match_method IS NULL
             OR json_extract(e.raw_json, '$.dryRun') = 1
           )`,
        )
        .all() as { id: string }[]
    ).map((row) => row.id);
  }

  report(): EnrichmentReport {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.title, e.match_method, e.match_score, e.raw_json, e.deezer_bpm
         FROM tracks t
         LEFT JOIN track_enrichment e ON e.track_id = t.id
         WHERE t.file_missing = 0`,
      )
      .all() as Array<{
      id: string;
      title: string;
      match_method: string | null;
      match_score: number | null;
      raw_json: string | null;
      deezer_bpm: number | null;
    }>;
    const matchedByMethod: Record<string, number> = {};
    let unmatched = 0;
    let needsReview = 0;
    let bpmWritten = 0;
    let bpmDisagreements = 0;
    const reportRows = rows.map((row) => {
      const raw = row.raw_json ? (JSON.parse(row.raw_json) as Record<string, unknown>) : {};
      const review = raw.needsReview === true;
      const written = raw.bpmWritten === true;
      const disagreement = raw.bpmDisagreement === true;
      if (row.match_method) {
        matchedByMethod[row.match_method] = (matchedByMethod[row.match_method] ?? 0) + 1;
      } else {
        unmatched += 1;
      }
      if (review) {
        needsReview += 1;
      }
      if (written) {
        bpmWritten += 1;
      }
      if (disagreement) {
        bpmDisagreements += 1;
      }
      return {
        trackId: row.id,
        title: row.title,
        method: (row.match_method as EnrichmentReport["rows"][number]["method"]) ?? null,
        score: row.match_score,
        needsReview: review,
        bpmWritten: written,
        bpmDisagreement: disagreement,
      };
    });
    const duplicateGroups = (
      this.db
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
    return {
      matchedByMethod,
      unmatched,
      needsReview,
      bpmWritten,
      bpmDisagreements,
      duplicateGroups,
      rows: reportRows,
    };
  }
}
