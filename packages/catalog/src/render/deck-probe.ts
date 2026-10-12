import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { outputToSourceMs, type RenderManifestV1, type Track } from "@dnb-crate/domain";
import { sha256File, type FfmpegBinaries, type ProcessRunner } from "@dnb-crate/audio-renderer";

import { lowpass, onsetTimesMs, verifyDeckAlignment } from "./audio-diagnostics.ts";
import type { RenderCheckJoin } from "./coordinator.ts";

/**
 * Independent source-deck alignment probing (batch 7, F2 step 2; extracted
 * from the render coordinator behind the same tests). For each aligned join,
 * decode each deck's OWN placed source window from the catalog source files,
 * beat-lock the measured kick-band onset trains to the projected grids, and
 * compare them in output time. Each train is deck-attributed by construction,
 * so inter-deck phase errors — including whole-beat kick/snare offsets — are
 * visible where a mixed-waveform scan cannot attribute anything. "fast"
 * probes a 10 s window at the overlap midpoint (2 decodes per aligned join);
 * "full" covers the whole overlap and also reports start/end-half drift.
 *
 * Findings stay ADVISORY: they are reported on the join rows
 * (audioStatus/audioFindings) and deliberately NOT in the top-level warnings
 * list — that channel gates first-mix workflows, and uncalibrated deck
 * verdicts must not fail them, nor vary with the local ffmpeg build. A
 * measured result never clears the geometric residual.
 *
 * Scope (R6): this measures the catalog SOURCE FILES behind each deck — not
 * the rendered Rubber Band output, join-only rate regions, gain/filter
 * automation, or the final blend.
 */
