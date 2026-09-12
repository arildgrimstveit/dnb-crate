import { parseEbur128, type ProcessRunner } from "@dnb-crate/audio-renderer";
import {
  RENDER_DURATION_TOLERANCE_MS,
  camelotDistance as camelotWheelDistance,
  type FrozenJoinEvidence,
} from "@dnb-crate/domain";

export function paramNumber(
  parameters: Record<string, number | string | boolean> | undefined,
  key: string,
): number | null {
  const value = parameters?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function paramString(
  parameters: Record<string, number | string | boolean> | undefined,
  key: string,
): string | null {
  const value = parameters?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function firstDropMs(
  sections: Array<{ type: string; startMs: number }> | undefined,
): number | null {
  const drop = sections?.find((section) => section.type === "drop");
  return drop ? drop.startMs : null;
}

/**
 * Stored-grid consistency only. This correlates **frozen beat timestamps**,
 * not independently measured audio. A zero residual is not proof that the
 * render is beatmatched.
 *
 * A one-beat period-add (~345 ms at 174) is still reported so the Peak v3.3
 * failure mode stays visible. Phrase/bar wraps do not fall back to the raw
 * nudge — that offset is the applied correction, not leftover error.
 */
export function storedGridResidualMs(
  downbeatOffsetMs: number | null,
  outgoingBeats: number[],
  incomingBeats: number[],
  outgoingOverlapStartMs: number,
  incomingOverlapStartMs: number,
  outgoingRate: number,
  incomingRate: number,
  periodMs: number | null,
): number | null {
  const wrapMs = periodMs && periodMs > 0 ? periodMs : 345;
  const beatPeriodMs = wrapMs > 2000 ? null : wrapMs;
  const gridResidual = residualFromBeatGrids(
    outgoingBeats,
    incomingBeats,
    outgoingOverlapStartMs,
    incomingOverlapStartMs,
    outgoingRate,
    incomingRate,
    wrapMs,
  );
  if (
    beatPeriodMs != null &&
    downbeatOffsetMs != null &&
    Math.abs(downbeatOffsetMs) >= 20 &&
    Math.abs(Math.abs(downbeatOffsetMs) - beatPeriodMs) < 25
  ) {
    return downbeatOffsetMs;
  }
  return gridResidual;
}

/** @deprecated Use storedGridResidualMs — this is not an audio measurement. */
export const alignmentResidualMs = storedGridResidualMs;

export function beatsInWindow(
  beats: number[],
  startMs: number,
  endMs: number,
  padMs = 12_000,
): number[] {
  return beats.filter((time) => time >= startMs - padMs && time <= endMs + padMs);
}

export function evaluateDurationError(
  outputDurationMs: number,
  plannedDurationMs: number | null,
  kind: "preview" | "full",
): { errorMs: number | null; status: "pass" | "warning" | "fail" | "unmeasured" } {
  if (plannedDurationMs == null) {
    return { errorMs: null, status: "unmeasured" };
  }
  const errorMs = outputDurationMs - plannedDurationMs;
  if (Math.abs(errorMs) <= RENDER_DURATION_TOLERANCE_MS) {
    return { errorMs, status: "pass" };
  }
  const strictHour = kind === "full" && plannedDurationMs >= 5 * 60_000;
  return { errorMs, status: strictHour ? "fail" : "warning" };
}

/** Job-completion rule: a full render must match the plan within 1000 ms. */
export function fullRenderDurationFailure(
  outputDurationMs: number,
  plannedDurationMs: number,
): string | null {
  const delta = Math.abs(outputDurationMs - plannedDurationMs);
  if (delta <= RENDER_DURATION_TOLERANCE_MS) {
    return null;
  }
  return `Output duration ${outputDurationMs}ms differs from plan ${plannedDurationMs}ms by ${delta}ms (tolerance ${RENDER_DURATION_TOLERANCE_MS}ms).`;
}

export function freezeJoinEvidence(input: {
  outgoingTrackId: string;
  incomingTrackId: string;
  outgoingAnalysisVersion: string | null;
  incomingAnalysisVersion: string | null;
  outgoingBeatsMs: number[];
  incomingBeatsMs: number[];
  outgoingSourceStartMs: number;
  outgoingSourceEndMs: number;
  incomingSourceStartMs: number;
  incomingSourceEndMs: number;
  outgoingCamelotKey: string | null;
  incomingCamelotKey: string | null;
  outgoingAudioEndMs: number | null;
  outgoingTailEnergy: number | null;
  incomingHeadEnergy: number | null;
  incomingDropMs: number | null;
  recipeVersion: number | null;
  intent: FrozenJoinEvidence["intent"];
}): FrozenJoinEvidence {
  return {
    outgoingTrackId: input.outgoingTrackId,
    incomingTrackId: input.incomingTrackId,
    outgoingAnalysisVersion: input.outgoingAnalysisVersion,
    incomingAnalysisVersion: input.incomingAnalysisVersion,
    outgoingBeatsMs: beatsInWindow(
      input.outgoingBeatsMs,
      input.outgoingSourceStartMs,
      input.outgoingSourceEndMs,
    ),
    incomingBeatsMs: beatsInWindow(
      input.incomingBeatsMs,
      input.incomingSourceStartMs,
      input.incomingSourceEndMs,
    ),
    outgoingCamelotKey: input.outgoingCamelotKey,
    incomingCamelotKey: input.incomingCamelotKey,
    outgoingAudioEndMs: input.outgoingAudioEndMs,
    outgoingTailEnergy: input.outgoingTailEnergy,
    incomingHeadEnergy: input.incomingHeadEnergy,
    incomingDropMs: input.incomingDropMs,
    recipeVersion: input.recipeVersion,
    intent: input.intent,
  };
}

export function storedGridFromEvidence(
  evidence: FrozenJoinEvidence | undefined,
  outgoingOverlapStartMs: number,
  incomingOverlapStartMs: number,
  outgoingRate: number,
  incomingRate: number,
  downbeatOffsetMs: number | null,
  periodMs: number | null,
): {
  residualMs: number | null;
  source: "frozen-manifest" | "missing";
  kind: "stored-grid-consistency";
} {
  if (!evidence || evidence.outgoingBeatsMs.length < 4 || evidence.incomingBeatsMs.length < 4) {
    return { residualMs: null, source: "missing", kind: "stored-grid-consistency" };
  }
  return {
    residualMs: storedGridResidualMs(
      downbeatOffsetMs,
      evidence.outgoingBeatsMs,
      evidence.incomingBeatsMs,
      outgoingOverlapStartMs,
      incomingOverlapStartMs,
      outgoingRate,
      incomingRate,
      periodMs,
    ),
    source: "frozen-manifest",
    kind: "stored-grid-consistency",
  };
}

function residualFromBeatGrids(
  outgoingBeats: number[],
  incomingBeats: number[],
  outgoingOverlapStartMs: number,
  incomingOverlapStartMs: number,
  outgoingRate: number,
  incomingRate: number,
  periodMs: number,
): number | null {
  if (outgoingBeats.length < 4 || incomingBeats.length < 4) {
    return null;
  }
  const hop = 20;
  const windowMs = Math.min(8000, Math.max(periodMs * 2, 4000));
  const outEnv = onsetEnvelope(outgoingBeats, outgoingOverlapStartMs, outgoingRate, windowMs, hop);
  const inEnv = onsetEnvelope(incomingBeats, incomingOverlapStartMs, incomingRate, windowMs, hop);
  if (outEnv.every((value) => value === 0) || inEnv.every((value) => value === 0)) {
    return null;
  }
  const halfBeatMs = 160;
  const maxLag = Math.max(1, Math.round(Math.min(periodMs / 2, halfBeatMs) / hop));
  let bestLag = 0;
  let best = Number.NEGATIVE_INFINITY;
  let zero = 0;
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i < outEnv.length; i += 1) {
      const j = i + lag;
      if (j < 0 || j >= inEnv.length) {
        continue;
      }
      sum += outEnv[i]! * inEnv[j]!;
    }
    if (lag === 0) {
      zero = sum;
    }
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  if (bestLag === 0 || best < zero * 1.25) {
    return 0;
  }
  return Math.round(bestLag * hop);
}

function onsetEnvelope(
  beats: number[],
  overlapStartMs: number,
  rate: number,
  windowMs: number,
  hopMs: number,
): number[] {
  const bins = Math.max(1, Math.round(windowMs / hopMs));
  const env = new Array<number>(bins).fill(0);
  const safeRate = rate > 0 ? rate : 1;
  for (const beat of beats) {
    const outputMs = (beat - overlapStartMs) / safeRate;
    if (outputMs < 0 || outputMs >= windowMs) {
      continue;
    }
    const index = Math.min(bins - 1, Math.floor(outputMs / hopMs));
    env[index] = (env[index] ?? 0) + 1;
  }
  return env;
}

export function plannedLevelStepLu(
  outgoingLufs: number | null,
  incomingLufs: number | null,
  outgoingGainDb: number | null,
  incomingGainDb: number | null,
): number | null {
  if (outgoingLufs == null || incomingLufs == null) {
    return null;
  }
  return Number(
    (incomingLufs + (incomingGainDb ?? 0) - (outgoingLufs + (outgoingGainDb ?? 0))).toFixed(2),
  );
}

export function joinCamelotDistance(
  outgoingKey: string | null,
  incomingKey: string | null,
): number | null {
  return camelotWheelDistance(outgoingKey, incomingKey);
}

export async function measureLevelStepLu(
  runner: ProcessRunner,
  ffmpegPath: string,
  mixPath: string,
  overlapAtMs: number,
  mixDurationMs: number,
  overlapMs = 0,
): Promise<number | null> {
  const windowMs = 10_000;
  const beforeStart = Math.max(0, overlapAtMs - windowMs);
  const afterCandidate = overlapAtMs + Math.max(0, overlapMs);
  const afterStart = Math.min(Math.max(0, mixDurationMs - windowMs), afterCandidate);
  const before = await measureWindowLufs(runner, ffmpegPath, mixPath, beforeStart, windowMs);
  const after = await measureWindowLufs(runner, ffmpegPath, mixPath, afterStart, windowMs);
  if (before == null || after == null) {
    return null;
  }
  return Number((after - before).toFixed(2));
}

async function measureWindowLufs(
  runner: ProcessRunner,
  ffmpegPath: string,
  filePath: string,
  startMs: number,
  durationMs: number,
): Promise<number | null> {
  try {
    const result = await runner.run({
      executable: ffmpegPath,
      args: [
        "-nostdin",
        "-hide_banner",
        "-ss",
        (startMs / 1000).toFixed(3),
        "-t",
        (durationMs / 1000).toFixed(3),
        "-i",
        filePath,
        "-af",
        "ebur128=peak=true",
        "-f",
        "null",
        "-",
      ],
    });
    return parseEbur128(`${result.stderr}\n${result.stdout}`).integratedLufs;
  } catch {
    return null;
  }
}
