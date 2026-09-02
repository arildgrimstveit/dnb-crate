import {
  buildBeatGridSummary,
  resolveCanonicalBpm,
  resolveCanonicalKey,
  type SonicDescriptors,
  type SuggestedCue,
  type Track,
  type TrackAnalysis,
  type TrackAnalysisView,
  type TrackSection,
} from "@dnb-crate/domain";

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
  key_mode: "major" | "minor" | null;
  camelot_key: string | null;
  tempo_stability: number | null;
  downbeat_confidence: number | null;
  integrated_lufs: number | null;
  true_peak_db: number | null;
  low_band_energy: number | null;
  mid_band_energy: number | null;
  high_band_energy: number | null;
  waveform_summary_json: string | null;
  beat_anchor_ms: number | null;
  suggested_cues_json: string;
  descriptors_json: string | null;
  engine_runtime_ms: number | null;
  analyzed_at: string;
  grid_source?: string | null;
};

export type StoredTrackAnalysis = TrackAnalysis & {
  suggestedCues: SuggestedCue[];
  sections: TrackSection[];
};

function mapAnalysis(row: AnalysisRow, sections: TrackSection[] = []): StoredTrackAnalysis {
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
    gridSource:
      row.grid_source === "reference" || row.grid_source === "anchor" || row.grid_source === "analyzed"
        ? row.grid_source
        : "analyzed",
    musicalKey: row.musical_key,
    keyConfidence: row.key_confidence,
    keyMode: row.key_mode,
    camelotKey: row.camelot_key,
    tempoStability: row.tempo_stability,
    downbeatConfidence: row.downbeat_confidence,
    integratedLufs: row.integrated_lufs,
    truePeakDb: row.true_peak_db,
    lowBandEnergy: row.low_band_energy,
    midBandEnergy: row.mid_band_energy,
    highBandEnergy: row.high_band_energy,
    waveformSummary: row.waveform_summary_json
      ? (JSON.parse(row.waveform_summary_json) as number[])
      : null,
    beatAnchorMs: row.beat_anchor_ms,
    descriptors: row.descriptors_json
      ? (JSON.parse(row.descriptors_json) as SonicDescriptors)
      : null,
    engineRuntimeMs: row.engine_runtime_ms,
    analyzedAt: row.analyzed_at,
    suggestedCues: JSON.parse(row.suggested_cues_json) as SuggestedCue[],
    sections,
  };
}

const PREFERRED_ORDER = ["dnb-crate-dsp", "beat-this", "allin1", "dnb-crate-envelope"];

export class AnalysisRepository {
  constructor(private readonly db: SqliteDatabase) {}

  listByTrackId(trackId: string): StoredTrackAnalysis[] {
    const rows = this.db
      .prepare("SELECT * FROM track_analyses WHERE track_id = ?")
      .all(trackId) as AnalysisRow[];
    return rows.map((row) => mapAnalysis(row, this.listSections(trackId, row.analyzer_name)));
  }

