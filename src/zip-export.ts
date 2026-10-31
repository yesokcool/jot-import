/*
 * Finds the Jot export and its attachments in a zip. An export with attachments is shared as a zip holding
 * one folder: `<name>/<name>.md` plus `<name>/media/<file>`, which the jots link to (see media.ts).
 */

import { isJotExport } from "./format.ts";
import { looksLikeExportName, type MediaSource } from "./importer.ts";
import { mediaRefs } from "./media.ts";
import { canInflate, readZipDirectory, readZipEntry, ZIP_LIMITS, type ZipEntry, ZipError, type ZipLimits } from "./zip.ts";

export interface ZipExport {
  text: string;
  textPath: string;
  /** The files the jots link to, keyed by the path the jots use ("media/…"). */
  media: Map<string, ZipEntry>;
  /** Whether the zip holds only the export and its media folder. Only such a zip is trashed after import. */
  onlyExport: boolean;
  /** Files in the media folder that no jot links to, so they aren't imported and the zip is kept. */
  unlinked: number;
  read(entry: ZipEntry): Promise<Uint8Array>;
}

/**
 * The export inside a zip; throws a ZipError saying why there isn't a usable one. Only the Markdown is
 * unpacked here; media is read later, one file at a time, once the import goes ahead.
 */
export async function openZipExport(data: Uint8Array, limits: ZipLimits = ZIP_LIMITS): Promise<ZipExport> {
  const entries = readZipDirectory(data, limits).filter((e) => !isMacMetadata(e.name));
  // Checked up front so an import never fails halfway, after some jots went in.
  if (entries.some((e) => e.method === 8) && !canInflate()) {
    throw new ZipError("This device can't unzip files. Unzip the Jot export first. Then import the .md file inside it.");
  }
  const texts = entries
    .filter((e) => /\.md$/i.test(e.name))
    .sort((a, b) => depth(a.name) - depth(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const decoder = new TextDecoder("utf-8");
  for (const entry of texts) {
    if (entry.size > limits.textBytes) continue;
    const text = decoder.decode(await readZipEntry(data, entry));
    if (!isJotExport(text)) continue;

    // The jots' paths are relative to the Markdown file's folder.
    const folder = entry.name.slice(0, entry.name.lastIndexOf("/") + 1);
    const byPath = new Map(entries.filter((e) => e.name.startsWith(folder)).map((e) => [e.name.slice(folder.length), e]));
    const media = new Map<string, ZipEntry>();
    let total = entry.size;
    for (const ref of mediaRefs(text, (ref) => byPath.has(ref))) {
      const file = byPath.get(ref);
      if (!file || media.has(ref)) continue;
      total += file.size;
      media.set(ref, file);
    }
    if (total > limits.totalBytes) throw new ZipError("The attachments in the Jot export are too large to import together.");
    const inMedia = (e: ZipEntry) => e.name.startsWith(`${folder}media/`);
    const linked = new Set(media.values());
    return {
      text,
      textPath: entry.name,
      media,
      onlyExport: entries.every((e) => e === entry || inMedia(e)),
      unlinked: entries.filter((e) => inMedia(e) && !linked.has(e)).length,
      read: (e) => readZipEntry(data, e),
    };
  }
  // Say which kind of zip it is instead, so the fix is clear: both of Jot's zips are named "jot-export-…".
  if (entries.some((e) => /(^|\/)jot-data\.json$/i.test(e.name))) throw new ZipError(ALL_MY_DATA);
  if (entries.some((e) => /\.(md|txt)$/i.test(e.name) && looksLikeExportName(baseName(e.name)))) throw new ZipError(NOT_OBSIDIAN_FORMAT);
  throw new ZipError("There's no Jot export in the zip.");
}

/** "Work Jots/Work Jots.txt" → "Work Jots". */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");
}

/** Settings ▸ Export All My Data also writes a "jot-export-….zip", holding `jot-data.json`. */
export const ALL_MY_DATA = "This zip is Jot's All My Data export. Jot Import needs an export from Jot's Export screen with Obsidian Format turned on.";

/** A Jot export without the Obsidian Format markers: a .txt, or a .md from a plain export. */
export const OBSIDIAN_FORMAT_HINT = "Turn on Obsidian Format in Jot's Export ▸ Format and export again.";
export const NOT_OBSIDIAN_FORMAT = `The Jot export inside has no Obsidian Format markers. ${OBSIDIAN_FORMAT_HINT}`;

/** The import's view of a zip's attachments. */
export function zipMedia(zip: ZipExport): MediaSource {
  return {
    has: (ref) => zip.media.has(ref),
    read: (ref) => {
      const entry = zip.media.get(ref);
      if (!entry) throw new ZipError("An attachment is missing from the zip.");
      return zip.read(entry);
    },
  };
}

/** macOS's "__MACOSX/…", "._name" and ".DS_Store" entries hold file and folder metadata, not content. */
function isMacMetadata(name: string): boolean {
  const base = name.slice(name.lastIndexOf("/") + 1);
  return name.startsWith("__MACOSX/") || base.startsWith("._") || base === ".DS_Store";
}

function depth(path: string): number {
  return path.split("/").length;
}
