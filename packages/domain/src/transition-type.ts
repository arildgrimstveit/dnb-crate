import * as z from "zod/v4";

import type { TransitionType } from "./planning.ts";

/** Single schema source for transition types. The reserved `double_drop`
 * member was retired in October 2026 (migration 019 rewrites stored rows);
 * every transition the planner/renderer creates today is one of these. */
export const transitionTypeSchema = z.enum(["crossfade", "phrase_mix", "bass_swap"]);

export type TransitionTypeValue = z.output<typeof transitionTypeSchema>;
export type { TransitionType };
