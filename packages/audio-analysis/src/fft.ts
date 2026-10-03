/** In-place radix-2 Cooley–Tukey FFT. `re`/`im` length must be a power of two. */
export function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      const ti = im[i]!;
      re[i] = re[j]!;
      im[i] = im[j]!;
      re[j] = tr;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < half; j += 1) {
        const uRe = re[i + j]!;
        const uIm = im[i + j]!;
        const vr = re[i + j + half]!;
        const vi = im[i + j + half]!;
        const vRe = vr * wRe - vi * wIm;
        const vIm = vr * wIm + vi * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nWRe;
      }
    }
  }
}

export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  if (n <= 1) {
    w[0] = 1;
    return w;
  }
  for (let i = 0; i < n; i += 1) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return w;
}

export type StftResult = {
  mag: number[][];
  hop: number;
  nfft: number;
  hopMs: number;
};

/**
 * Stream STFT magnitude frames without materializing the frames×bins matrix
 * (a `number[][]` for a 60-minute file is >1 GB). Bin values are computed
 * exactly as a matrix build would compute them, so results are bit-identical;
 * the only difference is that `frame` is a reused buffer — copy it when
 * retention is needed. Returns the frame count.
 */
export function forEachStftFrame(
  samples: Float32Array,
  nfft: number,
  hop: number,
  visit: (frame: Float64Array, index: number, startSample: number) => void,
): number {
  const window = hannWindow(nfft);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const bins = new Float64Array(nfft / 2);
  let index = 0;
  for (let start = 0; start + nfft <= samples.length; start += hop) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < nfft; i += 1) {
      re[i] = (samples[start + i] ?? 0) * (window[i] ?? 0);
    }
    fftRadix2(re, im);
    for (let k = 0; k < nfft / 2; k += 1) {
      const r = re[k] ?? 0;
      const imk = im[k] ?? 0;
      bins[k] = Math.sqrt(r * r + imk * imk);
    }
    visit(bins, index, start);
    index += 1;
  }
  return index;
}
