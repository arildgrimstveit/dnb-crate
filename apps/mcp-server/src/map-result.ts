import { fail, isDomainError, ok, type ToolResult } from "@dnb-crate/domain";

export function textOf(result: ToolResult<unknown>): string {
  if (!result.ok) {
    return `Error ${result.error.code}: ${result.error.message}`;
  }
  return JSON.stringify(result.data, null, 2);
}

export function toolSuccess<T>(
  data: T,
  warnings: string[] = [],
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: ToolResult<T>;
} {
  const structuredContent = ok(data, warnings);
  return {
    content: [{ type: "text", text: summarize(structuredContent) }],
    structuredContent,
  };
}

export function toolFailure(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: ToolResult<never>;
} {
  const structuredContent = isDomainError(error)
    ? fail({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      })
    : fail({
        code: "SCAN_FAILED",
        message: "Unexpected server error. Check stderr logs.",
        retryable: true,
      });
  return {
    content: [{ type: "text", text: textOf(structuredContent) }],
    structuredContent,
  };
}

function summarize<T>(result: ToolResult<T>): string {
  if (!result.ok) {
    return textOf(result);
  }
  const data = result.data as Record<string, unknown>;
  if (Array.isArray(data.tracks)) {
    const tracks = data.tracks as Array<{
      artist: string | null;
      title: string;
      bpm: number | null;
    }>;
    const lines = tracks.map((track, index) => {
      const artist = track.artist ?? "Unknown artist";
      const bpm = track.bpm === null ? "bpm n/a" : `${track.bpm} BPM`;
      return `${index + 1}. ${artist} – ${track.title} (${bpm})`;
    });
    const header = `Found ${tracks.length} track(s).`;
    const warningLine =
      result.warnings.length > 0 ? `\nWarnings: ${result.warnings.join("; ")}` : "";
    return `${header}\n${lines.join("\n")}${warningLine}`.trim();
  }
  if (data.plan && typeof data.plan === "object") {
    const plan = data.plan as { name?: string; entries?: unknown[]; targetDurationMs?: number };
    const count = Array.isArray(plan.entries) ? plan.entries.length : 0;
    const mins = plan.targetDurationMs ? Math.round(plan.targetDurationMs / 60000) : "?";
    return `Set plan “${plan.name ?? "untitled"}”: ${count} tracks, target ${mins} min.`;
  }
  if (Array.isArray(data.candidates)) {
    const rows = data.candidates as Array<{
      track: { artist: string | null; title: string };
      score: { total: number };
    }>;
    return rows
      .map(
        (row, index) =>
          `${index + 1}. ${row.track.artist ?? "Unknown"} – ${row.track.title} (score ${row.score.total.toFixed(1)})`,
      )
      .join("\n");
  }
  if (
    typeof data.status === "string" &&
    typeof data.id === "string" &&
    typeof data.progress === "number"
  ) {
    const pct = Math.round(data.progress * 100);
    return `Render job ${data.id}: ${data.status} (${pct}%).`;
  }
  return JSON.stringify(result.data, null, 2);
}