  findByTrackId(trackId: string, engine?: string): StoredTrackAnalysis | null {
    if (engine) {
      const row = this.db
        .prepare("SELECT * FROM track_analyses WHERE track_id = ? AND analyzer_name = ?")
        .get(trackId, engine) as AnalysisRow | undefined;
      return row ? mapAnalysis(row, this.listSections(trackId, engine)) : null;
    }
    const all = this.listByTrackId(trackId);
    if (all.length === 0) {
      return null;
    }
    const ranked = [...all].sort((a, b) => {
      const ai = PREFERRED_ORDER.indexOf(a.analyzerName);
      const bi = PREFERRED_ORDER.indexOf(b.analyzerName);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    return ranked[0] ?? null;
  }

  listSections(trackId: string, analyzerName: string): TrackSection[] {
    const rows = this.db
      .prepare(
        `SELECT type, start_ms, end_ms, start_bar, end_bar, confidence, energy
         FROM track_sections WHERE track_id = ? AND analyzer_name = ?
         ORDER BY start_ms ASC`,
      )
      .all(trackId, analyzerName) as Array<{
      type: TrackSection["type"];
      start_ms: number;
      end_ms: number;
      start_bar: number | null;
      end_bar: number | null;
      confidence: number;
      energy: number;
    }>;
    return rows.map((row) => ({
      type: row.type,
      startMs: row.start_ms,
      endMs: row.end_ms,
      startBar: row.start_bar,
      endBar: row.end_bar,
      confidence: row.confidence,
      sectionEnergy: row.energy,
    }));
  }

  replaceSections(trackId: string, analyzerName: string, sections: TrackSection[]): void {
    const run = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM track_sections WHERE track_id = ? AND analyzer_name = ?")
        .run(trackId, analyzerName);
      const stmt = this.db.prepare(
        `INSERT INTO track_sections (
          id, track_id, analyzer_name, type, start_ms, end_ms, start_bar, end_bar, confidence, energy
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const section of sections) {
        stmt.run(
          crypto.randomUUID(),
          trackId,
          analyzerName,
          section.type,
          Math.round(section.startMs),
          Math.round(section.endMs),
          section.startBar,
          section.endBar,
          section.confidence,
          section.sectionEnergy,
        );
      }
    });
    run();
  }

  upsert(analysis: StoredTrackAnalysis): StoredTrackAnalysis {
    this.db
      .prepare(
        `INSERT INTO track_analyses (
          track_id, analyzer_name, analyzer_version, bpm, bpm_confidence, bpm_raw,
          beat_times_json, downbeat_times_json, grid_rejected, grid_rejection_reason, grid_source,
          musical_key, key_confidence, key_mode, camelot_key, tempo_stability, downbeat_confidence,
          integrated_lufs, true_peak_db, low_band_energy, mid_band_energy, high_band_energy,
          waveform_summary_json, beat_anchor_ms, suggested_cues_json, descriptors_json,
          engine_runtime_ms, analyzed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(track_id, analyzer_name) DO UPDATE SET
          analyzer_version = excluded.analyzer_version,
          bpm = excluded.bpm,
          bpm_confidence = excluded.bpm_confidence,
          bpm_raw = excluded.bpm_raw,
          beat_times_json = excluded.beat_times_json,
          downbeat_times_json = excluded.downbeat_times_json,
          grid_rejected = excluded.grid_rejected,
          grid_rejection_reason = excluded.grid_rejection_reason,
          grid_source = excluded.grid_source,
          musical_key = excluded.musical_key,
          key_confidence = excluded.key_confidence,
          key_mode = excluded.key_mode,
          camelot_key = excluded.camelot_key,
          tempo_stability = excluded.tempo_stability,
          downbeat_confidence = excluded.downbeat_confidence,
          integrated_lufs = excluded.integrated_lufs,
          true_peak_db = excluded.true_peak_db,
          low_band_energy = excluded.low_band_energy,
          mid_band_energy = excluded.mid_band_energy,
          high_band_energy = excluded.high_band_energy,
          waveform_summary_json = excluded.waveform_summary_json,
          beat_anchor_ms = excluded.beat_anchor_ms,
          suggested_cues_json = excluded.suggested_cues_json,
          descriptors_json = excluded.descriptors_json,
          engine_runtime_ms = excluded.engine_runtime_ms,
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
        analysis.gridSource ?? "analyzed",
        analysis.musicalKey,
        analysis.keyConfidence,
        analysis.keyMode,
        analysis.camelotKey,
        analysis.tempoStability,
        analysis.downbeatConfidence,
        analysis.integratedLufs,
        analysis.truePeakDb,
        analysis.lowBandEnergy,
        analysis.midBandEnergy,
        analysis.highBandEnergy,
        analysis.waveformSummary ? JSON.stringify(analysis.waveformSummary) : null,
        analysis.beatAnchorMs,
        JSON.stringify(analysis.suggestedCues),
        analysis.descriptors ? JSON.stringify(analysis.descriptors) : null,
        analysis.engineRuntimeMs,
        analysis.analyzedAt,
      );
    this.replaceSections(analysis.trackId, analysis.analyzerName, analysis.sections ?? []);
    return this.findByTrackId(analysis.trackId, analysis.analyzerName)!;
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
    const availableEngines = this.listByTrackId(track.id).map((row) => row.analyzerName);
    return {
      ...analysis,
      canonicalBpm: bpm.bpm,
      canonicalBpmSource: bpm.source,
      canonicalKey: key.musicalKey,
      canonicalKeySource: key.source,
      sections: analysis.sections ?? [],
      availableEngines: availableEngines.length > 0 ? availableEngines : [analysis.analyzerName],
      gridSummary: buildBeatGridSummary(analysis),
    };
  }
}
