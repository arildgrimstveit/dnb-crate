import {
  isDislike,
  isLike,
  pairKey,
  preferenceBonus,
  type FeedbackIndex,
  type FeedbackRatingValue,
  type TransitionFeedback,
  type TransitionPreference,
} from "@dnb-crate/domain";

import type { SqliteDatabase } from "./db.ts";

function parseRating(raw: string): FeedbackRatingValue {
  if (raw === "not_assessed") {
    return "not_assessed";
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : "not_assessed";
}

function encodeRating(value: FeedbackRatingValue | undefined): string {
  if (value === undefined) {
    return "not_assessed";
  }
  return value === "not_assessed" ? "not_assessed" : String(value);
}

type FeedbackRow = {
  id: string;
  recipe_fingerprint: string;
  outgoing_track_id: string | null;
  incoming_track_id: string | null;
  set_plan_id: string | null;
  render_job_id: string | null;
  transition_id: string | null;
  renderer_version: string | null;
  overall: string;
  timing: string;
  phrasing: string;
  bass_clarity: string;
  harmonic_fit: string;
  energy_continuity: string;
  vocal_clash: string;
  note: string | null;
  created_at: string;
};

function mapRow(row: FeedbackRow): TransitionFeedback {
  return {
    id: row.id,
    recipeFingerprint: row.recipe_fingerprint,
    outgoingTrackId: row.outgoing_track_id,
    incomingTrackId: row.incoming_track_id,
    setPlanId: row.set_plan_id,
    renderJobId: row.render_job_id,
    transitionId: row.transition_id,
    rendererVersion: row.renderer_version,
    overall: parseRating(row.overall),
    timing: parseRating(row.timing),
    phrasing: parseRating(row.phrasing),
    bassClarity: parseRating(row.bass_clarity),
    harmonicFit: parseRating(row.harmonic_fit),
    energyContinuity: parseRating(row.energy_continuity),
    vocalClash: parseRating(row.vocal_clash),
    note: row.note,
    createdAt: row.created_at,
  };
}

export class FeedbackRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(row: Omit<TransitionFeedback, "id" | "createdAt"> & { id?: string }): TransitionFeedback {
    const id = row.id ?? crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO transition_feedback (
          id, recipe_fingerprint, outgoing_track_id, incoming_track_id, set_plan_id,
          render_job_id, transition_id, renderer_version, overall, timing, phrasing,
          bass_clarity, harmonic_fit, energy_continuity, vocal_clash, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.recipeFingerprint,
        row.outgoingTrackId,
        row.incomingTrackId,
        row.setPlanId,
        row.renderJobId,
        row.transitionId,
        row.rendererVersion,
        encodeRating(row.overall),
        encodeRating(row.timing),
        encodeRating(row.phrasing),
        encodeRating(row.bassClarity),
        encodeRating(row.harmonicFit),
        encodeRating(row.energyContinuity),
        encodeRating(row.vocalClash),
        row.note,
        createdAt,
      );
    return this.findById(id)!;
  }

  findById(id: string): TransitionFeedback | null {
    const row = this.db.prepare("SELECT * FROM transition_feedback WHERE id = ?").get(id) as
      FeedbackRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(input: {
    recipeFingerprint?: string;
    outgoingTrackId?: string;
    incomingTrackId?: string;
    limit?: number;
  }): TransitionFeedback[] {
    const limit = input.limit ?? 50;
    let sql = "SELECT * FROM transition_feedback WHERE 1 = 1";
    const params: unknown[] = [];
    if (input.recipeFingerprint) {
      sql += " AND recipe_fingerprint = ?";
      params.push(input.recipeFingerprint);
    }
    if (input.outgoingTrackId) {
      sql += " AND outgoing_track_id = ?";
      params.push(input.outgoingTrackId);
    }
    if (input.incomingTrackId) {
      sql += " AND incoming_track_id = ?";
      params.push(input.incomingTrackId);
    }
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as FeedbackRow[]).map(mapRow);
  }

  summarize(input: {
    recipeFingerprint?: string;
    outgoingTrackId?: string;
    incomingTrackId?: string;
  }): TransitionPreference[] {
    const rows = this.list({ ...input, limit: -1 });
    const byKey = new Map<string, TransitionPreference>();
    for (const row of rows) {
      const fingerprint = row.recipeFingerprint;
      const pair =
        row.outgoingTrackId && row.incomingTrackId
          ? pairKey(row.outgoingTrackId, row.incomingTrackId)
          : null;
      const keys = [fingerprint ? `fp:${fingerprint}` : null, pair ? `pair:${pair}` : null].filter(
        (value): value is string => Boolean(value),
      );
      for (const key of keys) {
        const current = byKey.get(key) ?? {
          recipeFingerprint: key.startsWith("fp:") ? fingerprint : null,
          pairKey: key.startsWith("pair:") ? pair : null,
          likeCount: 0,
          dislikeCount: 0,
          noteCount: 0,
          bonus: 0,
        };
        if (isLike(row.overall)) {
          current.likeCount += 1;
        }
        if (isDislike(row.overall)) {
          current.dislikeCount += 1;
        }
        if (row.note) {
          current.noteCount += 1;
        }
        current.bonus = preferenceBonus(current.likeCount, current.dislikeCount);
        byKey.set(key, current);
      }
    }
    return [...byKey.values()];
  }

  index(): FeedbackIndex {
    const rows = this.list({ limit: -1 });
    const byFingerprint = new Map<string, TransitionPreference>();
    const byPair = new Map<string, TransitionPreference>();
    const bump = (
      map: Map<string, TransitionPreference>,
      key: string,
      extra: Pick<TransitionPreference, "recipeFingerprint" | "pairKey">,
      row: TransitionFeedback,
    ) => {
      const current = map.get(key) ?? {
        recipeFingerprint: extra.recipeFingerprint,
        pairKey: extra.pairKey,
        likeCount: 0,
        dislikeCount: 0,
        noteCount: 0,
        bonus: 0,
      };
      if (isLike(row.overall)) {
        current.likeCount += 1;
      }
      if (isDislike(row.overall)) {
        current.dislikeCount += 1;
      }
      if (row.note) {
        current.noteCount += 1;
      }
      current.bonus = preferenceBonus(current.likeCount, current.dislikeCount);
      map.set(key, current);
    };
    for (const row of rows) {
      bump(
        byFingerprint,
        row.recipeFingerprint,
        { recipeFingerprint: row.recipeFingerprint, pairKey: null },
        row,
      );
      if (row.outgoingTrackId && row.incomingTrackId) {
        const key = pairKey(row.outgoingTrackId, row.incomingTrackId);
        bump(byPair, key, { recipeFingerprint: null, pairKey: key }, row);
      }
    }
    return { byFingerprint, byPair };
  }
}
