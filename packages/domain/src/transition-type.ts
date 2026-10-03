import * as z from "zod/v4";

import type { TransitionType } from "./planning.ts";

/** Single schema source for transition types. `double_drop` is a reserved
 * member: stored recipes/plans may carry it; nothing new creates it. */
export const transitionTypeSchema = z.enum(["crossfade", "phrase_mix", "bass_swap", "double_drop"]);

/** Types the renderer/planner can newly produce today. */
export const activeTransitionTypeSchema = z.enum(["crossfade", "phrase_mix", "bass_swap"]);

export type TransitionTypeValue = z.output<typeof transitionTypeSchema>;
export type ActiveTransitionTypeValue = z.output<typeof activeTransitionTypeSchema>;
export type { TransitionType };
