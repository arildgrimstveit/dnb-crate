export const APP_NAME = "dnb-crate-mcp";
export const APP_VERSION = "0.5.0";
export const RENDERER_VERSION = "6.14.2";
/** DSP identity mixed into the preview cache; bump when the audio graph changes. */
export const AUDIO_ENGINE_ID = "float-r3-lr4-join-v4";
/** Stored label for the only join engine: continuity windows, supported sequential, timing v2. */
export const DJ_HANDOFF_POLICY = "dj-continuity-v1" as const;
export const DEFAULT_RENDER_OUTPUT_FORMAT = "flac" as const;
export const DEFAULT_RENDER_OUTPUT_EXTENSION = ".flac";
export const DSP_ANALYZER_NAME = "dnb-crate-dsp";
export const DSP_ANALYZER_VERSION = "3.10.0";
export const ANALYSIS_ENGINE_IDS = ["dnb-crate-dsp"] as const;
export const DEFAULT_ANALYSIS_ENGINE = "dnb-crate-dsp" as const;
export const ANALYSIS_SAMPLE_RATE_HZ = 22_050;

export const DEFAULT_SUPPORTED_EXTENSIONS = [
  ".wav",
  ".flac",
  ".mp3",
  ".m4a",
  ".ogg",
  ".oga",
  ".opus",
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
  joinMood: 7,
  genrePrior: 4,
  feedback: 6,
} as const;

export const MIN_KEY_CONFIDENCE = 0.5;
export const PLANNER_POOL_MIN_TRACKS = 12;
export const PLANNER_POOL_RELAX_FACTOR = 3;
/** Selection-loop tuning. Documented in docs/scoring.md; changing any of these
 * changes plan output for existing briefs (they are part of determinism). */
export const PLANNER_SHORTLIST_SIZE = 12;
export const PLANNER_LOOKAHEAD_CONTINUATIONS = 8;
export const PLANNER_LOOKAHEAD_WEIGHT = 0.35;
export const PLANNER_MIN_POOL_ESTIMATE = 16;
export const PLANNER_OPENER_ATTEMPTS = 3;
export const VARIETY_REPEATED_TRACK_COST = 8;
export const VARIETY_REPEATED_PAIR_COST = 4;
/** Groove-compatibility scoring weight: how strongly the planner avoids
 * pairing tracks whose drum patterns fight. Calibrated on the 544-track
 * library: catches the "galloping" joins (Out of Time→Deep Space scores 0.486)
 * but not spectral-clutter noise (Freefall→Go scores 0.725 despite being
 * noisy — that's a mid/high crossover issue, not a rhythmic conflict).
 * Conservative weight until Phase 2 (hat-band dispersion) adds the missing
 * spectral signal. */
export const PLANNER_JOIN_GROOVE_WEIGHT = 3;
/** Syncopation-gap tolerance for groove scoring: gaps below this are
 * normal variation between compatible DnB grooves and score no penalty.
 * Calibrated on X-Ray (Metrik Remix) vs Somewhere (Grafix): 0.84 vs 0.44
 * measured syncopation — the pair gallops under every grid-aligned blend
 * because the syncopated backbone fills the straight pattern's gaps. */
export const PLANNER_GROOVE_SYNCOPATION_TOLERANCE = 0.12;
/** Linear penalty slope applied to the syncopation gap above the
 * tolerance, subtracted from the groove-compatibility score. */
export const PLANNER_GROOVE_SYNCOPATION_PENALTY_SLOPE = 3;
/** Bars per side of the overlap-local syncopation window used by the
 * structural-conflict gate (outgoing's last K bars before mix-out vs the
 * incoming's first K bars after mix-in). */
export const PLANNER_GROOVE_LOCAL_WINDOW_BARS = 16;
/** Overlap-local syncopation gap above which two grooves are structurally
 * incompatible: any grid-aligned template superimposes the two backbone
 * patterns and gallops. Calibrated October 2026 on the four labeled pairs
 * (K=16): X-Ray→Somewhere 0.706 (gallops under every template) vs
 * LAMG→Barren 0.447 / Sanctuary→LAMG 0.174 / Deep Space→LAMG 0.176 (all
 * user-praised) — the threshold sits in the empty band between 0.447 and
 * 0.706. Whole-track gaps CANNOT separate these pairs (0.365 praised vs
 * 0.400 bad), so the gate fires only on overlap-local measurement; when
 * either side's window is drum-sparse or unmeasured the gate stays silent
 * (no gate beats a wrong gate). */
export const PLANNER_GROOVE_STRUCTURAL_CONFLICT_GAP = 0.58;
/** Sparse-overlap penalty weight: how strongly the planner avoids joins where
 * both tracks' overlap regions lack rhythmic content (the blend feels like
 * it dips, gets quiet, or loses momentum). Calibrated on the Phase 4 test
 * mix: all six user-identified problem joins had sparse overlap regions. */
export const PLANNER_SPARSE_OVERLAP_WEIGHT = 6;

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
/** Adjacent-track level step that fails a full render check. 5 LU (widened
 * from 3 in October 2026): DnB library loudness spans ~9 LU and the renderer
 * gain clamp is asymmetric (+3/−6), so a 3 LU threshold was unachievable for
 * many valid energy-arc transitions once the energy descriptor spread opened
 * up. The planner's joinLevel scoring still penalizes gaps at 1/3 falloff. */
export const RENDER_CHECK_LEVEL_STEP_FAIL_LU = 5;
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
