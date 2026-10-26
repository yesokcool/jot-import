/*
 * The Jot export format and the note-insertion rules — pure functions, no
 * Obsidian imports, so they can be unit-tested with plain Node.
 *
 * The envelope is written by Jot's `ExportBuilder.ObsidianEnvelope`
 * (jot/Utility/ExportBuilder.swift). Change both sides together.
 *
 *   <!-- jot:export v=1 date=2026-09-14T10:22:05Z -->
 *   Stats: 3 jots across 2 categories          (optional, ignored)
 *   <!-- jot:category name="Ideas" id="0D4C…" -->
 *   - build the obsidian thing
 *   - rename the workspaces screen
 *   <!-- /jot:category -->
 *   <!-- jot:category name="Work" id="9A1E…" -->
 *   …
 *   <!-- /jot:category -->
 *
 * `name` is a JSON string literal. `id` is the category's UUID, written by
 * Jot 1.6 and later; 1.5 wrote `name` only, so it's optional. Attributes may
 * come in any order and unknown ones are ignored, which is what lets the
 * format grow without a version bump. Everything outside a category block is
 * ignored, so stats lines, workspace headers and separators never reach a
 * note.
 */

export interface JotBlock {
  /** The category name, exactly as Jot has it. */
  name: string;
  /** The category's id, upper-case, or null for exports from before Jot 1.6. */
  id: string | null;
  /** The jots, formatted the way the user's export settings render them. */
  body: string;
}

export interface JotExport {
  version: number;
  date: string | null;
  blocks: JotBlock[];
}

export const SUPPORTED_VERSION = 1;

const HEADER = /<!--\s*jot:export\s+v=(\d+)(?:\s+date=(\S+?))?\s*-->/;
const VALUE = String.raw`"(?:[^"\\]|\\.)*"|[^\s"]+`;
const BLOCK = new RegExp(
  String.raw`<!--\s*jot:category((?:\s+[a-z-]+=(?:${VALUE}))+)\s*-->\r?\n?([\s\S]*?)\r?\n?<!--\s*\/jot:category\s*-->`,
  "g",
);
const ATTRIBUTE = new RegExp(String.raw`([a-z-]+)=(${VALUE})`, "g");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether the text starts with a Jot export header (first 512 chars). */
export function isJotExport(text: string): boolean {
  return HEADER.test(text.slice(0, 512));
}

/**
 * Parse a Jot export. Returns null when the header is missing or from a
 * newer envelope version than this plugin understands. Blocks with an
 * empty body are dropped.
 */
export function parseJotExport(text: string): JotExport | null {
  const head = HEADER.exec(text.slice(0, 512));
  if (!head) return null;
  const version = Number(head[1]);
  if (!Number.isFinite(version) || version > SUPPORTED_VERSION) return null;

  const blocks: JotBlock[] = [];
  for (const match of text.matchAll(BLOCK)) {
    const attributes = parseAttributes(match[1]);
    const name = attributes.get("name");
    if (name === undefined) continue;
    const body = trimBlankLines(match[2].replace(/\r\n/g, "\n"));
    if (name.trim().length === 0 || body.length === 0) continue;
    const id = attributes.get("id");
    blocks.push({ name, id: id !== undefined && UUID.test(id) ? id.toUpperCase() : null, body });
  }
  return { version, date: head[2] ?? null, blocks };
}

/** `key="json string"` or `key=bare` pairs; a quoted value that isn't valid JSON is dropped. */
function parseAttributes(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, key, raw] of source.matchAll(ATTRIBUTE)) {
    if (out.has(key)) continue;
    if (!raw.startsWith('"')) {
      out.set(key, raw);
      continue;
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value === "string") out.set(key, value);
    } catch {
      // Not a string Jot wrote; leave the attribute out.
    }
  }
  return out;
}

/**
 * The note basename for a category. Obsidian refuses `* " \ / < > : | ?` in
 * file names and can't link to names holding `# ^ [ ]`, so those are
 * replaced or dropped. Path separators become "-" so "Work / Life" stays
 * one note rather than a folder.
 */
