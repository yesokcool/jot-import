/*
 * A Jot export shared as a zip. When an export has photos or files, Jot
 * (`ExportFile.materialize`) shares `<stem>.zip` holding one folder:
 *
 *   jot-export-2026-10-28-1540/
 *     jot-export-2026-10-28-1540.md
 *     media/3F2A9C41-….png
 *     media/5D4C3B2A-….pdf
 *
 * and the jots point into it: `![name](media/<file>)` for photos and
 * drawings, `[video: media/<file>]` and `[file: media/<file>]` for the rest
 * (`ExportBuilder.textWithAttachmentMarkers`). This finds the export's
 * Markdown and the files its jots point at. Pure, like zip.ts.
 */

import { isJotExport } from "./format.ts";
import { mediaRefs } from "./media.ts";
import { canInflate, readZipDirectory, readZipEntry, ZIP_LIMITS, type ZipEntry, ZipError, type ZipLimits } from "./zip.ts";

export interface ZipExport {
  /** The export's Markdown. */
  text: string;
  /** Its path inside the zip. */
  textPath: string;
  /** The files the jots point at, by the path the jots use ("media/…"). */
  media: Map<string, ZipEntry>;
  /**
   * Whether the zip holds the export and nothing else: its Markdown and
   * files in the `media/` folder beside it, as Jot makes them. Only such a
   * zip is trashed after importing.
   */
  onlyExport: boolean;
  /** Read one of `media`'s files. */
  read(entry: ZipEntry): Promise<Uint8Array>;
}

/**
 * The export inside a zip, or a ZipError saying why there isn't one Jot
 * Import can use. Only the Markdown is unpacked here; the media is read
 * later, one file at a time, once the import is going ahead. `limits`:
 * the device's (`MOBILE_ZIP_LIMITS` on a phone or tablet).
 */
export async function openZipExport(data: Uint8Array, limits: ZipLimits = ZIP_LIMITS): Promise<ZipExport> {
  const entries = readZipDirectory(data, limits).filter((e) => !isMacMetadata(e.name));
  // Said up front, rather than after some of the jots went in.
  if (entries.some((e) => e.method === 8) && !canInflate()) {
    throw new ZipError("This device can't unzip files. Unzip the export first, then import the .md file inside.");
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
    for (const ref of mediaRefs(text)) {
      const file = byPath.get(ref);
      if (!file || media.has(ref)) continue;
      total += file.size;
      media.set(ref, file);
    }
    if (total > limits.totalBytes) throw new ZipError("The export's attachments are too large to import together.");
    const onlyExport = entries.every((e) => e === entry || e.name.startsWith(`${folder}media/`));
    return { text, textPath: entry.name, media, onlyExport, read: (e) => readZipEntry(data, e) };
  }
  throw new ZipError("There's no Jot export in the zip.");
}

/** Finder's "__MACOSX/…" and "._name" files, which hold Mac file metadata, not content. */
function isMacMetadata(name: string): boolean {
  return name.startsWith("__MACOSX/") || name.slice(name.lastIndexOf("/") + 1).startsWith("._");
}

function depth(path: string): number {
  return path.split("/").length;
}
