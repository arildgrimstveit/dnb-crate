import { DomainError } from "@dnb-crate/domain";

export type SortField =
  | "title"
  | "artist"
  | "album"
  | "bpm"
  | "energy"
  | "rating"
  | "durationMs"
  | "createdAt"
  | "updatedAt";

export type SortDirection = "asc" | "desc";

export type PageCursor = {
  sort: SortField;
  direction: SortDirection;
  value: string | number | null;
  id: string;
};

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): PageCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("sort" in parsed) ||
      !("direction" in parsed) ||
      !("id" in parsed) ||
      !("value" in parsed)
    ) {
      throw new Error("shape");
    }
    const cursor = parsed as PageCursor;
    if (typeof cursor.id !== "string" || cursor.id.length === 0) {
      throw new Error("id");
    }
    return cursor;
  } catch (error) {
    throw new DomainError("INVALID_CURSOR", "Pagination cursor is invalid or corrupted", {
      cause: error,
    });
  }
}