export function noteNameFor(category: string): string {
  const cleaned = category
    .replace(/[\\/:]+/g, "-")
    .replace(/[*"<>|?#^[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return cleaned.length > 0 ? cleaned : "Untitled";
}

export type Position = "top" | "bottom";

export interface InsertOptions {
  position: Position;
  /** A heading to insert under; "" means the note itself. Leading #s set the level used when it has to be created (default 2). */
  heading: string;
}

/**
 * Insert `chunk` into `existing` per the options and return the new note
 * text. The chunk is separated from its neighbours by one blank line.
 * "Top" means after frontmatter (or right under the heading); "bottom"
 * means the end of the note (or the end of that heading's section). A
 * missing heading is appended at the end of the note first.
 */
export function insertIntoNote(existing: string, chunk: string, opts: InsertOptions): string {
  const text = existing.replace(/\r\n/g, "\n");
  const piece = trimBlankLines(chunk.replace(/\r\n/g, "\n"));
  if (piece.length === 0) return text;

  const heading = parseHeadingSetting(opts.heading);
  if (!heading) {
    return opts.position === "top" ? insertAtTop(text, piece) : appendAtBottom(text, piece);
  }

  const lines = text.length === 0 ? [] : text.split("\n");
  const found = findHeading(lines, heading.text);
  if (!found) {
    const headingLine = "#".repeat(heading.level) + " " + heading.text;
    return appendAtBottom(text, headingLine + "\n\n" + piece);
  }

  const sectionStart = found.index + 1;
  let sectionEnd = lines.length;
  let inFence = false;
  for (let i = sectionStart; i < lines.length; i++) {
    if (isFence(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const level = headingLevel(lines[i]);
    if (level !== null && level <= found.level) {
      sectionEnd = i;
      break;
    }
  }

  const before = lines.slice(0, sectionStart);
  const section = lines.slice(sectionStart, sectionEnd);
  const after = lines.slice(sectionEnd);
  const rawSection = section.join("\n");
  // Keep the note's own blank line(s) after the heading, if it has any;
  // a heading that had none stays tight, a new section gets one.
  const leadingBlank = /^(?:[ \t]*\n)+/.exec(rawSection)?.[0] ?? "";
  const sectionText = trimBlankLines(rawSection);

  let newSection: string;
  if (sectionText.length === 0) {
    newSection = (leadingBlank || "\n") + piece;
  } else if (opts.position === "top") {
    newSection = leadingBlank + piece + "\n\n" + sectionText;
  } else {
    newSection = leadingBlank + sectionText + "\n\n" + piece;
  }

  const parts: string[] = [before.join("\n"), newSection];
  if (after.length > 0) parts.push("", after.join("\n"));
  return ensureTrailingNewline(parts.join("\n"));
}

// MARK: - Helpers

function trimBlankLines(s: string): string {
  return s.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}

function appendAtBottom(text: string, piece: string): string {
  // A note that is only frontmatter (a new linked note): go right under it.
  const fm = frontmatterLength(text);
  if (fm > 0 && text.slice(fm).trim().length === 0) return insertAtTop(text, piece);
  const body = text.replace(/\s+$/, "");
  return ensureTrailingNewline(body.length === 0 ? piece : body + "\n\n" + piece);
}

function insertAtTop(text: string, piece: string): string {
  const fm = frontmatterLength(text);
  const front = text.slice(0, fm);
  const rest = trimBlankLines(text.slice(fm));
  const body = rest.length === 0 ? piece : piece + "\n\n" + rest;
  return ensureTrailingNewline(front.length === 0 ? body : front + "\n" + body);
}

/** Length of a leading YAML frontmatter block including its closing line (0 if none). */
function frontmatterLength(text: string): number {
  if (!text.startsWith("---\n")) return 0;
  const close = /\n(---|\.\.\.)[ \t]*(?:\n|$)/g;
  close.lastIndex = 3;
  const m = close.exec(text);
  if (!m) return 0;
  return m.index + 1 + m[1].length;
}

function isFence(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

function headingLevel(line: string): number | null {
  const m = /^(#{1,6})\s+\S/.exec(line);
  return m ? m[1].length : null;
}

function headingText(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

function findHeading(lines: string[], text: string): { index: number; level: number } | null {
  const wanted = text.toLowerCase();
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const level = headingLevel(lines[i]);
    if (level === null) continue;
    if (headingText(lines[i]).toLowerCase() === wanted) return { index: i, level };
  }
  return null;
}

function parseHeadingSetting(setting: string): { text: string; level: number } | null {
  const raw = setting.trim();
  if (raw.length === 0) return null;
  const m = /^(#{1,6})\s*(.*)$/.exec(raw);
  const text = (m ? m[2] : raw).trim();
  if (text.length === 0) return null;
  return { text, level: m ? m[1].length : 2 };
}
