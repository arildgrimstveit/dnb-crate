import type { SuggestedCue, TrackAnalysis, TrackAnalysisView } from "@dnb-crate/domain";
import { resolveCanonicalBpm, resolveCanonicalKey, type Track } from "@dnb-crate/domain";

import type { SqliteDatabase } from "./db.ts";

type AnalysisRow = {
  track_id: string;
  analyzer_name: string;
  analyzer_version: string;
  bpm: number | null;
  bpm_confidence: number | null;
  bpm_raw: number | null;
  beat_times_json: string;
  downbeat_times_json: string;
  grid_rejected: number;
  grid_rejection_reason: string | null;
  musical_key: string | null;
  key_confidence: number | null;
  integrated_lufs: number | null;
  true_peak_db: number | null;
  low_band_energy: number | null;
  mid_band_energy: number | null;
  high_band_energy: number | null;
  waveform_summary_json: string | null;
  beat_anchor_ms: number | null;
  suggested_cues_json: string;
  analyzed_at: string;
};

export type StoredTrackAnalysis = TrackAnalysis & { suggestedCues: SuggestedCue[] };

function mapAnalysis(row: AnalysisRow): StoredTrackAnalysis {
  return {
    trackId: row.track_id,
    analyzerName: row.analyzer_name,
    analyzerVersion: row.analyzer_version,
    bpm: row.bpm,
    bpmConfidence: row.bpm_confidence,
    bpmRaw: row.bpm_raw,
    beatTimesMs: JSON.parse(row.beat_times_json) as number[],
    downbeatTimesMs: JSON.parse(row.downbeat_times_json) as number[],
    gridRejected: row.grid_rejected === 1,
    gridRejectionReason: row.grid_rejection_reason,
    musicalKey: row.musical_key,
    keyConfidence: row.key_confidence,
    integratedLufs: row.integrated_lufs,
    truePeakDb: row.true_peak_db,
    lowBandEnergy: row.low_band_energy,
    midBandEnergy: row.mid_band_energy,
    highBandEnergy: row.high_band_energy,
    waveformSummary: row.waveform_summary_json
      ? (JSON.parse(row.waveform_summary_json) as number[])
      : null,
    beatAnchorMs: row.beat_anchor_ms,
    analyzedAt: row.analyzed_at,
    suggestedCues: JSON.parse(row.suggested_cues_json) as SuggestedCue[],
  };
}

export class AnalysisRepository {
  constructor(private readonly db: SqliteDatabase) {}

  findByTrackId(trackId: string): StoredTrackAnalysis | null {
    const row = this.db.prepare("SELECT * FROM track_analyses WHERE track_id = ?").get(trackId) as
      AnalysisRow | undefined;
    return row ? mapAnalysis(row) : null;
  }

  upsert(analysis: StoredTrackAnalysis): StoredTrackAnalysis {
    this.db
      .prepare(
        `INSERT INTO track_analyses (
          track_id, analyzer_name, analyzer_version, bpm, bpm_confidence, bpm_raw,
          beat_times_json, downbeat_times_json, grid_rejected, grid_rejection_reason,
          musical_key, key_confidence, integrated_lufs, true_peak_db,
          low_band_energy, mid_band_energy, high_band_energy, waveform_summary_json,
          beat_anchor_ms, suggested_cues_json, analyzed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(track_id) DO UPDATE SET
          analyzer_name = excluded.analyzer_name,
          analyzer_version = excluded.analyzer_version,
          bpm = excluded.bpm,
          bpm_confidence = excluded.bpm_confidence,
          bpm_raw = excluded.bpm_raw,
          beat_times_json = excluded.beat_times_json,
          downbeat_times_json = excluded.downbeat_times_json,
          grid_rejected = excluded.grid_rejected,
          grid_rejection_reason = excluded.grid_rejection_reason,
          musical_key = excluded.musical_key,
          key_confidence = excluded.key_confidence,
          integrated_lufs = excluded.integrated_lufs,
          true_peak_db = excluded.true_peak_db,
          low_band_energy = excluded.low_band_energy,
          mid_band_energy = excluded.mid_band_energy,
          high_band_energy = excluded.high_band_energy,
          waveform_summary_json = excluded.waveform_summary_json,
          beat_anchor_ms = excluded.beat_anchor_ms,
          suggested_cues_json = excluded.suggested_cues_json,
          analyzed_at = excluded.analyzed_at`,
      )
      .run(
        analysis.trackId,
        analysis.analyzerName,
        analysis.analyzerVersion,
        analysis.bpm,
        analysis.bpmConfidence,
        analysis.bpmRaw,
        JSON.stringify(analysis.beatTimesMs),
        JSON.stringify(analysis.downbeatTimesMs),
        analysis.gridRejected ? 1 : 0,
        analysis.gridRejectionReason,
        analysis.musicalKey,
        analysis.keyConfidence,
        analysis.integratedLufs,
        analysis.truePeakDb,
        analysis.lowBandEnergy,
        analysis.midBandEnergy,
        analysis.highBandEnergy,
        analysis.waveformSummary ? JSON.stringify(analysis.waveformSummary) : null,
        analysis.beatAnchorMs,
        JSON.stringify(analysis.suggestedCues),
        analysis.analyzedAt,
      );
    return this.findByTrackId(analysis.trackId)!;
  }

  getBeatAnchorMs(trackId: string): number | null {
    const row = this.db
      .prepare("SELECT position_ms FROM beat_anchors WHERE track_id = ?")
      .get(trackId) as { position_ms: number } | undefined;
    return row?.position_ms ?? null;
  }

  upsertBeatAnchor(trackId: string, positionMs: number): void {
    this.db
      .prepare(
        `INSERT INTO beat_anchors (track_id, position_ms, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(track_id) DO UPDATE SET position_ms = excluded.position_ms, updated_at = excluded.updated_at`,
      )
      .run(trackId, positionMs, new Date().toISOString());
  }

  toView(track: Track, analysis: StoredTrackAnalysis | null): TrackAnalysisView | null {
    if (!analysis) {
      return null;
    }
    const bpm = resolveCanonicalBpm(track, analysis);
    const key = resolveCanonicalKey(track, analysis);
    return {
      ...analysis,
      canonicalBpm: bpm.bpm,
      canonicalBpmSource: bpm.source,
      canonicalKey: key.musicalKey,
      canonicalKeySource: key.source,
    };
  }
}
