import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/load-config.ts";
import { DomainError } from "../src/errors.ts";
import { keyAgreement, normalizeKey } from "../src/keys.ts";

describe("normalizeKey", () => {
  it("normalizes canonical, enharmonic, and verbose names", () => {
    expect(normalizeKey("F#m")).toEqual({ musicalKey: "F#m", camelotKey: "11A", isMinor: true });
    expect(normalizeKey("F# minor")).toEqual({
      musicalKey: "F#m",
      camelotKey: "11A",
      isMinor: true,
    });
    expect(normalizeKey("11A")).toEqual({ musicalKey: "F#m", camelotKey: "11A", isMinor: true });
    expect(normalizeKey("C major")).toEqual({ musicalKey: "C", camelotKey: "8B", isMinor: false });
    expect(normalizeKey("Db")).toEqual({ musicalKey: "Db", camelotKey: "3B", isMinor: false });
    expect(normalizeKey("C#")).toEqual({ musicalKey: "Db", camelotKey: "3B", isMinor: false });
    expect(normalizeKey("G#m")).toEqual({ musicalKey: "G#m", camelotKey: "1A", isMinor: true });
    expect(normalizeKey("Abm")).toEqual({ musicalKey: "G#m", camelotKey: "1A", isMinor: true });
  });

  it("returns null for empty or unparseable values", () => {
    expect(normalizeKey(null)).toBeNull();
    expect(normalizeKey("")).toBeNull();
    expect(normalizeKey("not a key")).toBeNull();
    expect(normalizeKey("13A")).toBeNull();
  });

  it("classifies exact and relative key agreement", () => {
    expect(keyAgreement("F#m", "11A")).toBe("exact");
    expect(keyAgreement("F#m", "A")).toBe("relative");
    expect(keyAgreement("F#m", "C#m")).toBe("number_pm1");
    expect(keyAgreement("F#m", "C")).toBe("clash");
    expect(keyAgreement(null, "C")).toBeNull();
  });
});

describe("loadConfig", () => {
  it("overlays environment variables on a config file and resolves relative paths", () => {
    const cwd = path.join(os.tmpdir(), `dnb-crate-config-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      path.join(cwd, "dnb-crate.config.json"),
      JSON.stringify({
        databasePath: "./data/db.sqlite",
        libraryRoots: ["./library"],
        outputRoot: "./output",
        logLevel: "debug",
      }),
    );

    const config = loadConfig({
      cwd,
      env: {
        DNB_CRATE_LOG_LEVEL: "warn",
        DNB_CRATE_LIBRARY_ROOTS: JSON.stringify(["./records"]),
        DNB_CRATE_RUBBERBAND_PATH: "./tools/rubberband.exe",
      },
    });

    expect(config.logLevel).toBe("warn");
    expect(config.databasePath).toBe(path.resolve(cwd, "data/db.sqlite"));
    expect(config.libraryRoots).toEqual([path.resolve(cwd, "records")]);
    expect(config.outputRoot).toBe(path.resolve(cwd, "output"));
    expect(config.rubberbandPath).toBe(path.resolve(cwd, "tools/rubberband.exe"));
  });

  it("overlays AcoustID key and enrichment contact from the environment", () => {
    const cwd = path.join(os.tmpdir(), `dnb-crate-enrich-config-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      path.join(cwd, "dnb-crate.config.json"),
      JSON.stringify({
        databasePath: "./data/db.sqlite",
        libraryRoots: ["./library"],
        outputRoot: "./output",
        enrichment: { enabled: true, acoustid: { apiKey: "from-file" } },
      }),
    );
    const config = loadConfig({
      cwd,
      env: {
        DNB_CRATE_ACOUSTID_API_KEY: "from-env",
        DNB_CRATE_ENRICHMENT_CONTACT: "crate@example.com",
      },
    });
    expect(config.enrichment?.acoustid?.apiKey).toBe("from-env");
    expect(config.enrichment?.contact).toBe("crate@example.com");
  });

  it("fails with CONFIG_INVALID when required fields are missing", () => {
    expect(() => loadConfig({ cwd: os.tmpdir(), env: {} })).toThrow(DomainError);
    try {
      loadConfig({ cwd: os.tmpdir(), env: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("CONFIG_INVALID");
    }
  });
});
