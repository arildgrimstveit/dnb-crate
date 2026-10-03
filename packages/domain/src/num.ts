/** Numeric helpers shared across the domain packages. */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Finite number from a loose value, or null. */
export function finiteNumber(value: number | string | boolean | undefined | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
