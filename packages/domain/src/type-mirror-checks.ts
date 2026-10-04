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
import type { rateTransitionInputSchema, transitionFeedbackSchema } from "./feedback-contracts.ts";
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
