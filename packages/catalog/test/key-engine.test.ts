import { describe, expect, it } from "vitest";

import { parseKeyStdout } from "../src/analysis/key-engine.ts";

describe("key engine parse", () => {
  it("reads KeyFinder tokens", () => {
    expect(parseKeyStdout("5A").camelotKey).toBe("5A");
    expect(parseKeyStdout("Am")).toEqual({
      musicalKey: "Am",
      camelotKey: "8A",
      keyConfidence: 0.7,
    });
  });
});