export async function runSourceDeckProbes(input: {
  joins: RenderCheckJoin[];
  manifest: RenderManifestV1;
  outputPath: string;
  audioMode: "off" | "fast" | "full";
  runner: ProcessRunner;
  binaries: FfmpegBinaries;
  trackById: (trackId: string) => Track | undefined;
  /** S9: the render's frozen request — the probed bytes are verified
   * against the frozen content hash BEFORE measuring, so the probe never
   * reports on audio the render did not use. */
  frozenEvidence?: Record<string, unknown> | null;
}): Promise<{ probed: Set<number>; attempted: Set<number>; measured: Set<number> }> {
  const deckProbed = new Set<number>();
  const attempted = new Set<number>();
  const measured = new Set<number>();
  const frozenHashFor = (trackId: string): string | null | undefined => {
    const row = input.frozenEvidence?.[trackId] as
      { sourceContentSha256?: string | null } | undefined;
    return row?.sourceContentSha256;
  };
  const verifySourceIdentity = async (
    track: Track,
  ): Promise<"verified" | "mismatch" | "no-frozen-hash" | "unreadable"> => {
    const frozenHash = frozenHashFor(track.id);
    if (typeof frozenHash !== "string" || frozenHash === "") {
      return "no-frozen-hash";
    }
    try {
      const current = await sha256File(path.resolve(track.filePath));
      return current === frozenHash ? "verified" : "mismatch";
    } catch {
      return "unreadable";
    }
  };
  if (input.audioMode === "off") {
    reconcileUnmeasuredReasons(input.joins, deckProbed, input.audioMode);
    return { probed: deckProbed, attempted, measured };
  }
  for (const join of input.joins) {
    if (
      (join.template !== "phrase_mix" && join.template !== "bass_swap") ||
      join.overlapAtMs == null
    ) {
      continue;
    }
    const outgoingRow = input.manifest.tracks[join.order];
    const incomingRow = input.manifest.tracks[join.order + 1];
    if (!outgoingRow || !incomingRow) {
      continue;
    }
    const outTrack = input.trackById(outgoingRow.trackId);
    const inTrack = input.trackById(incomingRow.trackId);
    if (!outTrack || !inTrack) {
      join.audioUnmeasuredReason = "source-deck probe skipped: source track missing";
      continue;
    }
    const overlapOutMs = outgoingRow.overlapToNextMs ?? 0;
    if (overlapOutMs <= 0) {
      continue;
    }
    const outRate = outgoingRow.playbackRate > 0 ? outgoingRow.playbackRate : 1;
    const inRate = incomingRow.playbackRate > 0 ? incomingRow.playbackRate : 1;
    const outOverlapStartSource = outgoingRow.sourceEndMs - outputToSourceMs(overlapOutMs, outRate);
    const probeMs = input.audioMode === "fast" ? Math.min(10_000, overlapOutMs) : overlapOutMs;
    const probeOffsetMs =
      input.audioMode === "fast" ? Math.max(0, (overlapOutMs - probeMs) / 2) : 0;
    const outProbeSourceStart = outOverlapStartSource + outputToSourceMs(probeOffsetMs, outRate);
    const inProbeSourceStart = incomingRow.sourceStartMs + outputToSourceMs(probeOffsetMs, inRate);
    // S9: verify the probed bytes ARE the render's bytes before measuring.
    // A mismatch means the current file differs from what was rendered —
    // measuring it would attribute the wrong audio to the join.
    const outIdentity = await verifySourceIdentity(outTrack);
    const inIdentity = await verifySourceIdentity(inTrack);
    if (outIdentity === "mismatch" || inIdentity === "mismatch") {
      deckProbed.add(join.order);
      join.audioUnmeasuredReason =
        "source-deck probe skipped: source changed since this render (frozen content hash mismatch)";
      join.sourceDeckProbe = {
        mode: input.audioMode,
        outgoingInterval: {
          startMs: Math.round(outProbeSourceStart),
          durationMs: Math.round(probeMs * outRate),
        },
        incomingInterval: {
          startMs: Math.round(inProbeSourceStart),
          durationMs: Math.round(probeMs * inRate),
        },
        outgoingOnsetCount: 0,
        incomingOnsetCount: 0,
        outgoingLockedCount: 0,
        incomingLockedCount: 0,
        verification: {
          status: "unmeasured",
          deckOffsetMs: null,
          startHalfOffsetMs: null,
          endHalfOffsetMs: null,
          confidence: "none",
        },
        sourceIdentity: "mismatch",
      };
      continue;
    }
    attempted.add(join.order);
    const identity =
      outIdentity === "verified" && inIdentity === "verified"
        ? ("verified" as const)
        : outIdentity === "unreadable" || inIdentity === "unreadable"
          ? ("unreadable" as const)
          : ("no-frozen-hash" as const);
    const token = crypto.randomUUID().slice(0, 8);
    const outPcm = `${input.outputPath}.deck-out-${join.order}-${token}.pcm`;
    const inPcm = `${input.outputPath}.deck-in-${join.order}-${token}.pcm`;
    try {
      const decodeDeck = async (filePath: string, startSourceMs: number, rate: number) => {
        const temp = filePath === outTrack.filePath ? outPcm : inPcm;
        const run = await input.runner.run({
          executable: input.binaries.ffmpegPath,
          args: [
            "-nostdin",
            "-hide_banner",
            "-y",
            "-ss",
            (Math.max(0, startSourceMs) / 1000).toFixed(3),
            "-t",
            ((probeMs * rate) / 1000).toFixed(3),
            "-i",
            filePath,
            "-f",
            "f32le",
            "-ac",
            "1",
            "-ar",
            "22050",
            temp,
          ],
        });
        if (run.exitCode !== 0) {
          return null;
        }
        const buffer = await readFile(temp);
        const samples = new Float32Array(buffer.length / 4);
        for (let i = 0; i < samples.length; i += 1) {
          samples[i] = buffer.readFloatLE(i * 4);
        }
        if (samples.length < 22_050) {
          return [];
        }
        // Kick-band onsets (calibration 9 October 2026): full-band trains
        // timed vocals and pads — the verifier's first two candidate catches
        // were auditioned false positives on vocal-heavy material. A 180 Hz
        // low-pass keeps the kick (and the bass it lands on) as the timing
        // authority.
        const kick = lowpass(samples, 22_050, 180);
        // Source-time onsets in PROBE-LOCAL time (not shifted by
        // probeOffsetMs — the grids are shifted instead; R5 fix).
        return onsetTimesMs(kick, 22_050).map((time) => time / rate);
      };
      const outgoingOnsets = await decodeDeck(
        path.resolve(outTrack.filePath),
        outProbeSourceStart,
        outRate,
      );
      const incomingOnsets = await decodeDeck(
        path.resolve(inTrack.filePath),
        inProbeSourceStart,
        inRate,
      );
      if (outgoingOnsets == null || incomingOnsets == null) {
        join.audioUnmeasuredReason = "source-deck probe decode failed";
        continue;
      }
      // Beat-lock each train to its own deck's PROJECTED grid before
      // comparing: raw full-band onset clouds pair musical content (hats,
      // vocals, snares), not beats, and drown the phase measurement
      // (measured on the first calibration run). Locking to the own-deck
      // grid keeps the measurement about PLACEMENT between the decks; a
      // stored grid that disagrees with its own audio leaves too few locked
      // onsets and the join abstains instead of guessing.
      const evidenceJoin = input.manifest.joinEvidence?.find(
        (item) =>
          item.outgoingTrackId === outgoingRow.trackId &&
          item.incomingTrackId === incomingRow.trackId,
      );
      // R5 fix: use ONE coordinate system — probe-local time — for grids,
      // onsets, and drift halves. Previously onsets were shifted by
      // probeOffsetMs into overlap-relative time while grids were filtered
      // from the overlap start, so fast-mode probes on long overlaps
      // compared disjoint time ranges (32-bar midpoint probe: onsets at
      // 17–27 s into the overlap, grids at 0–10.5 s).
      const outGridMs = (evidenceJoin?.outgoingBeatsMs ?? [])
        .map((time) => (time - outOverlapStartSource) / outRate - probeOffsetMs)
        .filter((time) => time >= -500 && time < probeMs + 500);
      const inGridMs = (evidenceJoin?.incomingBeatsMs ?? [])
        .map((time) => (time - incomingRow.sourceStartMs) / inRate - probeOffsetMs)
        .filter((time) => time >= -500 && time < probeMs + 500);
      const nearGrid = (onsets: number[], grid: number[]) =>
        onsets.filter((time) => grid.some((beat) => Math.abs(beat - time) <= 100));
      const lockedOut = nearGrid(outgoingOnsets, outGridMs);
      const lockedIn = nearGrid(incomingOnsets, inGridMs);
      // True beat period from the frozen grid (the alignment period can be
      // a bar or a whole phrase, which would disable bar wrapping).
      const beatDeltas = outGridMs
        .slice(1)
        .map((time, i) => time - (outGridMs[i] ?? 0))
        .filter((delta) => delta > 100 && delta < 1000)
        .sort((a, b) => a - b);
      const beatPeriodMs =
        beatDeltas.length > 0 ? beatDeltas[Math.floor(beatDeltas.length / 2)]! : 345;
      const verification = verifyDeckAlignment({
        outgoingOnsetsMs: lockedOut,
        incomingOnsetsMs: lockedIn,
        overlapMs: probeMs,
        beatPeriodMs,
      });
      deckProbed.add(join.order);
      // T6 (12 October review): "measured" means an actual timing judgment
      // was available. An unmeasured verdict (sparse/ambiguous evidence) is
      // an ABSTENTION - attempted but not measured - so it stays out of the
      // measured set and remains visible as the attempted/measured gap.
      if (verification.status !== "unmeasured") {
        measured.add(join.order);
      }
      join.audioStatus = verification.status;
      join.audioUnmeasuredReason =
        verification.status === "unmeasured" ? (verification.reasons[0] ?? null) : null;
      // S9: expose the FULL measurement on the join row instead of the
      // reduced status/reason pair — intervals, decoded and locked onset
      // counts, offset/drift halves, and confidence — so coverage and
      // abstention are inspectable per join.
      join.sourceDeckProbe = {
        mode: input.audioMode,
        outgoingInterval: {
          startMs: Math.round(outProbeSourceStart),
          durationMs: Math.round(probeMs * outRate),
        },
        incomingInterval: {
          startMs: Math.round(inProbeSourceStart),
          durationMs: Math.round(probeMs * inRate),
        },
        outgoingOnsetCount: outgoingOnsets.length,
        incomingOnsetCount: incomingOnsets.length,
        outgoingLockedCount: lockedOut.length,
        incomingLockedCount: lockedIn.length,
        verification: {
          status: verification.status,
          deckOffsetMs: verification.deckOffsetMs,
          startHalfOffsetMs: verification.startHalfOffsetMs,
          endHalfOffsetMs: verification.endHalfOffsetMs,
          confidence: verification.confidence,
        },
        sourceIdentity: identity,
      };
      if (verification.status !== "pass") {
        join.audioFindings = [
          ...join.audioFindings,
          ...verification.reasons.map((reason) => `deck alignment: ${reason}`),
        ];
      }
    } catch (error) {
      deckProbed.add(join.order);
      join.audioUnmeasuredReason = `source-deck probe failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    } finally {
      await unlink(outPcm).catch(() => undefined);
      await unlink(inPcm).catch(() => undefined);
    }
  }
  reconcileUnmeasuredReasons(input.joins, deckProbed, input.audioMode);
  return { probed: deckProbed, attempted, measured };
}

/**
 * R6: every still-unmeasured join that the probe did not touch gets an
 * accurate reason for its actual state — off, not applicable, or no eligible
 * overlap. Joins the probe measured carry the verifier's own reasons; the
 * mixed-decode scan wrote its specific skip/decode reasons earlier and those
 * stay untouched. "off" wins over template applicability: when the mode is
 * disabled, that is why nothing ran.
 */
function reconcileUnmeasuredReasons(
  joins: RenderCheckJoin[],
  deckProbed: Set<number>,
  audioMode: "off" | "fast" | "full",
): void {
  for (const join of joins) {
    if (join.audioStatus !== "unmeasured" || deckProbed.has(join.order)) {
      continue;
    }
    if (join.audioUnmeasuredReason != null) {
      continue;
    }
    if (audioMode === "off") {
      join.audioUnmeasuredReason = "source-deck probe off (audioVerification=off)";
    } else if (join.template !== "phrase_mix" && join.template !== "bass_swap") {
      join.audioUnmeasuredReason = "source-deck probe not applicable: no aligned decks";
    } else {
      join.audioUnmeasuredReason = "source-deck probe skipped: no eligible overlap window";
    }
  }
}
