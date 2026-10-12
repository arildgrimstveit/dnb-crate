import { LEVEL_MATCH_GAIN_MAX_DB, LEVEL_MATCH_GAIN_MIN_DB } from "./constants.ts";
import type { TimeIndexedLoudness } from "./analysis-contracts.ts";

/**
 * Q04 (12 October roadmap): window-aware loudness reading and the joint
 * attenuate-first gain solver. Both are PURE domain functions over the
 * stored TimeIndexedLoudness series - the sections that will actually
 * play, not whole-track integrated values, and never normalized RMS
 * substituted for perceptual loudness.
 */

/** Representative short-term loudness over a SOURCE-time window of the
 * series. Frames are the 100 ms hops; the window [startMs, endMs) maps to
 * frames by hop. Returns null when the window has no valid (non-silent)
 * frames - unknown stays unknown. */
export function windowShortTermLoudness(
  series: Pick<TimeIndexedLoudness, "hopMs" | "shortTermLufs">,
  window: { startMs: number; endMs: number },
): {
  medianLufs: number;
  p10Lufs: number;
  p90Lufs: number;
  coverage: number;
  frameCount: number;
} | null {
  const hopMs = series.hopMs > 0 ? series.hopMs : 100;
  const first = Math.max(0, Math.ceil(window.startMs / hopMs));
  const lastExcl = Math.min(series.shortTermLufs.length, Math.ceil(window.endMs / hopMs));
  const values: number[] = [];
  const total = Math.max(0, lastExcl - first);
  for (let i = first; i < lastExcl; i += 1) {
    const value = series.shortTermLufs[i];
    if (value != null) {
      values.push(value);
    }
  }
  if (values.length === 0) {
    return null;
  }
  values.sort((a, b) => a - b);
  const quantile = (q: number): number =>
    values[Math.min(values.length - 1, Math.floor(q * values.length))]!;
  return {
    medianLufs: quantile(0.5),
    p10Lufs: quantile(0.1),
    p90Lufs: quantile(0.9),
    coverage: total === 0 ? 1 : values.length / total,
    frameCount: total,
  };
}

export type SetGainEntry = {
  id: string;
  /** Window body short-term loudness (LUFS); null = unknown (passthrough). */
  bodyShortTermLufs: number | null;
  /** Whole-source true peak (dBFS); boosts are additionally capped so the
   * peaked source cannot be pushed past the ceiling. */
  truePeakDb: number | null;
  /** Current gain (dB), retained for unknown entries. */
  currentGainDb: number;
};

export type SetGainSolution = {
  /** The common body reference the solver selected (LUFS); null when no
   * entry carried loudness. */
  referenceLufs: number | null;
  gains: Array<{ id: string; gainDb: number; residualLufs: number; matched: boolean }>;
  /** Total boost dB applied - the attenuate-first objective minimizes it. */
  totalBoostDb: number;
};

/** The true-peak ceiling boosts must respect (dBFS), matching the
 * historical level-match headroom policy. */
const BOOST_PEAK_CEILING_DB = -0.1;

/**
 * Q04 joint gain solver: choose ONE common body reference and per-entry
 * gains within the declared limits, PREFERRING ATTENUATION - the roadmap's
 * reproduced policy failure was a hot (-10 LUFS) track pinned at 0 dB
 * while the quiet track's boost was capped, leaving a 5.9 LU planned
 * difference. The solver instead lets the loud track come DOWN to meet
 * the quiet one whenever the limits allow.
 *
 * Objective, in order: (1) fewest infeasible entries (clamped residuals),
 * (2) least total boost, (3) least total |residual|. Entries without
 * loudness pass their current gain through, matched: false.
 */
export function solveSetGains(
  entries: SetGainEntry[],
  limits: { minGainDb?: number; maxGainDb?: number } = {},
): SetGainSolution {
  const minGainDb = limits.minGainDb ?? LEVEL_MATCH_GAIN_MIN_DB;
  const maxGainDb = limits.maxGainDb ?? LEVEL_MATCH_GAIN_MAX_DB;
  const unknown = entries.filter((entry) => entry.bodyShortTermLufs == null);
  const known = entries.filter(
    (entry): entry is SetGainEntry & { bodyShortTermLufs: number } =>
      entry.bodyShortTermLufs != null,
  );
  const solveFor = (referenceLufs: number) => {
    const gains = entries.map((entry) => {
      if (entry.bodyShortTermLufs == null) {
        return { id: entry.id, gainDb: entry.currentGainDb, residualLufs: 0, matched: false };
      }
      const desired = referenceLufs - entry.bodyShortTermLufs;
      let effectiveMax = maxGainDb;
      if (entry.truePeakDb != null) {
        effectiveMax = Math.min(effectiveMax, BOOST_PEAK_CEILING_DB - entry.truePeakDb);
      }
      const gainDb = Math.round(Math.min(effectiveMax, Math.max(minGainDb, desired)) * 10) / 10;
      return {
        id: entry.id,
        gainDb,
        residualLufs: Number((desired - gainDb).toFixed(2)),
        matched: true,
      };
    });
    const infeasible = gains.filter((g) => g.matched && Math.abs(g.residualLufs) > 0.05).length;
    const totalBoostDb =
      Math.round(
        gains.reduce((sum, g) => sum + (g.matched && g.gainDb > 0 ? g.gainDb : 0), 0) * 10,
      ) / 10;
    const totalAbsResidual =
      Math.round(gains.reduce((sum, g) => sum + Math.abs(g.residualLufs), 0) * 100) / 100;
    return { gains, infeasible, totalBoostDb, totalAbsResidual };
  };
  if (known.length === 0) {
    return {
      referenceLufs: null,
      gains: unknown.map((entry) => ({
        id: entry.id,
        gainDb: entry.currentGainDb,
        residualLufs: 0,
        matched: false,
      })),
      totalBoostDb: 0,
    };
  }
  // Candidate references: every known body value (attenuation to the
  // quiet end and everything between are covered by these extremes).
  let best: ({ referenceLufs: number } & ReturnType<typeof solveFor>) | null = null;
  for (const candidate of known) {
    const solved = solveFor(candidate.bodyShortTermLufs);
    if (
      best == null ||
      solved.infeasible < best.infeasible ||
      (solved.infeasible === best.infeasible &&
        (solved.totalBoostDb < best.totalBoostDb ||
          (solved.totalBoostDb === best.totalBoostDb &&
            solved.totalAbsResidual < best.totalAbsResidual)))
    ) {
      best = { referenceLufs: candidate.bodyShortTermLufs, ...solved };
    }
  }
  const chosen = best!;
  return {
    referenceLufs: chosen.referenceLufs,
    gains: chosen.gains,
    totalBoostDb: chosen.totalBoostDb,
  };
}
