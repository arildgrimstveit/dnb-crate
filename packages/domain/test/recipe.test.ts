import { describe, expect, it } from "vitest";
import { exactRecipeFingerprint, recipeFingerprint } from "../src/recipe.ts";

describe("versioned exact recipe identity", () => {
  it("ignores object order while retaining every audible parameter", () => {
    const recipe = {
      gainDb: -1,
      automation: [{ atMs: 1000, durationMs: 500 }],
      engine: { version: "4", scope: "overlap" },
    };
    expect(exactRecipeFingerprint(recipe)).toBe(
      exactRecipeFingerprint({ engine: recipe.engine, automation: recipe.automation, gainDb: -1 }),
    );
    for (const change of [
      { gainDb: -2 },
      { automation: [{ atMs: 900, durationMs: 500 }] },
      { engine: { version: "5", scope: "overlap" } },
    ]) {
      expect(exactRecipeFingerprint({ ...recipe, ...change })).not.toBe(
        exactRecipeFingerprint(recipe),
      );
    }
    expect(exactRecipeFingerprint(recipe)).toMatch(/^v2:[a-f0-9]{64}$/);
    expect(recipeFingerprint({ type: "phrase_mix" })).toMatch(/^[a-f0-9]{8}$/);
  });
});
