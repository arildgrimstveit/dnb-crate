import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Cached provider responses go stale so changed upstream metadata is
 * eventually picked up instead of being served forever. */
export const RESPONSE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class ResponseCache {
  constructor(
    private readonly root: string,
    private readonly maxAgeMs: number = RESPONSE_CACHE_TTL_MS,
  ) {}

  get(url: string): string | null {
    const file = this.fileFor(url);
    try {
      const info = statSync(file);
      if (Date.now() - info.mtimeMs > this.maxAgeMs) {
        rmSync(file, { force: true });
        return null;
      }
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  set(url: string, body: string): void {
    const file = this.fileFor(url);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, "utf8");
  }

  private fileFor(url: string): string {
    const hash = createHash("sha256").update(url).digest("hex");
    return path.join(this.root, `${hash}.json`);
  }
}
