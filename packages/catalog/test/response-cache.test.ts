import { mkdtemp, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ResponseCache } from "../src/enrichment/response-cache.ts";

describe("ResponseCache TTL", () => {
  it("returns fresh entries and expires stale ones", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dnb-cache-"));
    const cache = new ResponseCache(root, 1000);
    cache.set("https://example/fresh", '{"ok":true}');
    expect(cache.get("https://example/fresh")).toBe('{"ok":true}');

    cache.set("https://example/stale", '{"ok":true}');
    const file = path.join(root);
    const { readdirSync } = await import("node:fs");
    const stored = readdirSync(file).map((name) => path.join(file, name));
    expect(stored.length).toBe(2);
    const when = new Date(Date.now() - 5000);
    await utimes(stored[1]!, when, when);
    expect(cache.get("https://example/stale")).toBeNull();
    // Expired entry is removed so the cache cannot grow without bound on misses.
    expect(readdirSync(file).length).toBe(1);
  });

  it("misses cleanly for unknown urls", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dnb-cache-"));
    const cache = new ResponseCache(root);
    expect(cache.get("https://example/none")).toBeNull();
  });
});
