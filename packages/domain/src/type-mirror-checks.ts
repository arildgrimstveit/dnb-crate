/**
 * Compile-time drift guard between hand-written mirror types and their zod
 * schemas (lean plan R1). Every pair asserts assignability in BOTH
 * directions, so an optional field added to one side but not the other — or a
 * widened union on either side — fails `pnpm typecheck`.
 *
 * This file is intentionally not exported from the barrel: it exists purely to
 * be typechecked. The `null as unknown as X` casts never execute because the
 * consts are never imported.
 */
import type { z } from "zod/v4";

import type {
  createSetPlanInputSchema,
  planQualityReportSchema,
  scoreBreakdownSchema,
  setPlanV1Schema,
} from "./contracts/planning.ts";
import type { sonicDescriptorsSchema } from "./analysis-contracts.ts";
import type { rateTransitionInputSchema, transitionFeedbackSchema } from "./feedback-contracts.ts";
import type { BarEnergySeries, SonicDescriptors } from "./analysis.ts";
import type {
  CreateSetPlanInput,
  PlanQualityReport,
  ScoreComponents,
  SetPlanV1,
} from "./planning.ts";
import type { RateTransitionInput, TransitionFeedback } from "./feedback.ts";

type SchemaOf<T> = z.output<T>;

export const _createSetPlanInput_typeMatchesSchema: CreateSetPlanInput =
  null as unknown as SchemaOf<typeof createSetPlanInputSchema>;
export const _createSetPlanInput_schemaMatchesType: SchemaOf<typeof createSetPlanInputSchema> =
  null as unknown as CreateSetPlanInput;

export const _setPlanV1_typeMatchesSchema: SetPlanV1 = null as unknown as SchemaOf<
  typeof setPlanV1Schema
>;
export const _setPlanV1_schemaMatchesType: SchemaOf<typeof setPlanV1Schema> =
  null as unknown as SetPlanV1;

export const _planQualityReport_typeMatchesSchema: PlanQualityReport = null as unknown as SchemaOf<
  typeof planQualityReportSchema
>;
export const _planQualityReport_schemaMatchesType: SchemaOf<typeof planQualityReportSchema> =
  null as unknown as PlanQualityReport;

export const _scoreComponents_typeMatchesSchema: ScoreComponents = null as unknown as SchemaOf<
  typeof scoreBreakdownSchema
>["components"];
export const _scoreComponents_schemaMatchesType: SchemaOf<
  typeof scoreBreakdownSchema
>["components"] = null as unknown as ScoreComponents;

export const _rateTransitionInput_typeMatchesSchema: RateTransitionInput =
  null as unknown as SchemaOf<typeof rateTransitionInputSchema>;
export const _rateTransitionInput_schemaMatchesType: SchemaOf<typeof rateTransitionInputSchema> =
  null as unknown as RateTransitionInput;

export const _transitionFeedback_typeMatchesSchema: TransitionFeedback =
  null as unknown as SchemaOf<typeof transitionFeedbackSchema>;
export const _transitionFeedback_schemaMatchesType: SchemaOf<typeof transitionFeedbackSchema> =
  null as unknown as TransitionFeedback;

// ---------------------------------------------------------------------------
// SonicDescriptors mirror (F5, repository review 2026-10-08).
//
// Bidirectional assignability alone cannot catch an OPTIONAL field added to
// the type but not the schema (both directions stay assignable), which is
// exactly how grooveSyncopation, backbeatConcentration, bars.syncopation and
// the DSP 3.12 phase fields were silently stripped by schema parses. The
// key lists below close that hole: every key of the type must appear in the
// list (compile-time, via AssertNever), and the list must equal the zod
// shape's keys (runtime, in test/descriptor-contracts.test.ts). Adding an
// optional field to SonicDescriptors without the schema therefore fails
// typecheck OR the contract test — never silently.
export const _sonicDescriptors_typeMatchesSchema: SonicDescriptors = null as unknown as SchemaOf<
  typeof sonicDescriptorsSchema
>;
export const _sonicDescriptors_schemaMatchesType: SchemaOf<typeof sonicDescriptorsSchema> =
  null as unknown as SonicDescriptors;

/** Every property name of SonicDescriptors, in one maintained list. */
export const SONIC_DESCRIPTOR_KEYS = [
  "integratedLufs",
  "shortTermRmsDbfsMean",
  "shortTermRmsDbfsMax",
  "truePeakDb",
  "subBassRatio",
  "brightness",
  "onsetDensity",
  "dynamicRange",
  "dropIntensity",
  "suggestedEnergy",
  "energy",
  "danceability",
  "acousticness",
  "melodicness",
  "valence",
  "waveformSummary",
  "lowBandEnergy",
  "midBandEnergy",
  "highBandEnergy",
  "chromaVector",
  "tempoEvidence",
  "audioStartMs",
  "audioEndMs",
  "bars",
  "keyCandidates",
  "grooveSyncopation",
  "backbeatConcentration",
  "gridPhaseMaxErrorMs",
  "gridPhaseSuspect",
  "beatPhaseHistogram",
] as const;

/** Every property name of BarEnergySeries. */
export const BAR_SERIES_KEYS = [
  "rms",
  "sub",
  "midFlux",
  "onsetDensity",
  "syncopation",
  "beatKick",
  "beatSnare",
  "beatOnset",
] as const;

type AssertEmpty<T> = [T] extends [never] ? true : never;

/** Fails typecheck when SonicDescriptors grows a key the list misses. */
export const _descriptorKeyListExact: AssertEmpty<
  Exclude<keyof SonicDescriptors, (typeof SONIC_DESCRIPTOR_KEYS)[number]>
> = true;
/** Fails typecheck when the list names a key SonicDescriptors dropped. */
export const _descriptorKeyListComplete: AssertEmpty<
  Exclude<(typeof SONIC_DESCRIPTOR_KEYS)[number], keyof SonicDescriptors>
> = true;
/** Same two guards for the per-bar series. */
export const _barSeriesKeyListExact: AssertEmpty<
  Exclude<keyof BarEnergySeries, (typeof BAR_SERIES_KEYS)[number]>
> = true;
export const _barSeriesKeyListComplete: AssertEmpty<
  Exclude<(typeof BAR_SERIES_KEYS)[number], keyof BarEnergySeries>
> = true;
