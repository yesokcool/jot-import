/*
 * Attachment links in a zipped Jot export, and rewriting them once the files are in the vault.
 * Images are `![name](media/<file>)`; other files are `[video: media/<file>]` or `[file: media/<file>]`.
 * A file keeps the extension it came with, which can hold spaces, ")" or "]", so where a link could end
 * in more than one place, the end that names a file in the zip wins.
 */

/** Up to "media/"; the file name and the link's end are found by `mediaLinks`. The alt text may hold "]". */
const IMAGE = /!\[((?:[^\]\n]|\](?!\(media\/))*)\]\(media\//g;
const MARKER = /\[([a-z]+): media\//g;

interface MediaLink {
  start: number;
  end: number;
  ref: string;
  embed: boolean;
  /** The image's alt text, or the marker's kind ("video"). */
  label: string;
}

/**
 * Every attachment link, in order. `known` tells which "media/…" paths the zip holds; without it, or when
 * none matches, a link ends at its first ")" or "]". Only files directly in media/ count.
 */
function mediaLinks(text: string, known?: (ref: string) => boolean): MediaLink[] {
  const links: MediaLink[] = [];
  const scan = (pattern: RegExp, close: string, embed: boolean) => {
    for (const m of text.matchAll(pattern)) {
      const start = m.index ?? 0;
      const from = start + m[0].length;
      const lineEnd = text.indexOf("\n", from);
      const rest = text.slice(from, lineEnd === -1 ? text.length : lineEnd);
      let first: MediaLink | null = null;
      let match: MediaLink | null = null;
      for (let i = rest.indexOf(close); i !== -1 && match === null; i = rest.indexOf(close, i + 1)) {
        const name = rest.slice(0, i);
        if (name.includes("/")) break;
        if (name.length === 0) continue;
        const link = { start, end: from + i + 1, ref: `media/${name}`, embed, label: m[1] };
        first ??= link;
        if (known?.(link.ref)) match = link;
      }
      const link = match ?? first;
      if (link) links.push(link);
    }
  };
  scan(IMAGE, ")", true);
  scan(MARKER, "]", false);
  links.sort((a, b) => a.start - b.start);
  // A marker written inside an image's alt text belongs to the image.
  return links.filter((link, i) => i === 0 || link.start >= links[i - 1].end);
}

/** Every "media/…" path the text's attachment links use, once each, in order. */
export function mediaRefs(text: string, known?: (ref: string) => boolean): string[] {
  return [...new Set(mediaLinks(text, known).map((link) => link.ref))];
}

/**
 * Replaces each attachment link with what `link` returns (without the "!", which images keep), or leaves it
 * when that is null. A marker keeps its label: `[video: <link>]`.
 */
export function rewriteMediaRefs(
  text: string,
  link: (ref: string, embed: boolean, alt: string) => string | null,
  known?: (ref: string) => boolean,
): string {
  let out = "";
  let at = 0;
  for (const found of mediaLinks(text, known)) {
    const to = link(found.ref, found.embed, found.embed ? found.label : "");
    if (to === null) continue;
    out += text.slice(at, found.start) + (found.embed ? `!${to}` : `[${found.label}: ${to}]`);
    at = found.end;
  }
  return out + text.slice(at);
}

export function mediaName(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

/**
 * An image's alt text as link display text, or undefined when it's just the file name (Jot's default)
 * or would read as an embed size in Obsidian ("300", "300x200").
 */
export function usefulAlt(alt: string, ref: string): string | undefined {
  const text = alt.trim();
  if (text.length === 0 || text === mediaName(ref) || /^\d+(x\d+)?$/.test(text)) return undefined;
  // "|", "[" and "]" would end a wikilink's display text early.
  return /[|[\]]/.test(text) ? undefined : text;
}
