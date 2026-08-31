const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

function freqToNote(freq: number): { name: string; midi: number } | null {
  if (!(freq > 20) || freq > 5000) {
    return null;
  }
  const midi = Math.round(69 + 12 * Math.log2(freq / 440));
  const pc = ((midi % 12) + 12) % 12;
  return { name: NOTE_NAMES[pc]!, midi };
}

/** Dominant pitch via zero-crossings. Weak on broadband/click material (low confidence). */
export function estimateKeyFromPitch(
  samples: Float32Array,
  sampleRateHz: number,
): { musicalKey: string | null; keyConfidence: number } {
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1] ?? 0;
    const b = samples[i] ?? 0;
    if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) {
      crossings += 1;
    }
  }
  const durationSec = samples.length / sampleRateHz;
  if (durationSec <= 0) {
    return { musicalKey: null, keyConfidence: 0 };
  }
  const freq = crossings / 2 / durationSec;
  const note = freqToNote(freq);
  if (!note) {
    return { musicalKey: null, keyConfidence: 0 };
  }
  const expected = 440 * Math.pow(2, (note.midi - 69) / 12);
  const cents = Math.abs(1200 * Math.log2(freq / expected));
  const confidence = Math.max(0, Math.min(1, 1 - cents / 50));
  if (confidence < 0.6) {
    return { musicalKey: null, keyConfidence: Number(confidence.toFixed(3)) };
  }
  return { musicalKey: note.name, keyConfidence: Number(confidence.toFixed(3)) };
}
