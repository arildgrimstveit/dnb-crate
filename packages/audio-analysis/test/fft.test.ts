import { describe, expect, it } from "vitest";

import { fftRadix2, forEachStftFrame, hannWindow } from "../src/fft.ts";

describe("fftRadix2", () => {
  it("peaks a pure sinusoid at the expected bin with the expected magnitude", () => {
    const n = 1024;
    const rate = 1024; // 1 sample per second-per-bin: bin k == k Hz
    const hz = 100;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      re[i] = Math.cos((2 * Math.PI * hz * i) / n);
    }
    fftRadix2(re, im);
    let bestBin = 0;
    let bestMag = 0;
    for (let k = 0; k < n / 2; k += 1) {
      const mag = Math.hypot(re[k] ?? 0, im[k] ?? 0);
      if (mag > bestMag) {
        bestMag = mag;
        bestBin = k;
      }
    }
    expect(bestBin).toBe(hz);
    // Rectangular-windowed cosine of amplitude 1: peak magnitude ≈ n/2.
    expect(bestMag).toBeCloseTo(n / 2, 6);
    expect(rate).toBe(1024);
  });

  it("leaves DC in bin 0 for a constant signal", () => {
    const n = 256;
    const re = new Float64Array(n).fill(2);
    const im = new Float64Array(n);
    fftRadix2(re, im);
    expect(re[0]).toBeCloseTo(2 * n, 9);
    for (let k = 1; k < n; k += 1) {
      expect(Math.hypot(re[k] ?? 0, im[k] ?? 0)).toBeLessThan(1e-9);
    }
  });

  it("hann windows are symmetric-form and normalized to [0, 1]", () => {
    const w = hannWindow(64);
    expect(w[0]).toBeCloseTo(0, 9);
    // Symmetric (n-1) Hann: the peak sits between samples 31 and 32.
    expect(Math.max(w[31] ?? 0, w[32] ?? 0)).toBeGreaterThan(0.999);
    expect(w[63]).toBeCloseTo(0, 9);
    for (const value of w) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe("forEachStftFrame", () => {
  it("visits every full frame with hop spacing and reuses one buffer", () => {
    const samples = new Float32Array(2048 + 512 * 3); // 4 full frames + remainder
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / 22050);
    }
    const seen: number[] = [];
    let buffer: Float64Array | null = null;
    let sameBuffer = true;
    const count = forEachStftFrame(samples, 2048, 512, (frame, index, startSample) => {
      if (buffer === null) buffer = frame;
      if (frame !== buffer) sameBuffer = false;
      expect(startSample).toBe(index * 512);
      seen.push(frame.length);
    });
    expect(count).toBe(4);
    expect(seen).toEqual([1024, 1024, 1024, 1024]);
    expect(sameBuffer).toBe(true);
  });
});
