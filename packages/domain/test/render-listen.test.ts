import { describe, expect, it } from "vitest";

import { listenRenderFileName, listenRenderRelPath, slugifyRenderName } from "../src/index.ts";

describe("listen render names", () => {
  it("keeps version dots and turns spaces into hyphens", () => {
    expect(slugifyRenderName("hour-liquid-v9.5")).toBe("hour-liquid-v9.5");
    expect(slugifyRenderName("Hour Liquid v9.5")).toBe("hour-liquid-v9.5");
    expect(slugifyRenderName("hour-liquid-v9.5.flac")).toBe("hour-liquid-v9.5");
  });

  it("falls back when the name is empty or reserved", () => {
    expect(slugifyRenderName("???")).toBe("mix");
    expect(slugifyRenderName("CON")).toBe("mix");
  });

  it("does not reuse the master UUID stem", () => {
    const jobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(listenRenderFileName(jobId, jobId)).toBe(`${jobId}-listen.flac`);
    expect(listenRenderRelPath("Fixture mix", jobId)).toBe("renders/fixture-mix.flac");
  });
});
