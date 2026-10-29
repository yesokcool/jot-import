/*
 * The attachment links Jot writes into a zipped export
 * (`ExportBuilder.textWithAttachmentMarkers`), and rewriting them once the
 * files are in the vault. Photos and drawings are Markdown images,
 * `![name](media/<id>.<ext>)`; videos and other files are a marker,
 * `[video: media/<id>.<ext>]`, `[file: media/<id>.<ext>]`. Pure.
 */

/** `![alt](media/file)`; the alt text may hold "]" as long as "(media/" doesn't follow it. */
const IMAGE = /!\[((?:[^\]\n]|\](?!\(media\/))*)\]\((media\/[^)\s/]+)\)/g;
/** `[video: media/file]`, `[file: media/file]`. */
const MARKER = /\[([a-z]+): (media\/[^\]\s/]+)\]/g;

/** Every "media/…" path the text's attachment links use, once each, in order. */
export function mediaRefs(text: string): string[] {
  const found: Array<{ at: number; ref: string }> = [];
  for (const m of text.matchAll(IMAGE)) found.push({ at: m.index ?? 0, ref: m[2] });
  for (const m of text.matchAll(MARKER)) found.push({ at: m.index ?? 0, ref: m[2] });
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.ref))];
}

/**
 * The text with each attachment link replaced. `link(ref, embed, alt)`
 * gives a link to where that file now is (without the "!", which is kept
 * for images), or null to leave that one as Jot wrote it. A marker keeps
 * its words: `[video: <link>]`.
 */
export function rewriteMediaRefs(text: string, link: (ref: string, embed: boolean, alt: string) => string | null): string {
  return text
    .replace(IMAGE, (whole: string, alt: string, ref: string) => {
      const to = link(ref, true, alt);
      return to === null ? whole : `!${to}`;
    })
    .replace(MARKER, (whole: string, kind: string, ref: string) => {
      const to = link(ref, false, "");
      return to === null ? whole : `[${kind}: ${to}]`;
    });
}

/** The file name a "media/…" path ends in. */
export function mediaName(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

/**
 * An image's alt text as a link's display text, or undefined when it adds
 * nothing (Jot writes the file name when the photo has no name of its own)
 * or would read as a size in an Obsidian embed ("300", "300x200").
 */
export function usefulAlt(alt: string, ref: string): string | undefined {
  const text = alt.trim();
  if (text.length === 0 || text === mediaName(ref) || /^\d+(x\d+)?$/.test(text)) return undefined;
  // "|", "[" and "]" would end a wikilink's display text early.
  return /[|[\]]/.test(text) ? undefined : text;
}
