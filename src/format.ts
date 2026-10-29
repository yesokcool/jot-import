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
 * Jot 1.6 and later; 1.5 wrote `name` only, so it's optional. Attributes, in
 * the header and the category markers alike, may come in any order and
 * unknown ones are ignored, which is what lets the format grow without a
 * version bump. Everything outside a category block is ignored, so stats
 * lines, workspace headers and separators never reach a note.
 *
 * Jot doesn't escape jot text, so a jot can hold marker text itself. An
 * export whose markers don't pair up (or whose last category never ends, or
 * that has a category without a name) gets a `problem` and is not imported,
 * rather than losing the jots the markers would cut off.
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
  /** Why importing this text could lose jots (one sentence), or null when it's sound. */
  problem: string | null;
}

export const SUPPORTED_VERSION = 1;

const VALUE = String.raw`"(?:[^"\\]|\\.)*"|[^\s"]+`;
const KEY = "[A-Za-z0-9_-]+";
const HEADER = new RegExp(String.raw`<!--\s*jot:export((?:\s+${KEY}=(?:${VALUE}))*)\s*-->`);
const BLOCK = new RegExp(
  String.raw`<!--\s*jot:category((?:\s+${KEY}=(?:${VALUE}))+)\s*-->\r?\n?([\s\S]*?)\r?\n?<!--\s*\/jot:category\s*-->`,
  "g",
);
const ATTRIBUTE = new RegExp(String.raw`(${KEY})=(${VALUE})`, "g");
/** Any opening or closing marker, readable or not, to check that they pair up. */
const OPEN = /<!--\s*jot:category\b/g;
const CLOSE = /<!--\s*\/jot:category\s*-->/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether the text has a Jot export header with a version (in its first 512 chars). */
export function isJotExport(text: string): boolean {
  return readHeader(text) !== null;
}

/**
 * Parse a Jot export. Returns null when the header is missing or from a
 * newer envelope version than this plugin understands. Blocks with an
 * empty body are dropped; anything that would drop jots is a `problem`.
 */
export function parseJotExport(text: string): JotExport | null {
  const header = readHeader(text);
  if (!header || header.version > SUPPORTED_VERSION) return null;

  const blocks: JotBlock[] = [];
  let matched = 0;
  let problem: string | null = null;
  for (const match of text.matchAll(BLOCK)) {
    matched++;
    const attributes = parseAttributes(match[1]);
    const body = trimBlankLines(match[2].replace(/\r\n/g, "\n"));
    if (body.length === 0) continue;
    const name = attributes.get("name");
    if (name === undefined || name.trim().length === 0) {
      problem ??= "A category in it has no name Jot Import can read.";
      continue;
    }
    const id = attributes.get("id");
    blocks.push({ name, id: id !== undefined && UUID.test(id) ? id.toUpperCase() : null, body });
  }
  return { version: header.version, date: header.date, blocks, problem: problem ?? markerProblem(text, matched) };
}

/**
 * Whether the text is an export and nothing else: the header comes first and
 * only blank lines follow the last category. Only such a file is trashed
 * after importing; a note the export was pasted into keeps its other text.
 */
export function isWholeExport(text: string): boolean {
  const head = HEADER.exec(text.slice(0, 512));
  if (!head || text.slice(0, head.index).trim().length > 0) return false;
  const closes = [...text.matchAll(CLOSE)];
  const last = closes[closes.length - 1];
  return last !== undefined && text.slice((last.index ?? 0) + last[0].length).trim().length === 0;
}

function readHeader(text: string): { version: number; date: string | null } | null {
  const head = HEADER.exec(text.slice(0, 512));
  if (!head) return null;
  const attributes = parseAttributes(head[1]);
  const version = attributes.get("v");
  if (version === undefined || !/^\d+$/.test(version)) return null;
  return { version: Number(version), date: attributes.get("date") ?? null };
}

