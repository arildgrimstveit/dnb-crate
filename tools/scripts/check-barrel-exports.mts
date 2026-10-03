/**
 * Guard against unused domain-barrel exports (code-quality plan Q5).
 *
 * Reads every name exported from packages/domain/src/index.ts, then searches
 * the whole repo (packages, apps, tools) for references outside the barrel
 * itself and outside the module that defines the name. A barrel export with
 * no remaining reference is dead public API and fails the check.
 *
 * Run: pnpm lint:exports
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../..");
const barrelPath = path.join(repo, "packages/domain/src/index.ts");
const searchRoots = ["packages", "apps", "tools"].map((dir) => path.join(repo, dir));

type ExportEntry = { name: string; definedIn: string | null };

function parseBarrel(): ExportEntry[] {
  const text = readFileSync(barrelPath, "utf8");
  const entries: ExportEntry[] = [];
  const block = /export\s*\{([^}]+)\}\s*from\s*"([^"]+)"/gs;
  for (const match of text.matchAll(block)) {
    const symbols = match[1] ?? "";
    const source = match[2] ?? "";
    for (const raw of symbols.split(",")) {
      const name = raw
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) {
        entries.push({ name, definedIn: source });
      }
    }
  }
  const local = /^export\s+(?:const|function|class|let)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of text.matchAll(local)) {
    entries.push({ name: match[1]!, definedIn: null });
  }
  const localType = /^export\s+type\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of text.matchAll(localType)) {
    entries.push({ name: match[1]!, definedIn: null });
  }
  return entries;
}

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "native-test") continue;
      listFiles(full, out);
    } else if (/\.(ts|mts|tsx|js|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = searchRoots.flatMap((root) => listFiles(root));
const contents = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));

const entries = parseBarrel();
const unused: string[] = [];
for (const { name, definedIn } of entries) {
  const pattern = new RegExp(`\\b${name}\\b`);
  const used = files.some((file) => {
    if (file.replaceAll("\\", "/").endsWith("packages/domain/src/index.ts")) return false;
    if (definedIn && file.replaceAll("\\", "/").endsWith(`packages/domain/src/${definedIn}`)) {
      // The defining module's own declaration does not count as a consumer.
      return false;
    }
    return pattern.test(contents.get(file)!);
  });
  if (!used) unused.push(name);
}

if (unused.length > 0) {
  console.error(`Unused domain barrel exports (${unused.length}):`);
  for (const name of unused.sort()) console.error(`  ${name}`);
  process.exit(1);
}
console.log(`All ${entries.length} domain barrel exports have consumers.`);
