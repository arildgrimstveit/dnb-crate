export const MIX_TAG_ARTIST = "dnb-crate";

export type MixChapterTag = {
  startMs: number;
  title: string;
  artist?: string | null;
};

export type MixOutputTags = {
  title: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  date?: string;
  encodedBy?: string;
  comment?: string;
  chapters?: MixChapterTag[];
};

export function trackCredit(artist: string | null | undefined, title: string): string {
  const name = artist?.trim();
  return name ? `${name} — ${title}` : title;
}

export function formatMixTimestamp(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function buildMixTracklist(chapters: MixChapterTag[]): string {
  return chapters
    .map((chapter, index) => `${index + 1}. [${formatMixTimestamp(chapter.startMs)}] ${trackCredit(chapter.artist, chapter.title)}`)
    .join("\n");
}

export function mixTagsFromTracklist(input: {
  title: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  date?: string;
  encodedBy?: string;
  tracks: Array<{ artist: string | null | undefined; title: string; startMs: number }>;
}): MixOutputTags {
  const chapters = input.tracks.map((track) => ({
    startMs: track.startMs,
    title: track.title,
    artist: track.artist ?? null,
  }));
  const tracklist = buildMixTracklist(chapters);
  const comment = tracklist ? `${input.title}\n\n${tracklist}` : input.title;
  return {
    title: input.title,
    artist: input.artist ?? MIX_TAG_ARTIST,
    album: input.album ?? input.title,
    albumArtist: input.albumArtist ?? MIX_TAG_ARTIST,
    date: input.date,
    encodedBy: input.encodedBy,
    comment,
    chapters,
  };
}

/** FFmpeg ffmetadata: `\`, `=`, `;`, `#`, and newlines must be escaped. */
export function escapeFfmetadataValue(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/=/g, "\\=")
    .replace(/;/g, "\\;")
    .replace(/#/g, "\\#")
    .replace(/\n/g, "\\\n");
}

export function formatCueIndex(ms: number): string {
  const totalFrames = Math.max(0, Math.round((ms / 1000) * 75));
  const minutes = Math.floor(totalFrames / (75 * 60));
  const seconds = Math.floor((totalFrames % (75 * 60)) / 75);
  const frames = totalFrames % 75;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

export function buildCueSheet(tags: MixOutputTags, durationMs: number): string {
  const tracks = chaptersInRange(tags.chapters ?? [], durationMs).slice(0, 99);
  if (tracks.length === 0) {
    return "";
  }
  const lines = [
    `PERFORMER "${escapeCueString(tags.artist ?? MIX_TAG_ARTIST)}"`,
    `TITLE "${escapeCueString(tags.title)}"`,
  ];
  if (tags.date) {
    lines.splice(0, 0, `REM DATE ${escapeCueString(tags.date)}`);
  }
  tracks.forEach((chapter, index) => {
    const number = String(index + 1).padStart(2, "0");
    lines.push(`  TRACK ${number} AUDIO`);
    lines.push(`    TITLE "${escapeCueString(chapter.title)}"`);
    if (chapter.artist?.trim()) {
      lines.push(`    PERFORMER "${escapeCueString(chapter.artist.trim())}"`);
    }
    lines.push(`    INDEX 01 ${formatCueIndex(chapter.startMs)}`);
  });
  lines.push("");
  return lines.join("\n");
}

export function buildFfmetadataFile(tags: MixOutputTags, durationMs: number): string {
  const cueSheet = buildCueSheet(tags, durationMs);
  const lines = [";FFMETADATA1"];
  const fields: Array<[string, string | undefined]> = [
    ["title", tags.title],
    ["artist", tags.artist],
    ["album", tags.album],
    ["album_artist", tags.albumArtist],
    ["date", tags.date],
    ["encoded_by", tags.encodedBy],
    ["comment", tags.comment],
    ["description", tags.comment],
    ["CUESHEET", cueSheet || undefined],
  ];
  for (const [key, value] of fields) {
    if (value != null && value !== "") {
      lines.push(`${key}=${escapeFfmetadataValue(value)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function escapeCueString(value: string): string {
  return value.replace(/["\r\n]/g, (ch) => (ch === '"' ? "'" : " "));
}

function chaptersInRange(chapters: MixChapterTag[], durationMs: number): MixChapterTag[] {
  const duration = Math.max(0, Math.round(durationMs));
  if (duration <= 0) {
    return [];
  }
  const sorted = [...chapters]
    .map((chapter) => ({
      startMs: Math.max(0, Math.round(chapter.startMs)),
      title: chapter.title.trim() || "Track",
      artist: chapter.artist ?? null,
    }))
    .filter((chapter) => chapter.startMs < duration)
    .sort((a, b) => a.startMs - b.startMs);

  const unique: MixChapterTag[] = [];
  for (const chapter of sorted) {
    const previous = unique.at(-1);
    if (previous && chapter.startMs <= previous.startMs) {
      const bumped = previous.startMs + 1;
      if (bumped < duration) {
        unique.push({ ...chapter, startMs: bumped });
      }
    } else {
      unique.push(chapter);
    }
  }
  return unique;
}
