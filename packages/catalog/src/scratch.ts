import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Marker file placed inside every owned scratch directory (F10). */
export const SCRATCH_OWNER_FILE = "owner.json";

export type ScratchOwner = {
  pid: number;
  startedAt: string;
};

/**
 * Create (or adopt) a scratch directory with an ownership marker so the
 * temp sweeper can distinguish abandoned work from a long-running job in a
 * live process (F10, repository review 2026-10-08). Directories without a
 * marker are legacy and fall back to age-only sweeping.
 */
export async function claimScratchDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const owner: ScratchOwner = { pid: process.pid, startedAt: new Date().toISOString() };
  await writeFile(path.join(dir, SCRATCH_OWNER_FILE), JSON.stringify(owner), {
    flag: "w",
  });
}

/** Read a scratch directory's owner marker; null when absent or unreadable. */
export async function readScratchOwner(dir: string): Promise<ScratchOwner | null> {
  try {
    const raw = await readFile(path.join(dir, SCRATCH_OWNER_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<ScratchOwner>;
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return { pid: parsed.pid, startedAt: String(parsed.startedAt ?? "") };
    }
    return null;
  } catch {
    return null;
  }
}
