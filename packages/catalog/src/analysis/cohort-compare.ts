import {
  bpmDisagrees,
  downbeatPhaseAgreement,
  harmonicRelation,
  periodStats,
  type KeySource,
} from "@dnb-crate/domain";

export function titleMatchesCohort(trackTitle: string, wanted: string): boolean {
  if (trackTitle === wanted) {
    return true;
  }
  const escaped = wanted.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s\\-—/])${escaped}(?:$|[\\s\\-—(])`, "i").test(trackTitle);
}

export type CohortEngineRow = {
  analyzerName: string;
  bpm: number | null;
  gridRejected: boolean;
  downbeatTimesMs: number[];
  beatTimesMs: number[];
  musicalKey: string | null;
  keyConfidence: number | null;
  engineRuntimeMs: number | null;
};

export type CohortTrackInput = {
  trackId: string;
  title: string;
  publishedBpm: number | null;
  canonicalKey: string | null;
  canonicalKeySource: KeySource | null;
  engines: CohortEngineRow[];
};

export type CohortTrackReport = {
  trackId: string;
  title: string;
  split: "calibration" | "held-out";
  publishedBpm: number | null;
  dspBpm: number | null;
  sidecarBpm: number | null;
  bpmDisagree: boolean;
  dspAccepted: boolean | null;
  sidecarAccepted: boolean | null;
  dspPeriodCv: number | null;
  sidecarPeriodCv: number | null;
  dspDriftMs: number | null;
  sidecarDriftMs: number | null;
  downbeatAgreement: number | null;
  phaseDisagree: boolean;
  dspKey: string | null;
  sidecarKey: string | null;
  keyRelation: string;
  keyAccuracy: "unmeasured" | "exact" | "relative" | "other" | "unknown";
  dspRuntimeMs: number | null;
  sidecarRuntimeMs: number | null;
};

export type CohortCompareReport = {
  generatedAt: string;
  install: {
    beatThis: boolean;
    keyEngine: string | null;
    reliable: boolean;
  };
  promoted: false;
  tracks: CohortTrackReport[];
  counts: {
    bpmDisagree: number;
    phaseDisagree: number;
    highCv: number;
    sidecarInRangePublished: number;
    dspInRangePublished: number;
    sidecarAccepted: number;
    sidecarRejected: number;
    dspAccepted: number;
    dspRejected: number;
    keyExact: number;
    keyRelative: number;
    keyOther: number;
    keyUnknown: number;
    keyUnmeasured: number;
    sidecarRuntimeMs: number;
    dspRuntimeMs: number;
  };
  legacyBpmPromotionRule: {
    description: string;
    sidecarGains: number;
    wouldHaveTriggered: boolean;
    cannotAlonePromote: true;
  };
};

function engine(row: CohortTrackInput, name: string): CohortEngineRow | undefined {
  return row.engines.find((item) => item.analyzerName === name);
}

function inRange(bpm: number | null, published: number | null): boolean {
  if (bpm == null || published == null) {
    return false;
  }
  return Math.abs(bpm - published) <= 1;
}

export function buildCohortCompareReport(
  tracks: CohortTrackInput[],
  install: { beatThis: boolean; keyEngine: string | null; reliable?: boolean },
): CohortCompareReport {
  const sorted = [...tracks].sort((a, b) => a.title.localeCompare(b.title) || a.trackId.localeCompare(b.trackId));
  const reports: CohortTrackReport[] = sorted.map((track, index) => {
    const dsp = engine(track, "dnb-crate-dsp");
    const sidecar = engine(track, "beat-this") ?? engine(track, "allin1");
    const keyRow = engine(track, "essentia-key") ?? engine(track, "keyfinder");
    const dspStats = dsp ? periodStats(dsp.downbeatTimesMs) : null;
    const sidecarStats = sidecar ? periodStats(sidecar.downbeatTimesMs) : null;
    const refKey =
      track.canonicalKeySource === "manual" || track.canonicalKeySource === "published"
        ? track.canonicalKey
        : null;
    const estimatedKey = keyRow?.musicalKey ?? dsp?.musicalKey ?? null;
    const keyAccuracy = !refKey
      ? "unmeasured"
      : !estimatedKey
        ? "unknown"
        : harmonicRelation(estimatedKey, refKey) === "same"
          ? "exact"
          : harmonicRelation(estimatedKey, refKey) === "relative"
            ? "relative"
            : harmonicRelation(estimatedKey, refKey) === "unknown"
              ? "unknown"
              : "other";
    return {
      trackId: track.trackId,
      title: track.title,
      split: index < Math.ceil(sorted.length / 2) ? "calibration" : "held-out",
      publishedBpm: track.publishedBpm,
      dspBpm: dsp?.bpm ?? null,
      sidecarBpm: sidecar?.bpm ?? null,
      bpmDisagree: bpmDisagrees(dsp?.bpm ?? null, sidecar?.bpm ?? null),
      dspAccepted: dsp ? !dsp.gridRejected : null,
      sidecarAccepted: sidecar ? !sidecar.gridRejected : null,
      dspPeriodCv: dspStats?.cv ?? null,
      sidecarPeriodCv: sidecarStats?.cv ?? null,
      dspDriftMs: dspStats?.startToEndDriftMs ?? null,
      sidecarDriftMs: sidecarStats?.startToEndDriftMs ?? null,
      downbeatAgreement:
        dsp && sidecar ? downbeatPhaseAgreement(dsp.downbeatTimesMs, sidecar.downbeatTimesMs) : null,
      phaseDisagree:
        dsp && sidecar
          ? downbeatPhaseAgreement(dsp.downbeatTimesMs, sidecar.downbeatTimesMs) < 0.7
          : false,
      dspKey: dsp?.musicalKey ?? null,
      sidecarKey: keyRow?.musicalKey ?? sidecar?.musicalKey ?? null,
      keyRelation: harmonicRelation(dsp?.musicalKey ?? null, keyRow?.musicalKey ?? null),
      keyAccuracy,
      dspRuntimeMs: dsp?.engineRuntimeMs ?? null,
      sidecarRuntimeMs: sidecar?.engineRuntimeMs ?? null,
    };
  });
  const sidecarInRangePublished = reports.filter((row) => inRange(row.sidecarBpm, row.publishedBpm)).length;
  const dspInRangePublished = reports.filter((row) => inRange(row.dspBpm, row.publishedBpm)).length;
  const sidecarGains = sidecarInRangePublished - dspInRangePublished;
  return {
    generatedAt: new Date().toISOString(),
    install: {
      beatThis: install.beatThis,
      keyEngine: install.keyEngine,
      reliable: install.reliable ?? install.beatThis,
    },
    promoted: false,
    tracks: reports,
    counts: {
      bpmDisagree: reports.filter((row) => row.bpmDisagree).length,
      phaseDisagree: reports.filter((row) => row.phaseDisagree).length,
      highCv: reports.filter((row) => (row.dspPeriodCv ?? 0) > 0.08 || (row.sidecarPeriodCv ?? 0) > 0.08)
        .length,
      sidecarInRangePublished,
      dspInRangePublished,
      sidecarAccepted: reports.filter((row) => row.sidecarAccepted === true).length,
      sidecarRejected: reports.filter((row) => row.sidecarAccepted === false).length,
      dspAccepted: reports.filter((row) => row.dspAccepted === true).length,
      dspRejected: reports.filter((row) => row.dspAccepted === false).length,
      keyExact: reports.filter((row) => row.keyAccuracy === "exact").length,
      keyRelative: reports.filter((row) => row.keyAccuracy === "relative").length,
      keyOther: reports.filter((row) => row.keyAccuracy === "other").length,
      keyUnknown: reports.filter((row) => row.keyAccuracy === "unknown").length,
      keyUnmeasured: reports.filter((row) => row.keyAccuracy === "unmeasured").length,
      sidecarRuntimeMs: reports.reduce((sum, row) => sum + (row.sidecarRuntimeMs ?? 0), 0),
      dspRuntimeMs: reports.reduce((sum, row) => sum + (row.dspRuntimeMs ?? 0), 0),
    },
    legacyBpmPromotionRule: {
      description:
        "Older rule: promote a rhythm sidecar if it gains ≥2 more in-range published BPMs than DSP. Recorded only; it cannot alone promote an engine.",
      sidecarGains,
      wouldHaveTriggered: sidecarGains >= 2,
      cannotAlonePromote: true,
    },
  };
}
