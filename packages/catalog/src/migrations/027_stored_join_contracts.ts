import type { Migration } from "../migrate.ts";
import {
  resolveJoinInputs,
  stripJoinResolution,
  type TransitionParameterBag,
} from "@dnb-crate/domain";

/**
 * Q03 slice 3: retire recipeVersion as the alignment-validity flag by
 * upgrading stored plans to the versioned resolved-join contract.
 *
 * Every stored transition marked recipeVersion 1 (the legacy "resolved
 * placement" pin) gains a stamped ResolvedJoinContext built from its own
 * frozen coordinates: entry windows/rates from the plan rows, the join
 * anchor from the incoming entry's timeline position, overlap from the
 * transition duration, alignment from the stored parameters, and evidence
 * fingerprints from the tracks table. Joins that cannot construct a valid
 * contract keep their legacy marker and gain an explicit joinResolution
 * reason — they were the silently-clamped class (T5), and render-time
 * alignment now handles them honestly.
 */
export const migration027StoredJoinContracts: Migration = {
  id: 27,
  name: "stored_join_contracts",
  up(db) {
    const rows = db
      .prepare(
        `SELECT e.set_plan_id, e.id AS entry_id, e.track_id, e.order_index, e.source_start_ms,
                e.source_end_ms, e.timeline_start_ms, e.playback_rate, e.gain_db, e.transition_json
         FROM set_plan_entries e
         WHERE e.transition_json IS NOT NULL
         ORDER BY e.set_plan_id, e.order_index`,
      )
      .all() as Array<{
      set_plan_id: string;
      entry_id: string;
      track_id: string;
      order_index: number;
      source_start_ms: number;
      source_end_ms: number;
      timeline_start_ms: number;
      playback_rate: number;
      gain_db: number;
      transition_json: string;
    }>;

    const fingerprintStmt = db.prepare(`SELECT file_fingerprint FROM tracks WHERE id = ?`);
    const nextEntryStmt = db.prepare(
      `SELECT id, track_id, source_start_ms, source_end_ms, timeline_start_ms, playback_rate
         FROM set_plan_entries WHERE set_plan_id = ? AND order_index = ?`,
    );
    const updateStmt = db.prepare(`UPDATE set_plan_entries SET transition_json = ? WHERE id = ?`);

    for (const row of rows) {
      let transition: {
        id?: string;
        type?: string;
        durationMs?: number;
        parameters?: Record<string, unknown>;
      };
      try {
        transition = JSON.parse(row.transition_json) as typeof transition;
      } catch {
        continue;
      }
      const parameters = transition.parameters;
      if (parameters == null || parameters.recipeVersion !== 1 || parameters.resolvedJoin != null) {
        continue;
      }
      const next = nextEntryStmt.get(row.set_plan_id, row.order_index + 1) as
        | {
            id: string;
            track_id: string;
            source_start_ms: number;
            source_end_ms: number;
            timeline_start_ms: number;
            playback_rate: number;
          }
        | undefined;
      if (!next) {
        continue;
      }
      const outgoingFingerprint = (
        fingerprintStmt.get(row.track_id) as { file_fingerprint: string | null } | undefined
      )?.file_fingerprint;
      const incomingFingerprint = (
        fingerprintStmt.get(next.track_id) as { file_fingerprint: string | null } | undefined
      )?.file_fingerprint;
      const paramNum = (key: string): number | null => {
        const value = parameters[key];
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      };
      const overlapMs = typeof transition.durationMs === "number" ? transition.durationMs : 0;
      const targetBpm = paramNum("targetBpm");
      const barCount = paramNum("barCount");
      const resolution = resolveJoinInputs({
        outgoingEntryId: row.entry_id,
        incomingEntryId: next.id,
        transitionId: transition.id ?? row.entry_id,
        geometry: {
          outgoingSourceStartMs: row.source_start_ms,
          outgoingSourceEndMs: row.source_end_ms,
          incomingSourceStartMs: next.source_start_ms,
          incomingSourceEndMs: next.source_end_ms,
          joinOutputAnchorMs: next.timeline_start_ms,
          overlapMs,
          outgoingRate: row.playback_rate,
          incomingRate: next.playback_rate,
          phraseBarCount: barCount === 8 || barCount === 16 || barCount === 32 ? barCount : null,
        },
        alignment: {
          mode:
            parameters.alignmentMode === "beat" || parameters.alignmentMode === "phrase"
              ? parameters.alignmentMode
              : "bar",
          periodMs:
            paramNum("alignmentPeriodMs") ??
            (targetBpm != null && targetBpm > 0 ? (4 * 60_000) / targetBpm : (4 * 60_000) / 174),
          downbeatOffsetMs: paramNum("downbeatOffsetMs") ?? 0,
          onsetLockBeats:
            typeof parameters.onsetLockBeats === "number" ? parameters.onsetLockBeats : null,
          confidence: null,
          coverage: null,
        },
        evidence: {
          outgoingFingerprint: outgoingFingerprint ?? "",
          incomingFingerprint: incomingFingerprint ?? "",
          analyzerVersion: null,
          gridSource: null,
        },
        treatment: {
          type:
            transition.type === "bass_swap"
              ? "bass_swap"
              : transition.type === "crossfade"
                ? "crossfade"
                : "phrase_mix",
          params: stripJoinResolution(parameters as unknown as TransitionParameterBag),
        },
        // A legacy retained numeric gain is authoritative: pinned.
        gain: { gainDb: row.gain_db, source: "pinned" },
      });
      if (resolution.status === "resolved") {
        // Retired: the flag goes, the contract carries the semantics.
        delete parameters.recipeVersion;
        parameters.resolvedJoin = resolution.context;
      } else {
        // Unresolvable legacy pin: record the honest reason. The renderer
        // no longer reads the flag, so these joins re-align at render time
        // - the class T5 identified as silently clamped, now handled
        // openly. The stale flag stays for forensics.
        parameters.joinResolution = resolution;
      }
      updateStmt.run(JSON.stringify(transition), row.entry_id);
    }
  },
};
