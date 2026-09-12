import { describe, expect, it } from "vitest";

import {
  clampMakeupDb,
  resolveRubberbandCli,
  rubberbandCliArgs,
} from "../src/rubberband-cli.ts";

describe("rubberband CLI", () => {
  it("uses R3 fine and the FFmpeg tempo multiple", () => {
    const args = rubberbandCliArgs(174 / 175, "in.wav", "out.wav");
    expect(args[0]).toBe("-3");
    expect(args[1]).toBe("-T");
    expect(Number(args[2])).toBeCloseTo(174 / 175, 8);
    expect(args).toContain("--centre-focus");
    expect(args.at(-2)).toBe("in.wav");
    expect(args.at(-1)).toBe("out.wav");
  });

  it("clamps R3 makeup so a silent/wet mismatch cannot explode", () => {
    expect(clampMakeupDb(12)).toBe(6);
    expect(clampMakeupDb(-9)).toBe(-6);
    expect(clampMakeupDb(2.9)).toBeCloseTo(2.9, 5);
  });

  it("resolves the bundled Windows CLI when present", () => {
    const found = resolveRubberbandCli();
    if (found) {
      expect(found.replaceAll("\\", "/")).toMatch(/rubberband(?:-r3)?\.exe$/i);
    } else {
      expect(found).toBeNull();
    }
  });
});
