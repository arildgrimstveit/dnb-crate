/**
 * Deduplicate identical library copies and rename to:
 *   Artist/Album (Year)/NN Title.ext
 *   Artist/Album (Year)/CDn/NN Title.ext   (multi-disc)
 *   Artist/Title.ext                       (no album)
 *
 * Compilation albums put the track artist in the filename:
 *   NN Artist - Title.ext
 *
 * Usage:
 *   node ./node_modules/tsx/dist/cli.mjs tools/scripts/normalize-library.mts
 *   node ./node_modules/tsx/dist/cli.mjs tools/scripts/normalize-library.mts --apply
 *
 * Does not write audio tags. Does not print the library root.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { openDatabase } from "../../packages/catalog/src/db.ts";
import { loadConfig } from "../../packages/domain/src/index.ts";

import { readAudioTags as parseFile } from "../../packages/catalog/src/metadata.ts";

const apply = process.argv.includes("--apply");
const AUDIO_EXT = new Set([".wav", ".flac", ".mp3", ".m4a", ".aiff", ".aif"]);

type TrackRow = {
  id: string;
  file_path: string;
  file_fingerprint: string;
  artist: string | null;
  title: string;
  album: string | null;
  duration_ms: number;
  recording_key: string | null;
};

type Tags = {
  artist: string | null;
  albumartist: string | null;
  album: string | null;
  title: string | null;
  trackNo: number | null;
  diskNo: number | null;
  diskOf: number | null;
  year: number | null;
};

type PlannedFile = {
  id: string;
  srcRel: string;
  destRel: string;
  srcAbs: string;
  destAbs: string;
};

function relTo(root: string, filePath: string): string {
  const normalized = path.resolve(filePath);
  const prefix = path.resolve(root);
  const relative = path.relative(prefix, normalized).replaceAll("\\", "/");
  if (relative.startsWith("..")) {
    return path.basename(filePath);
  }
  return relative;
}

function displayArtist(name: string): string {
  return name
    .replace(/\s+and\s+/gi, " & ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+&\s+/g, " & ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFeat(name: string): string {
  return displayArtist(name.replace(/\s*[,;]?\s*(feat\.?|ft\.?|featuring)\b[\s\S]*/i, "").trim());
}

function sanitizeSegment(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return cleaned.length > 0 ? cleaned : "Unknown";
}

function yearFromText(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = /\b((?:19|20)\d{2})\b/.exec(value);
  return match ? Number(match[1]) : null;
}

function mode<T>(values: T[]): T | null {
  if (values.length === 0) {
    return null;
  }
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: T | null = null;
  let bestN = 0;
  for (const [value, n] of counts) {
    if (n > bestN) {
      best = value;
      bestN = n;
    }
  }
  return best;
}

function isCopyRel(relPath: string): boolean {
  return relPath.split("/").some((part) => part.endsWith(" - Copy"));
}

function topFolder(relPath: string): string {
  return relPath.includes("/") ? relPath.slice(0, relPath.indexOf("/")) : relPath;
}

function folderArtistHint(top: string): string | null {
  const stripped = top.replace(/^\[(\d{4})\]\s*/, "").replace(/ - Copy$/, "");
  const dash = stripped.split(" - ");
  if (dash.length >= 2) {
    const artist = dash[0]!.replace(/\s+Presents$/i, "").trim();
    return artist.length > 0 ? displayArtist(artist) : null;
  }
  return null;
}

