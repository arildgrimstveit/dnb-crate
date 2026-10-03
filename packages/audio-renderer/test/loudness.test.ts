import { describe, expect, it } from "vitest";

import { chooseStaticGainDb } from "../src/index.ts";

describe("chooseStaticGainDb", () => {
  it("attenuates a loud mix to the target", () => {
    const gain = chooseStaticGainDb({ integratedLufs: -8.4, truePeakDb: -0.2 }, -14, -1);
    expect(gain).toBeCloseTo(-5.6, 6);
  });

  it("boosts a quiet mix to the target", () => {
    const gain = chooseStaticGainDb({ integratedLufs: -19.2, truePeakDb: -6.4 }, -14, -1);
    expect(gain).toBeCloseTo(5.2, 6);
  });

  it("leaves an on-target mix alone inside the 0.5 LU deadband", () => {
    expect(chooseStaticGainDb({ integratedLufs: -14.3, truePeakDb: -3 }, -14, -1)).toBe(0);
    expect(chooseStaticGainDb({ integratedLufs: -13.7, truePeakDb: -3 }, -14, -1)).toBe(0);
  });

  it("caps a boost so true peak stays at the ceiling", () => {
    // +6 LU wanted, but true peak -4.2 + 6 would land at +1.8; ceiling -1 caps it at +3.2.
    const gain = chooseStaticGainDb({ integratedLufs: -20, truePeakDb: -4.2 }, -14, -1);
    expect(gain).toBeCloseTo(3.2, 6);
  });

  it("keeps the true-peak ceiling when attenuating", () => {
    const gain = chooseStaticGainDb({ integratedLufs: -13.2, truePeakDb: -0.1 }, -14, -1);
    expect(gain).toBeCloseTo(-0.9, 6);
  });

  it("returns zero gain when loudness is unmeasured but peak is in headroom", () => {
    expect(chooseStaticGainDb({ integratedLufs: null, truePeakDb: -3 }, -14, -1)).toBe(0);
  });

  it("still enforces the ceiling when loudness is unmeasured", () => {
    expect(chooseStaticGainDb({ integratedLufs: null, truePeakDb: -0.4 }, -14, -1)).toBeCloseTo(
      -0.6,
      6,
    );
  });

  it("never lets a ceiling-capped boost go positive past the ceiling", () => {
    // Even a very quiet mix with a hot stored peak gets no net boost.
    const gain = chooseStaticGainDb({ integratedLufs: -30, truePeakDb: -1 }, -14, -1);
    expect(gain).toBe(0);
  });
});