/** Null when every marker belongs to a category that was read, else what's wrong. */
function markerProblem(text: string, matched: number): string | null {
  const opens = [...text.matchAll(OPEN)].map((m) => m.index ?? 0);
  const closes = [...text.matchAll(CLOSE)].map((m) => m.index ?? 0);
  if (opens.length === matched && closes.length === matched) return null;
  const lastOpen = opens.length > 0 ? opens[opens.length - 1] : -1;
  const lastClose = closes.length > 0 ? closes[closes.length - 1] : -1;
  return lastOpen > lastClose
    ? "Its last category never ends, so the file may be cut short."
    : "Its category markers don't pair up, maybe because a jot contains marker text.";
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
 * one note rather than a folder. Leading dots go too (Obsidian hides such
 * files, so ".NET" would be written and then never found), Windows' device
 * names get a "_" (on every platform, so a synced vault agrees), and the
 * name stops at 200 bytes. Composed Unicode (NFC), like Obsidian's paths.
 *
 * A name that cleans to nothing ("?", "**", "...") is spelled out instead,
 * "Question mark", "Asterisk asterisk", "Dot dot dot": each such category
 * keeps a note of its own, the same one every time, rather than all of
 * them sharing "Untitled.md", Obsidian's name for any new note.
 */
export function noteNameFor(category: string): string {
  const cleaned = clipBytes(
    category
      .normalize("NFC")
      .replace(/[\\/:]+/g, "-")
      .replace(/[*"<>|?#^[\]]/g, "")
      .replace(/\s+/g, " ")
      .replace(/^[. ]+/, "")
      .replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?=\.|$)/i, "$1_"),
    200,
  ).replace(/[. ]+$/g, "");
  if (cleaned.length > 0) return cleaned;
  const spelled = [...category].flatMap((ch) => SYMBOL_NAMES[ch] ?? []).join(" ");
  // Only blank names are left, and the parser refuses those.
  if (spelled.length === 0) return "Unnamed category";
  return clipBytes(spelled[0].toUpperCase() + spelled.slice(1), 200).replace(/ +$/, "");
}

/** What noteNameFor calls each character it drops, for a name made of nothing else. */
const SYMBOL_NAMES: Record<string, string> = {
  "*": "asterisk",
  '"': "quote",
  "<": "less than",
  ">": "greater than",
  "|": "vertical bar",
  "?": "question mark",
  "#": "hash",
  "^": "caret",
  "[": "left bracket",
  "]": "right bracket",
  ".": "dot",
};

/** The longest prefix of `s` (whole code points) that fits in `max` UTF-8 bytes. */
function clipBytes(s: string, max: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes > max) break;
    end += ch.length;
  }
  return s.slice(0, end);
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
 * "Top" means after frontmatter and after the note's title, a "# Title"
 * that is its first line of text (or right under the heading); "bottom"
 * means the end of the note (or the end of that heading's section). A
 * missing heading is appended at the end of the note first. A leading
 * byte-order mark is dropped (see `withoutBom`).
 */
export function insertIntoNote(existing: string, chunk: string, opts: InsertOptions): string {
  const text = withoutBom(existing).replace(/\r\n/g, "\n");
  const piece = closeFences(trimBlankLines(chunk.replace(/\r\n/g, "\n")));
  if (piece.length === 0) return text;

  const heading = parseHeadingSetting(opts.heading);
  if (!heading) {
    return opts.position === "top" ? insertAtTop(text, piece) : appendAtBottom(text, piece);
  }

  const lines = text.length === 0 ? [] : text.split("\n");
  // Headings are looked for below the properties only, and outside code.
  const fm = frontmatterLength(text);
  const bodyStart = fm > 0 ? text.slice(0, fm).split("\n").length : 0;
  const { code } = codeLines(lines, bodyStart);
  const found = findHeading(lines, heading.text, bodyStart, code);
  if (!found) {
    const headingLine = "#".repeat(heading.level) + " " + heading.text;
    return appendAtBottom(text, headingLine + "\n\n" + piece);
  }

  const sectionStart = found.index + 1;
  let sectionEnd = lines.length;
  for (let i = sectionStart; i < lines.length; i++) {
    if (code[i]) continue;
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

/**
 * The note's text without a leading byte-order mark (U+FEFF, which some
 * editors write first). Obsidian passes the mark through, and with it in
 * front neither the properties check here nor Obsidian's own property
 * editing sees the properties: "top" would land above them and a new link
 * would add a second block. Dropped, not kept, so both agree; in UTF-8 the
 * mark says nothing.
 */
export function withoutBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
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
  // A note that opens with a "# Title" keeps it first: the jots go under
  // the title, not above it (since 1.1, when "top" became the default).
  const firstLine = rest.split("\n", 1)[0];
  const title = headingLevel(firstLine) === 1 ? firstLine : null;
  const after = title === null ? rest : trimBlankLines(rest.slice(firstLine.length));
  const below = after.length === 0 ? piece : piece + "\n\n" + after;
  const body = title === null ? below : title + "\n\n" + below;
  return ensureTrailingNewline(front.length === 0 ? body : front + "\n" + body);
}

/**
 * Length of a leading YAML frontmatter block including its closing line (0
 * if none), by Obsidian's own rule: `---` alone on the first line and alone
 * on a later one. "..." or "--- " don't close it.
 */
function frontmatterLength(text: string): number {
  if (!text.startsWith("---\n")) return 0;
  const close = /\n---(?:\n|$)/g;
  close.lastIndex = 3;
  const m = close.exec(text);
  return m ? m.index + 4 : 0;
}

/**
 * Which lines (from `start` on) are fenced code, fences included, and the
 * fence still open after the last line, if any. A fence closes only with
 * the same character, at least as many of them, and nothing else on the
 * line, so ~~~ inside a ``` block is still code.
 */
function codeLines(lines: string[], start: number): { code: boolean[]; open: { fence: string; indent: string } | null } {
  const code = lines.map(() => false);
  let open: { fence: string; indent: string } | null = null;
  for (let i = start; i < lines.length; i++) {
    const m = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (open) {
      code[i] = true;
      if (m && m[2][0] === open.fence[0] && m[2].length >= open.fence.length && m[3].trim().length === 0) open = null;
    } else if (m && !(m[2][0] === "`" && m[3].includes("`"))) {
      // (A ``` line with a ` after it is inline code, not a fence.)
      code[i] = true;
      open = { fence: m[2], indent: m[1] };
    }
  }
  return { code, open };
}

/**
 * `piece` with a closing fence added when a code fence in it never closes
 * (a jot like "look:\n```\ncode"). Left open, it would turn the rest of the
 * note into code, and a later import under a heading would miss the next
 * heading. Closed with the opening's characters and indent, so a fence
 * inside a list item closes there.
 */
function closeFences(piece: string): string {
  const { open } = codeLines(piece.split("\n"), 0);
  return open ? `${piece}\n${open.indent}${open.fence}` : piece;
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

function findHeading(lines: string[], text: string, start: number, code: boolean[]): { index: number; level: number } | null {
  const wanted = text.toLowerCase();
  for (let i = start; i < lines.length; i++) {
    if (code[i]) continue;
    const level = headingLevel(lines[i]);
    if (level === null) continue;
    if (headingText(lines[i]).toLowerCase() === wanted) return { index: i, level };
  }
  return null;
}

/** The heading a heading setting names, without the #s that set its level ("### Inbox" is "Inbox"); "" for none. */
export function headingName(setting: string): string {
  return parseHeadingSetting(setting)?.text ?? "";
}

function parseHeadingSetting(setting: string): { text: string; level: number } | null {
  const raw = setting.trim();
  if (raw.length === 0) return null;
  const m = /^(#{1,6})\s*(.*)$/.exec(raw);
  const text = (m ? m[2] : raw).trim();
  if (text.length === 0) return null;
  return { text, level: m ? m[1].length : 2 };
}
