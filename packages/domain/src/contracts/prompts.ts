import * as z from "zod/v4";

export const buildDnbSetPromptArgsSchema = z.object({
  request: z.string().min(1).max(4000).describe("Natural-language description of the desired set"),
});
