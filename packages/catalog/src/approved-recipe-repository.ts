import {
  type ApprovedRecipeRecord,
  type ApprovedRecipeStatus,
  type ReusableRecipePayload,
} from "@dnb-crate/domain";

import type { SqliteDatabase } from "./db.ts";

type ApprovedRow = {
  id: string;
  status: string;
  pair_key: string;
  reusable_fingerprint: string;
  payload_json: string;
  heard_render_fingerprint: string | null;
  render_job_id: string | null;
  transition_id: string | null;
  set_plan_id: string | null;
  outgoing_track_id: string;
  incoming_track_id: string;
  outgoing_title: string | null;
  incoming_title: string | null;
  note: string | null;
  created_at: string;
};

function mapRow(row: ApprovedRow): ApprovedRecipeRecord {
  return {
    id: row.id,
    status: row.status as ApprovedRecipeStatus,
    pairKey: row.pair_key,
    reusableFingerprint: row.reusable_fingerprint,
    payload: JSON.parse(row.payload_json) as ReusableRecipePayload,
    heardRenderFingerprint: row.heard_render_fingerprint,
    renderJobId: row.render_job_id,
    transitionId: row.transition_id,
    setPlanId: row.set_plan_id,
    outgoingTitle: row.outgoing_title,
    incomingTitle: row.incoming_title,
    note: row.note,
    createdAt: row.created_at,
  };
}

export class ApprovedRecipeRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(row: Omit<ApprovedRecipeRecord, "id" | "createdAt"> & { id?: string; createdAt?: string }): ApprovedRecipeRecord {
    const id = row.id ?? crypto.randomUUID();
    const createdAt = row.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO approved_recipes (
          id, status, pair_key, reusable_fingerprint, payload_json, heard_render_fingerprint,
          render_job_id, transition_id, set_plan_id, outgoing_track_id, incoming_track_id,
          outgoing_title, incoming_title, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.status,
        row.pairKey,
        row.reusableFingerprint,
        JSON.stringify(row.payload),
        row.heardRenderFingerprint,
        row.renderJobId,
        row.transitionId,
        row.setPlanId,
        row.payload.outgoingTrackId,
        row.payload.incomingTrackId,
        row.outgoingTitle,
        row.incomingTitle,
        row.note,
        createdAt,
      );
    return this.findById(id)!;
  }

  findDuplicate(input: {
    reusableFingerprint: string;
    status: ApprovedRecipeStatus;
    note: string | null;
  }): ApprovedRecipeRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM approved_recipes
         WHERE reusable_fingerprint = ? AND status = ? AND ifnull(note, '') = ifnull(?, '')
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(input.reusableFingerprint, input.status, input.note) as ApprovedRow | undefined;
    return row ? mapRow(row) : null;
  }

  findById(id: string): ApprovedRecipeRecord | null {
    const row = this.db.prepare("SELECT * FROM approved_recipes WHERE id = ?").get(id) as
      | ApprovedRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  listForPair(outgoingTrackId: string, incomingTrackId: string): ApprovedRecipeRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM approved_recipes
           WHERE outgoing_track_id = ? AND incoming_track_id = ?
           ORDER BY created_at DESC, id DESC`,
        )
        .all(outgoingTrackId, incomingTrackId) as ApprovedRow[]
    ).map(mapRow);
  }

  listAll(): ApprovedRecipeRecord[] {
    return (this.db.prepare("SELECT * FROM approved_recipes ORDER BY created_at DESC, id DESC").all() as ApprovedRow[]).map(
      mapRow,
    );
  }
}
