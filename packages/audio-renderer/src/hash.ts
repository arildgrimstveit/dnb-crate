import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256Text(JSON.stringify(value));
}

export function sha256FileSync(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
