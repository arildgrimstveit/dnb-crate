/** Shared timestamp helper so all repositories stamp rows identically. */
export function nowIso(): string {
  return new Date().toISOString();
}
