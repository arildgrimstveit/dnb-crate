import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export class ResponseCache {
  constructor(private readonly root: string) {}

  get(url: string): string | null {
    try {
      return readFileSync(this.fileFor(url), "utf8");
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