function cleanAlbumTitle(album: string): string {
  return album
    .replace(/\s*\((?:cd|disc)\s*\d+\)\s*$/i, "")
    .replace(/\s*,\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanAlbumArtist(value: string): string {
  const first = value.split("/")[0]!.trim();
  if (/^various(\s+artists)?$/i.test(first)) {
    return "Various Artists";
  }
  return displayArtist(first);
}

function discFromRel(relPath: string): number | null {
  const parts = relPath.split("/").slice(0, -1);
  for (const part of parts) {
    const plain = part.replace(/[[\]]/g, "").trim();
    const named = /^(?:disc|cd)\s*0*(\d+)$/i.exec(plain);
    if (named) {
      return Number(named[1]);
    }
  }
  return null;
}

function titleFromStem(stem: string): string {
  return stem
    .replace(/^\d{1,3}(?:\s*[.\-_]\s*|\s+)/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseArtistTitleFilename(stem: string): { artist: string; title: string } | null {
  const cleaned = titleFromStem(stem);
  const match = /^(.+?)\s+-\s+(.+)$/.exec(cleaned);
  if (!match) {
    return null;
  }
  return { artist: match[1]!.trim(), title: match[2]!.trim() };
}

async function readTags(filePath: string): Promise<Tags> {
  const parsed = await parseFile(filePath, { duration: false });
  const year =
    typeof parsed.common.year === "number" && parsed.common.year >= 1900
      ? parsed.common.year
      : yearFromText(parsed.common.date ?? null);
  return {
    artist: parsed.common.artist?.trim() || null,
    albumartist: parsed.common.albumartist?.trim() || null,
    album: parsed.common.album?.trim() || null,
    title: parsed.common.title?.trim() || null,
    trackNo: parsed.common.track?.no ?? null,
    diskNo: parsed.common.disk?.no ?? null,
    diskOf: parsed.common.disk?.of ?? null,
    year,
  };
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function albumDirFromDest(destRel: string): string {
  const parts = destRel.split("/");
  if (parts.length >= 4 && /^CD\d+$/i.test(parts[parts.length - 2]!)) {
    return parts.slice(0, 2).join("/");
  }
  if (parts.length >= 3) {
    return parts.slice(0, 2).join("/");
  }
  return parts[0]!;
}

function removeEmptyDirs(dir: string, stopAt: string): void {
  const resolved = path.resolve(dir);
  const root = path.resolve(stopAt);
  if (resolved === root || !resolved.startsWith(root)) {
    return;
  }
  if (!existsSync(resolved)) {
    return;
  }
  const entries = readdirSync(resolved);
  if (entries.length > 0) {
    return;
  }
  rmSync(resolved, { recursive: true, force: true });
  removeEmptyDirs(path.dirname(resolved), stopAt);
}

const config = loadConfig({ defaultConfigFileName: "dnb-crate.config.json" });
const root = path.resolve(config.libraryRoots[0] ?? "");
if (!existsSync(root)) {
  throw new Error("library root is missing");
}

const dbPath = path.resolve(config.databasePath);
const db = openDatabase(dbPath);
const tracks = db.prepare("SELECT * FROM tracks").all() as TrackRow[];

const byFingerprint = new Map<string, TrackRow[]>();
for (const track of tracks) {
  const list = byFingerprint.get(track.file_fingerprint) ?? [];
  list.push(track);
  byFingerprint.set(track.file_fingerprint, list);
}

const keepIds = new Set<string>();
const deleteIds = new Set<string>();
const rematch: Array<{ from: string; to: string }> = [];
const deleteRels: string[] = [];

for (const group of byFingerprint.values()) {
  if (group.length < 2) {
    keepIds.add(group[0]!.id);
    continue;
  }
  const titles = new Set(group.map((row) => row.title.toLowerCase()));
  if (titles.size > 1) {
    for (const row of group) {
      keepIds.add(row.id);
    }
    continue;
  }
  const ranked = [...group].sort((a, b) => {
    const aCopy = isCopyRel(relTo(root, a.file_path)) ? 1 : 0;
    const bCopy = isCopyRel(relTo(root, b.file_path)) ? 1 : 0;
    return aCopy - bCopy || a.file_path.localeCompare(b.file_path);
  });
  const keeper = ranked[0]!;
  keepIds.add(keeper.id);
  for (const loser of ranked.slice(1)) {
    deleteIds.add(loser.id);
    rematch.push({ from: loser.id, to: keeper.id });
    deleteRels.push(relTo(root, loser.file_path));
  }
}

for (const track of tracks) {
  if (!keepIds.has(track.id) && !deleteIds.has(track.id)) {
    keepIds.add(track.id);
  }
}

const keepers = tracks.filter((track) => keepIds.has(track.id) && !deleteIds.has(track.id));
const tagById = new Map<string, Tags>();
for (const track of keepers) {
  tagById.set(track.id, await readTags(track.file_path));
}

type ReleaseMember = {
  track: TrackRow;
  tags: Tags;
  rel: string;
};

const releases = new Map<string, ReleaseMember[]>();
for (const track of keepers) {
  const rel = relTo(root, track.file_path);
  const key = rel.includes("/") ? topFolder(rel).replace(/ - Copy$/, "") : `__single__:${track.id}`;
  const list = releases.get(key) ?? [];
  list.push({ track, tags: tagById.get(track.id)!, rel });
  releases.set(key, list);
}

const planned: PlannedFile[] = [];
const releasePreview: Array<{ from: string; to: string; files: number; compilation: boolean }> = [];

for (const [releaseKey, members] of [...releases.entries()].sort((a, b) =>
  a[0].localeCompare(b[0]),
)) {
  const top = members[0]!.rel.includes("/") ? topFolder(members[0]!.rel) : members[0]!.rel;
  const albumValues = members
    .map((m) => m.tags.album ?? m.track.album)
    .filter((v): v is string => Boolean(v));
  const albumRaw = mode(albumValues.map(cleanAlbumTitle));
  const folderYear = yearFromText(top);
  const tagYears = members.map((m) => m.tags.year).filter((v): v is number => v !== null);
  const year = folderYear ?? mode(tagYears) ?? (tagYears.length > 0 ? Math.min(...tagYears) : null);

  const albumartists = [
    ...new Set(
      members
        .map((m) => m.tags.albumartist)
        .filter((v): v is string => Boolean(v))
        .map(cleanAlbumArtist),
    ),
  ];
  const primaries = [
    ...new Set(
      members
        .map((m) => m.tags.artist ?? m.track.artist)
        .filter((v): v is string => Boolean(v))
        .map(stripFeat),
    ),
  ];
  const hint = folderArtistHint(top);
  let releaseArtist: string;
  if (albumartists.length === 1 && albumartists[0] !== "Various Artists") {
    releaseArtist = albumartists[0]!;
  } else if (primaries.length === 1) {
    releaseArtist = primaries[0]!;
  } else if (primaries.length > 1 && primaries.every((p) => /technimatic/i.test(p))) {
    releaseArtist = "Technimatic";
  } else if (
    albumartists.includes("Various Artists") &&
    hint &&
    !hint.includes(",") &&
    hint.length < 40
  ) {
    releaseArtist = hint;
  } else if (hint && !hint.includes(",") && hint.length < 40) {
    releaseArtist = hint;
  } else if (primaries.length > 0) {
    releaseArtist = "Various Artists";
  } else {
    const parsed = parseArtistTitleFilename(path.parse(members[0]!.rel).name);
    releaseArtist = parsed ? displayArtist(parsed.artist) : "Unknown Artist";
  }

  const compilation =
    releaseArtist === "Various Artists" ||
    albumartists.includes("Various Artists") ||
    (primaries.length >= 3 &&
      !primaries.every((p) => p.toLowerCase().startsWith(releaseArtist.toLowerCase())));

  const discNos = members.map((m) => {
    const fromTag =
      m.tags.diskNo && (m.tags.diskOf ?? 0) > 1
        ? m.tags.diskNo
        : m.tags.diskNo && m.tags.diskNo > 1
          ? m.tags.diskNo
          : null;
    return fromTag ?? discFromRel(m.rel);
  });
  const numericParents = new Set(
    members
      .map((m) => {
        const parts = m.rel.split("/");
        return parts.length >= 3 && /^\d+$/.test(parts[1]!) ? Number(parts[1]) : null;
      })
      .filter((v): v is number => v !== null),
  );
  const useBareDisc = numericParents.size >= 2;
  const discs = members.map((m, i) => {
    if (discNos[i]) {
      return discNos[i];
    }
    if (useBareDisc) {
      const parts = m.rel.split("/");
      return parts.length >= 3 && /^\d+$/.test(parts[1]!) ? Number(parts[1]) : null;
    }
    return null;
  });
  const multiDisc =
    discs.some((d) => d !== null && d > 0) && new Set(discs.filter((d) => d !== null)).size > 1;

  const artistSeg = sanitizeSegment(releaseArtist);
  const albumSeg = albumRaw ? sanitizeSegment(year ? `${albumRaw} (${year})` : albumRaw) : null;

  for (const [index, member] of members.entries()) {
    const ext = path.extname(member.rel).toLowerCase();
    const stem = path.parse(member.rel).name;
    const parsedName = parseArtistTitleFilename(stem);
    const title =
      member.tags.title ??
      (member.track.title && member.track.artist ? member.track.title : null) ??
      parsedName?.title ??
      titleFromStem(stem);
    const trackArtist = displayArtist(
      member.tags.artist ?? member.track.artist ?? parsedName?.artist ?? releaseArtist,
    );
    const trackNo =
      member.tags.trackNo ??
      (stem.match(/^(\d{1,3})\b/) ? Number(stem.match(/^(\d{1,3})\b/)![1]) : null);
    const nn = trackNo !== null ? String(trackNo).padStart(2, "0") : null;
    const titleSeg = sanitizeSegment(compilation ? `${trackArtist} - ${title}` : title);
    const fileName = `${nn ? `${nn} ` : ""}${titleSeg}${ext}`;
    const disc = multiDisc ? discs[index] : null;
    const destRel = albumSeg
      ? disc
        ? `${artistSeg}/${albumSeg}/CD${disc}/${fileName}`
        : `${artistSeg}/${albumSeg}/${fileName}`
      : `${artistSeg}/${fileName}`;
    planned.push({
      id: member.track.id,
      srcRel: member.rel,
      destRel,
      srcAbs: member.track.file_path,
      destAbs: path.join(root, destRel),
    });
  }

  const destAlbum = albumSeg ? `${artistSeg}/${albumSeg}` : artistSeg;
  releasePreview.push({
    from: releaseKey.startsWith("__single__:") ? top : releaseKey,
    to: destAlbum,
    files: members.length,
    compilation,
  });
}

const destCounts = new Map<string, number>();
for (const item of planned) {
  const key = item.destRel.toLowerCase();
  destCounts.set(key, (destCounts.get(key) ?? 0) + 1);
}
const collisions = planned.filter((item) => (destCounts.get(item.destRel.toLowerCase()) ?? 0) > 1);

const extrasInCopy: string[] = [];
const copyTops = new Set(
  tracks.map((t) => topFolder(relTo(root, t.file_path))).filter((name) => name.endsWith(" - Copy")),
);
for (const folder of copyTops) {
  const abs = path.join(root, folder);
  if (!existsSync(abs)) {
    continue;
  }
  for (const file of walkFiles(abs)) {
    const rel = relTo(root, file);
    const ext = path.extname(file).toLowerCase();
    const isCatalogAudio = tracks.some((t) => path.resolve(t.file_path) === path.resolve(file));
    if (!AUDIO_EXT.has(ext) || !isCatalogAudio) {
      extrasInCopy.push(rel);
    }
  }
}

console.log(
  JSON.stringify(
    {
      apply,
      tracks: tracks.length,
      keep: keepers.length,
      deleteFiles: deleteIds.size,
      rematchPlanEntries: rematch.length,
      rename: planned.filter((p) => p.srcRel !== p.destRel).length,
      alreadyNamed: planned.filter((p) => p.srcRel === p.destRel).length,
      collisions: collisions.length,
      copyFolders: [...copyTops],
      leftoverInCopyFolders: extrasInCopy.length,
    },
    null,
    2,
  ),
);
console.log("=== releases ===");
for (const row of releasePreview) {
  console.log(JSON.stringify(row));
}
if (collisions.length > 0) {
  console.log("=== collisions ===");
  for (const row of collisions) {
    console.log(JSON.stringify({ src: row.srcRel, dest: row.destRel }));
  }
}
console.log("=== deletes ===");
for (const rel of deleteRels.sort()) {
  console.log(rel);
}

if (collisions.length > 0) {
  db.close();
  throw new Error("destination collisions; refusing to continue");
}

if (!apply) {
  db.close();
  console.log("dry-run only; pass --apply to delete copies and rename");
  process.exit(0);
}

const backup = `${dbPath}.pre-normalize`;
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();
copyFileSync(dbPath, backup);

const live = openDatabase(dbPath);
const rematchStmt = live.prepare("UPDATE set_plan_entries SET track_id = ? WHERE track_id = ?");
const deleteTrackStmt = live.prepare("DELETE FROM tracks WHERE id = ?");
const updatePathStmt = live.prepare("UPDATE tracks SET file_path = ?, updated_at = ? WHERE id = ?");

const txn = live.transaction(() => {
  for (const pair of rematch) {
    rematchStmt.run(pair.to, pair.from);
  }
  for (const id of deleteIds) {
    deleteTrackStmt.run(id);
  }
});
txn();

for (const rel of deleteRels) {
  const abs = path.join(root, rel);
  if (existsSync(abs)) {
    unlinkSync(abs);
  }
}

for (const folder of copyTops) {
  const abs = path.join(root, folder);
  if (existsSync(abs)) {
    rmSync(abs, { recursive: true, force: true });
  }
}

const staging = path.join(root, "__crate_normalize_tmp__");
mkdirSync(staging, { recursive: true });
const staged: Array<{ id: string; stagedAbs: string; destAbs: string; destRel: string }> = [];
for (const item of planned) {
  if (!existsSync(item.srcAbs)) {
    throw new Error(`missing source after delete: ${item.srcRel}`);
  }
  const stagedAbs = path.join(staging, `${item.id}${path.extname(item.srcAbs)}`);
  mkdirSync(path.dirname(item.destAbs), { recursive: true });
  renameSync(item.srcAbs, stagedAbs);
  staged.push({ id: item.id, stagedAbs, destAbs: item.destAbs, destRel: item.destRel });
}

const now = new Date().toISOString();
for (const item of staged) {
  mkdirSync(path.dirname(item.destAbs), { recursive: true });
  renameSync(item.stagedAbs, item.destAbs);
  updatePathStmt.run(item.destAbs, now, item.id);
}
rmSync(staging, { recursive: true, force: true });

const albumDestByOldTop = new Map<string, string>();
for (const item of planned) {
  if (!item.srcRel.includes("/")) {
    continue;
  }
  albumDestByOldTop.set(topFolder(item.srcRel), path.join(root, albumDirFromDest(item.destRel)));
}

let coversMoved = 0;
let junkDeleted = 0;
for (const [oldTop, albumAbs] of albumDestByOldTop) {
  const oldAbs = path.join(root, oldTop);
  if (!existsSync(oldAbs)) {
    continue;
  }
  const leftovers = walkFiles(oldAbs);
  const images = leftovers.filter((file) => {
    const ext = path.extname(file).toLowerCase();
    return ext === ".jpg" || ext === ".jpeg" || ext === ".png";
  });
  images.sort((a, b) => {
    const score = (file: string): number => {
      const base = path.basename(file).toLowerCase();
      if (
        base === "folder.jpg" ||
        base === "cover.jpg" ||
        base === "folder.png" ||
        base === "cover.png"
      ) {
        return 0;
      }
      return 1;
    };
    return score(a) - score(b) || statSync(b).size - statSync(a).size;
  });
  const cover = images[0];
  if (cover) {
    const ext = path.extname(cover).toLowerCase() === ".png" ? ".png" : ".jpg";
    const destCover = path.join(albumAbs, `cover${ext}`);
    mkdirSync(albumAbs, { recursive: true });
    if (!existsSync(destCover)) {
      renameSync(cover, destCover);
      coversMoved += 1;
    } else {
      unlinkSync(cover);
    }
  }
  const scansDir = path.join(albumAbs, "scans");
  for (const image of images.slice(1)) {
    if (!existsSync(image)) {
      continue;
    }
    mkdirSync(scansDir, { recursive: true });
    const dest = path.join(
      scansDir,
      sanitizeSegment(path.parse(image).name) + path.extname(image).toLowerCase(),
    );
    if (!existsSync(dest)) {
      renameSync(image, dest);
    } else {
      unlinkSync(image);
    }
  }
  for (const file of leftovers) {
    if (!existsSync(file)) {
      continue;
    }
    if (AUDIO_EXT.has(path.extname(file).toLowerCase())) {
      continue;
    }
    unlinkSync(file);
    junkDeleted += 1;
  }
}

const oldDirs = new Set<string>();
for (const item of planned) {
  oldDirs.add(path.dirname(item.srcAbs));
}
for (const dir of [...oldDirs].sort((a, b) => b.length - a.length)) {
  removeEmptyDirs(dir, root);
}

writeFileSync(
  path.join(path.dirname(dbPath), "library-normalize-journal.json"),
  JSON.stringify(
    {
      at: now,
      keep: keepers.length,
      deleted: deleteIds.size,
      rematch,
      renamed: planned.map((p) => ({ id: p.id, from: p.srcRel, to: p.destRel })),
    },
    null,
    2,
  ),
);

live.close();
console.log(
  JSON.stringify({
    applied: true,
    backup: path.basename(backup),
    keep: keepers.length,
    deleted: deleteIds.size,
    coversMoved,
    junkDeleted,
  }),
);
