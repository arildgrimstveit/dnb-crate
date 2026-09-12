import path from "node:path";

export function normalizedPath(filePath: string): string {
  const normalized = path.resolve(filePath).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isPathInsideRoot(resolvedPath: string, resolvedRoot: string): boolean {
  const target = normalizedPath(resolvedPath);
  const root = normalizedPath(resolvedRoot);
  return target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export function isPathInsideAnyRoot(resolvedPath: string, resolvedRoots: string[]): boolean {
  return resolvedRoots.some((root) => isPathInsideRoot(resolvedPath, root));
}

export function relativeToRoots(resolvedPath: string, resolvedRoots: string[]): string {
  for (const root of resolvedRoots) {
    if (isPathInsideRoot(resolvedPath, root)) {
      return path.relative(root, resolvedPath).replaceAll("\\", "/");
    }
  }
  return "[redacted]";
}
