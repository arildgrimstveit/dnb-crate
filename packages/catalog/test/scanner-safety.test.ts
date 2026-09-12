import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger, type AppConfig } from "@dnb-crate/domain";
import { createCatalogRuntime, walkLibrary, writeSineWav } from "../src/index.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return { ...original, readdir: vi.fn(original.readdir) };
});
afterEach(() => vi.mocked(fs.readdir).mockReset());

async function workspace(): Promise<AppConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dnb-scan-safe-"));
  const library = path.join(root, "library");
  await fs.mkdir(library);
  return {
    databasePath: path.join(root, "catalog.sqlite"),
    libraryRoots: [library],
    outputRoot: path.join(root, "output"),
    supportedExtensions: [".wav"],
    logLevel: "error",
  };
}

describe("scanner safety", () => {
  it("terminates junction cycles and deduplicates overlapping roots and aliases", async () => {
    const config = await workspace();
    const root = config.libraryRoots[0]!;
    const nested = path.join(root, "nested");
    await fs.mkdir(nested);
    await writeSineWav(path.join(nested, "one.wav"), { durationMs: 100 });
    await fs.symlink(
      root,
      path.join(nested, "loop"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await fs.symlink(
      nested,
      path.join(root, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    config.libraryRoots.push(nested, root);
    const walked = await walkLibrary(config, silentLogger);
    expect(walked.complete).toBe(true);
    expect(walked.files).toHaveLength(1);
  });

  it("preserves availability after an unreadable subtree, then marks a real deletion on a complete scan", async () => {
    const config = await workspace();
    const nested = path.join(config.libraryRoots[0]!, "nested");
    await fs.mkdir(nested);
    const file = path.join(nested, "one.wav");
    await writeSineWav(file, { durationMs: 100 });
    const runtime = createCatalogRuntime(config, undefined, { passive: true });
    try {
      await runtime.service.scanLibrary();
      const id = runtime.repository.listAll()[0]!.id;
      const original = await vi.importActual<typeof fs>("node:fs/promises");
      vi.mocked(fs.readdir).mockImplementation((...args: Parameters<typeof fs.readdir>) => {
        if (String(args[0]) === nested) return Promise.reject(new Error("EACCES"));
        return original.readdir(...args);
      });
      const partial = await runtime.service.scanLibrary();
      expect(partial.result.markedMissing).toBe(0);
      expect(partial.warnings.some((w) => w.includes("Scan incomplete"))).toBe(true);
      expect(runtime.repository.findById(id)!.fileMissing).toBe(false);
      vi.mocked(fs.readdir).mockReset();
      await fs.unlink(file);
      const complete = await runtime.service.scanLibrary();
      expect(complete.result.markedMissing).toBe(1);
      expect(runtime.repository.findById(id)!.fileMissing).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
