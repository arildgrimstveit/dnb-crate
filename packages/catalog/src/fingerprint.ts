import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

import { FINGERPRINT_WINDOW_BYTES } from "@dnb-crate/domain";

export type FileIdentity = {
  size: number;
  mtimeMs: number;
};

/**
 * Stable-enough identity for upsert/move detection.
 *
 * Combines size with SHA-256 of the first and last 64 KiB.
 * mtime is intentionally excluded so a rewritten copy of the same bytes
 * (typical “move then resave”) still matches a missing catalog row.
 */
export async function fingerprintFile(filePath: string, identity: FileIdentity): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`${identity.size}`);

  const handle = await open(filePath, "r");
  try {
    const head = Buffer.alloc(Math.min(FINGERPRINT_WINDOW_BYTES, identity.size));
    await handle.read(head, 0, head.length, 0);
    hash.update(head);

    if (identity.size > FINGERPRINT_WINDOW_BYTES) {
      const tailLen = Math.min(FINGERPRINT_WINDOW_BYTES, identity.size - FINGERPRINT_WINDOW_BYTES);
      const tail = Buffer.alloc(tailLen);
      await handle.read(tail, 0, tail.length, identity.size - tailLen);
      hash.update(tail);
    }
  } finally {
    await handle.close();
  }

  return hash.digest("hex");
}
