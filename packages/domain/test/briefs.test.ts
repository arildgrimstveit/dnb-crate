import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createSetPlanInputSchema } from "../src/contracts.ts";

describe("hour briefs", () => {
  it("parses Liquid v5 as drop-anchored phrase-mix depth", () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "docs/examples/liquid-hour-v5.brief.json"),
        "utf8",
      ),
    ) as unknown;
    const parsed = createSetPlanInputSchema.parse(raw);
    expect(parsed.dropAnchored).toBe(true);
    expect(parsed.name).toBe("Liquid hour v5");
    expect(parsed.preferredSubgenres).toContain("liquid funk");
  });
});
