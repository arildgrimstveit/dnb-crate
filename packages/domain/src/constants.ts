export const APP_NAME = "dnb-crate-mcp";
export const APP_VERSION = "0.5.0";
export const RENDERER_VERSION = "6.13.7";
/** Stored label for the only join engine: continuity windows, supported sequential, timing v2. */
export const DJ_HANDOFF_POLICY = "dj-continuity-v1" as const;
export const DEFAULT_RENDER_OUTPUT_FORMAT = "flac" as const;
export const DEFAULT_RENDER_OUTPUT_EXTENSION = ".flac";
/** @deprecated Prefer DSP_ANALYZER_NAME; kept for migrated envelope rows. */
export const ANALYZER_NAME = "dnb-crate-envelope";
export const ANALYZER_VERSION = "1.0.0";
export const DSP_ANALYZER_NAME = "dnb-crate-dsp";
export const DSP_ANALYZER_VERSION = "3.2.0";
export const ANALYSIS_ENGINE_IDS = ["dnb-crate-dsp"] as const;
export const DEFAULT_ANALYSIS_ENGINE = "dnb-crate-dsp" as const;
export const ANALYSIS_SAMPLE_RATE_HZ = 22_050;

export const DEFAULT_SUPPORTED_EXTENSIONS = [
  ".wav",
  ".flac",
  ".mp3",
  ".m4a",
  ".aiff",
  ".aif",
] as const;

export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_LIMIT_DEFAULT = 20;
export const RESOURCE_LIST_LIMIT = 100;
export const SCAN_WARNING_LIMIT = 50;
export const FINGERPRINT_WINDOW_BYTES = 64 * 1024;

export const DEFAULT_TARGET_DURATION_MS = 60 * 60 * 1000;
export const MIN_TARGET_DURATION_MS = 60_000;
export const MAX_TARGET_DURATION_MS = 8 * 60 * 60 * 1000;
export const DEFAULT_TRANSITION_OVERLAP_MS = 30_000;
export const SHORT_CROSSFADE_MS = 8_000;
export const MIN_PLAYABLE_DURATION_MS = 90_000;
export const DURATION_TOLERANCE_MS = 90_000;
export const DURATION_QUALITY_WINDOW_MS = 5 * 60 * 1000;

export function resolveTargetDurationMs(input: {
  targetDurationMs?: number;
  targetDurationMinutes?: number;
}): number {
  if (input.targetDurationMinutes != null) {
    return input.targetDurationMinutes * 60_000;
  }
  return input.targetDurationMs ?? DEFAULT_TARGET_DURATION_MS;
}
export const DEFAULT_ARTIST_REPEAT_SPACING = 1;
export const MAX_BPM_JUMP = 6;
export const MAX_CAMELOT_DISTANCE_OK = 2;
export const MAX_ENERGY_DEVIATION = 2;
export const SET_PLAN_LIST_LIMIT_MAX = 50;
export const COMPATIBLE_TRACKS_LIMIT_MAX = 50;
export const PLANNER_CANDIDATE_CAP = 500;

export const DEFAULT_SCORE_WEIGHTS = {
  mood: 8,
  subgenre: 8,
  energy: 12,
  bpm: 12,
  harmonic: 10,
  rating: 6,
  preferredArtist: 8,
  exploration: 4,
  repeatedArtist: 20,
  recentlyUsed: 8,
  missingMetadata: 10,
  structure: 6,
  joinLevel: 6,
  joinStructure: 8,
  joinAligned: 10,
  joinHarmonic: 8,
  genrePrior: 4,
  feedback: 6,
} as const;

export const MIN_KEY_CONFIDENCE = 0.5;
export const PLANNER_POOL_MIN_TRACKS = 12;
export const PLANNER_POOL_RELAX_FACTOR = 3;

export const DEFAULT_LOUDNESS_TARGET_LUFS = -14;
export const DEFAULT_TRUE_PEAK_CEILING_DB = -1;
export const DEFAULT_RENDER_SAMPLE_RATE_HZ = 48_000;
export const DEFAULT_RENDER_CHANNELS = 2;
export const DEFAULT_RENDER_WORKER_LIMIT = 1;
export const DEFAULT_PREVIEW_WINDOW_MS = 45_000;
export const MIN_PREVIEW_WINDOW_MS = 30_000;
export const MAX_PREVIEW_WINDOW_MS = 60_000;
export const DEFAULT_RENDER_EDGE_FADE_MS = 0;
export const MAX_RENDER_EDGE_FADE_MS = 5_000;
export const RENDER_DURATION_TOLERANCE_MS = 1_000;
export const RENDER_CHECK_RESIDUAL_FAIL_MS = 40;
export const RENDER_CHECK_AUDIO_CONFIDENT_MS = 20;
export const RENDER_CHECK_AUDIO_REVIEW_MS = 40;
export const RENDER_CHECK_LEVEL_STEP_FAIL_LU = 3;
export const LEVEL_MATCH_GAIN_MIN_DB = -6;
export const LEVEL_MATCH_GAIN_MAX_DB = 3;
export const RENDER_JOB_LIST_LIMIT_MAX = 50;
export const FFMPEG_STDERR_LIMIT_BYTES = 32 * 1024;
export const FFMPEG_ARGV_SOFT_LIMIT = 7_000;
export const CROSSFADE_CURVE = "hsin";

export const DNB_BPM_MIN = 160;
export const DNB_BPM_MAX = 190;
export const MAX_TEMPO_DEVIATION = 0.03;
/** Skip atempo only for floating-point identity when no duration is available. */
export const ATEMPO_SKIP_THRESHOLD = 1e-12;
/** Accumulated |rate−1|·duration below this may skip atempo (10 ms landmark budget). */
export const ATEMPO_DRIFT_BUDGET_MS = 10;
export const MIN_ANALYSIS_CONFIDENCE = 0.6;
export const MIN_BPM_HINT_CONFIDENCE = 0.3;
export const PUBLISHED_BPM_INTEGER_TOLERANCE = 1.0;
export const PUBLISHED_BPM_FRACTION_TOLERANCE = 0.5;
export const DEFAULT_PHRASE_BARS = 16;
export type PhraseBarCount = 8 | 16 | 32;

export function normalizePhraseBars(value: number | null | undefined): PhraseBarCount {
  if (value === 32 || value === 8) {
    return value;
  }
  return 16;
}
export const PHRASE_BAR_OPTIONS = [8, 16, 32] as const;
export const DEFAULT_BASS_CROSSOVER_HZ = 180;
export const MIN_BASS_CROSSOVER_HZ = 120;
export const MAX_BASS_CROSSOVER_HZ = 250;
export const DEFAULT_BASS_SWAP_RAMP_MS = 40;
export const MIN_BASS_SWAP_RAMP_MS = 20;
export const MAX_BASS_SWAP_RAMP_MS = 80;
export const DEFAULT_BASS_LOW_ATTENUATION_DB = -24;
export const DEFAULT_MID_DIP_DB = -6;
export const BAND_HIGH_CROSSOVER_HZ = 2500;
export const PHRASE_MIX_HIGHPASS_HZ = 250;
export const ANALYSIS_JOB_LIST_LIMIT_MAX = 50;
