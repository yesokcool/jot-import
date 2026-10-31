/*
 * Jot's export format and the rules for inserting jots into a note. No Obsidian imports, so tests run in Node.
 * A `<!-- jot:export v=1 -->` header, then `<!-- jot:category name="…" -->` … `<!-- /jot:category -->` blocks;
 * text outside them is ignored. The Jot app writes this in ExportBuilder.swift; change both sides together.
 */

export interface JotBlock {
  name: string;
  /** Upper-case UUID, or null for exports from Jot 1.5, which wrote no ids. */
  id: string | null;
  /** The category's workspace in Jot; null when it has none, and in exports that don't say. */
  workspace: string | null;
  body: string;
}

export interface JotExport {
  version: number;
  date: string | null;
  blocks: JotBlock[];
  /** Why importing could lose jots (one sentence for the notice), or null. */
  problem: string | null;
}

const SUPPORTED_VERSION = 1;

/** An attribute value: a JSON string literal or a bare token. */
const VALUE = String.raw`"(?:[^"\\]|\\.)*"|[^\s"]+`;
const KEY = "[A-Za-z0-9_-]+";
// Inside a marker only spaces and tabs count as space: Jot escapes "<!--" before any whitespace and
// "jot:", but JavaScript's \s also matches characters Swift's doesn't (U+FEFF).
const HEADER = new RegExp(String.raw`<!--[ \t]*jot:export((?:[ \t]+${KEY}=(?:${VALUE}))*)[ \t]*-->`);
const BLOCK = new RegExp(
  String.raw`<!--[ \t]*jot:category((?:[ \t]+${KEY}=(?:${VALUE}))+)[ \t]*-->\r?\n?([\s\S]*?)\r?\n?<!--[ \t]*\/jot:category[ \t]*-->`,
  "g",
);
const ATTRIBUTE = new RegExp(String.raw`(${KEY})=(${VALUE})`, "g");
/** Every marker, readable or not, so markerProblem can check that they pair up. */
const OPEN = /<!--[ \t]*jot:category\b/g;
const CLOSE = /<!--[ \t]*\/jot:category[ \t]*-->/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a versioned Jot export header appears in the first 512 characters. */
export function isJotExport(text: string): boolean {
  return readHeader(text) !== null;
}

/**
 * Null when the header is missing or newer than this plugin supports. Empty blocks are dropped; anything
 * that would lose jots (unpaired markers, a nameless category) sets `problem` so the import is refused.
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
    const workspace = attributes.get("workspace");
    blocks.push({
      name,
      id: id !== undefined && UUID.test(id) ? id.toUpperCase() : null,
      workspace: workspace !== undefined && workspace.trim().length > 0 ? workspace : null,
      body,
    });
  }
  return { version: header.version, date: header.date, blocks, problem: problem ?? markerProblem(text, matched) };
}

/**
 * Whether the text is the export and nothing else: the header first, then only what Jot writes between
 * blocks, and blank lines after the last. Only such a file is trashed after import, so a note the export was
 * pasted into, or one with notes typed between its blocks, is kept.
 */
export function isWholeExport(text: string): boolean {
  const head = HEADER.exec(text.slice(0, 512));
  if (!head || text.slice(0, head.index).trim().length > 0) return false;
  let at = head.index + head[0].length;
  let blocks = 0;
  for (const block of text.matchAll(BLOCK)) {
    const start = block.index ?? 0;
    if (!isJotGap(text.slice(at, start), blocks === 0)) return false;
    at = start + block[0].length;
    blocks++;
  }
  return blocks > 0 && text.slice(at).trim().length === 0;
}

/**
 * Between blocks Jot writes blank lines and at most a workspace's name: a heading, or the name in capitals.
 * Before the first block there can also be the "Stats:" line.
 */
function isJotGap(gap: string, first: boolean): boolean {
  const lines = gap
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const rest = first && lines[0]?.startsWith("Stats: ") ? lines.slice(1) : lines;
  if (rest.length === 0) return true;
  return rest.length === 1 && (/^#{1,6}[ \t]+\S/.test(rest[0]) || rest[0] === rest[0].toUpperCase());
}

function readHeader(text: string): { version: number; date: string | null } | null {
  const head = HEADER.exec(text.slice(0, 512));
  if (!head) return null;
  const attributes = parseAttributes(head[1]);
  const version = attributes.get("v");
  if (version === undefined || !/^\d+$/.test(version)) return null;
  return { version: Number(version), date: attributes.get("date") ?? null };
}

/** Null when every marker belongs to a parsed block, else why not (an older Jot let a jot contain marker text). */
function markerProblem(text: string, matched: number): string | null {
  const opens = [...text.matchAll(OPEN)].map((m) => m.index ?? 0);
  const closes = [...text.matchAll(CLOSE)].map((m) => m.index ?? 0);
  if (opens.length === matched && closes.length === matched) return null;
  const lastOpen = opens.length > 0 ? opens[opens.length - 1] : -1;
  const lastClose = closes.length > 0 ? closes[closes.length - 1] : -1;
  return lastOpen > lastClose
    ? "The last category in the Jot export has no end marker. The file may be cut short."
    : "The category markers in the Jot export don't match up. A jot may contain text that looks like a marker.";
}

/** `key="json string"` or `key=bare` pairs in any order; callers ignore unknown keys so the format can grow. */
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
      // Not valid JSON: leave the attribute out.
    }
  }
  return out;
}

/**
 * A category's note basename, safe as an Obsidian file name and link target, at most 200 bytes. A name that
 * cleans to nothing ("?") is spelled out ("Question mark") so each such category keeps a note of its own.
 */
export function noteNameFor(category: string): string {
  const cleaned = clipBytes(
    category
      .normalize("NFC")
      // "Work / Life" stays one note rather than a folder.
      .replace(/[\\/:]+/g, "-")
      // Not allowed in file names, or breaks wikilinks.
      .replace(/[*"<>|?#^[\]]/g, "")
      .replace(/\s+/g, " ")
      // Control characters: Windows refuses them, and they can't be seen.
      .replace(/\p{Cc}/gu, "")
      // Obsidian hides dotfiles, so ".NET" would be written and never shown.
      .replace(/^[. ]+/, "")
      // Windows device names, changed on every platform so a synced vault agrees.
      .replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?=\.|$)/i, "$1_"),
    200,
  ).replace(/[. ]+$/g, "");
  if (cleaned.length > 0) return cleaned;
  const spelled = [...category].flatMap((ch) => SYMBOL_NAMES[ch] ?? []).join(" ");
  // Only a blank name gets here, and the parser refuses those.
  if (spelled.length === 0) return "Unnamed category";
  return clipBytes(spelled[0].toUpperCase() + spelled.slice(1), 200).replace(/ +$/, "");
}

/** Spoken names for the characters noteNameFor drops. */
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
  /** Heading to insert under, or "" for none. Leading #s set the level if it must be created (default 2). */
  heading: string;
  /** Where to add a heading the note lacks: the end (default) or the top, right after the properties. */
  newHeading?: Position;
  /** Default 1. */
  blankLinesBefore?: number;
  /** Default 1. */
  blankLinesAfter?: number;
  /** A line above the jots, already filled in by fillMarker; "" for none. */
  startMarker?: string;
  endMarker?: string;
}

/**
 * Returns `existing` with `chunk` inserted. Under a heading only when one is chosen: "top" is right under it, or
 * with none, right after the properties; "bottom" is the end of the heading's section or of the note.
 * A note with Windows line endings keeps them.
 */
export function insertIntoNote(existing: string, chunk: string, opts: InsertOptions): string {
  const text = withoutBom(existing).replace(/\r\n/g, "\n");
  const jots = closeFences(trimBlankLines(chunk.replace(/\r\n/g, "\n")));
  let result = jots.length === 0 ? text : insertPiece(text, withMarkers(jots, opts), opts);
  // A "---" marker line at the very top would read as frontmatter; a leading blank line prevents that.
  if (frontmatterLength(text) === 0 && frontmatterLength(result) > 0) result = "\n" + result;
  return existing.includes("\r\n") ? result.replace(/\n/g, "\r\n") : result;
}

function insertPiece(text: string, piece: string, opts: InsertOptions): string {
  const above = blankLines(opts.blankLinesBefore);
  const below = blankLines(opts.blankLinesAfter);
  const heading = parseHeadingSetting(opts.heading);
  if (!heading) return opts.position === "top" ? insertAtTop(text, piece, "\n" + below) : appendAtBottom(text, piece, "\n" + above);

  const lines = text.length === 0 ? [] : text.split("\n");
  // Only headings below the frontmatter and outside code count.
  const fm = frontmatterLength(text);
  const bodyStart = fm > 0 ? text.slice(0, fm).split("\n").length : 0;
  const { code } = codeLines(lines, bodyStart);
  const found = findHeading(lines, heading.text, bodyStart, code);
  if (!found) {
    const section = "#".repeat(heading.level) + " " + heading.text + "\n" + above + piece;
    return opts.newHeading === "top" ? insertAtTop(text, section, "\n" + below) : appendAtBottom(text, section, "\n\n");
  }

  const sectionStart = found.end + 1;
  let sectionEnd = lines.length;
  for (let i = sectionStart; i < lines.length; i++) {
    const next = headingAt(lines, i, bodyStart, code);
    if (next !== null && next.level <= found.level) {
      sectionEnd = i;
      break;
    }
  }

  const before = lines.slice(0, sectionStart);
  const section = lines.slice(sectionStart, sectionEnd);
  const after = lines.slice(sectionEnd);
  const rawSection = section.join("\n");
  // Bottom keeps the section's own blank lines under the heading; top replaces them with the configured ones.
  const leadingBlank = /^(?:[ \t]*\n)+/.exec(rawSection)?.[0] ?? "";
  const sectionText = trimBlankLines(rawSection);

  let newSection: string;
  let next = below;
  if (sectionText.length === 0) {
    newSection = above + piece;
  } else if (opts.position === "top") {
    newSection = above + piece + "\n" + below + sectionText;
    next = "\n";
  } else {
    newSection = leadingBlank + sectionText + "\n" + above + piece;
  }

  const parts: string[] = [before.join("\n"), newSection];
  if (after.length > 0) parts.push(next + after.join("\n"));
  return ensureTrailingNewline(parts.join("\n"));
}

/** `count` blank lines (default 1) as line breaks, on top of the one that ends the line above. */
function blankLines(count: number | undefined): string {
  const n = count === undefined || !Number.isFinite(count) ? 1 : Math.min(Math.max(Math.round(count), 0), 9);
  return "\n".repeat(n);
}

/** A blank line separates each marker from the jots so Markdown doesn't merge them into one paragraph. */
function withMarkers(jots: string, opts: InsertOptions): string {
  const start = (opts.startMarker ?? "").trim();
  const end = (opts.endMarker ?? "").trim();
  return [start, jots, end].filter((part) => part.length > 0).join("\n\n");
}

/**
 * Fills `{{date}}` and `{{time}}` in a marker line via `format`, with an optional moment.js pattern
 * (`{{date:YYYY-MM-DD}}`). Line breaks become spaces, since a marker is one line.
 */
export function fillMarker(template: string, format: (kind: "date" | "time", pattern: string | null) => string): string {
  return template
    .replace(/\{\{\s*(date|time)\s*(?::([^}]*))?\}\}/gi, (_, kind: string, pattern: string | undefined) =>
      format(kind.toLowerCase() as "date" | "time", pattern?.trim() || null),
    )
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

/**
 * Drops a leading byte-order mark. Obsidian passes it through, and with it in front neither this file nor
 * Obsidian's property editor sees the frontmatter, so "top" would land above it.
 */
export function withoutBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function trimBlankLines(s: string): string {
  return s.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}

/** `gap` is the line breaks between the note's text and `piece`. */
function appendAtBottom(text: string, piece: string, gap: string): string {
  // A note that is only frontmatter (a newly linked note) gets the jots right below it.
  const fm = frontmatterLength(text);
  if (fm > 0 && text.slice(fm).trim().length === 0) return insertAtTop(text, piece, gap);
  const body = text.replace(/\s+$/, "");
  return ensureTrailingNewline(body.length === 0 ? piece : body + gap + piece);
}

/** Right after the properties. `below` is the line breaks between `piece` and the rest of the note. */
function insertAtTop(text: string, piece: string, below: string): string {
  const fm = frontmatterLength(text);
  const front = text.slice(0, fm);
  const rest = trimBlankLines(text.slice(fm));
  const body = rest.length === 0 ? piece : piece + below + rest;
  return ensureTrailingNewline(front.length === 0 ? body : front + "\n" + body);
}

/**
 * Length of the leading frontmatter including its closing line, or 0. Obsidian's rule: `---` alone on the
 * first line and alone on a later one ("..." and "--- " don't close it).
 */
function frontmatterLength(text: string): number {
  if (!text.startsWith("---\n")) return 0;
  const close = /\n---(?:\n|$)/g;
  close.lastIndex = 3;
  const m = close.exec(text);
  return m ? m.index + 4 : 0;
}

/**
 * Which lines from `start` on are fenced code (fences included), and the fence left open at the end, if any.
 * A fence closes only with the same character, at least as many, and nothing after.
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
      // A ``` line with another ` after it is inline code, not a fence.
      code[i] = true;
      open = { fence: m[2], indent: m[1] };
    }
  }
  return { code, open };
}

/**
 * Closes a fence the jots leave open, which would turn the rest of the note into code and hide its headings.
 * Uses the opening's indent so a fence inside a list item closes there.
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

/**
 * The ATX or setext heading starting at line `i`, or null; `end` is its last line. Setext headings count only in
 * the form Obsidian always reads as one: a single plain paragraph line, first or after a blank line.
 */
function headingAt(lines: string[], i: number, start: number, code: boolean[]): { level: number; text: string; end: number } | null {
  if (code[i]) return null;
  const level = headingLevel(lines[i]);
  if (level !== null) return { level, text: headingText(lines[i]), end: i };
  // Obsidian only takes an underline with no indent and no trailing spaces.
  const underline = i + 1 < lines.length && !code[i + 1] ? /^(=+|-+)$/.exec(lines[i + 1]) : null;
  if (!underline || (i > start && lines[i - 1].trim().length > 0 && !code[i - 1]) || !isPlainTextLine(lines[i])) return null;
  return { level: underline[1][0] === "=" ? 1 : 2, text: lines[i].trim(), end: i + 1 };
}

/** An unindented line that starts a paragraph: not a list item, quote, table row, HTML, fence, rule, math or comment. */
function isPlainTextLine(line: string): boolean {
  if (!/^\S/.test(line) || line.includes("|")) return false;
  return !/^(?:#|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|>|<|`{3,}|~{3,}|[-=_*]+\s*$|\$\$|%%)/.test(line);
}

function findHeading(lines: string[], text: string, start: number, code: boolean[]): { level: number; end: number } | null {
  const wanted = text.toLowerCase();
  for (let i = start; i < lines.length; i++) {
    const heading = headingAt(lines, i, start, code);
    if (heading !== null && heading.text.toLowerCase() === wanted) return { level: heading.level, end: heading.end };
  }
  return null;
}

/** A heading setting's text without its level ("### Inbox" is "Inbox"), or "" for none. */
export function headingName(setting: string): string {
  return parseHeadingSetting(setting)?.text ?? "";
}

/**
 * Resolves dialog input against the note's headings. An exact match is that heading even if it starts with "#"
 * ("#1 picks"), so its setting gets a level prefix ("## #1 picks"); anything else is kept as typed.
 */
export function headingSettingFor(
  typed: string,
  headings: Array<{ heading: string; level: number }>,
): { setting: string; name: string; existing: boolean } {
  const raw = typed.trim();
  const exact = headings.find((h) => h.heading.trim().toLowerCase() === raw.toLowerCase());
  if (raw.length > 0 && exact) {
    const setting = raw.startsWith("#") ? `${"#".repeat(Math.min(Math.max(exact.level, 1), 6))} ${exact.heading.trim()}` : raw;
    return { setting, name: headingName(setting), existing: true };
  }
  const name = headingName(raw);
  const wanted = name.toLowerCase();
  return { setting: raw, name, existing: name.length > 0 && headings.some((h) => h.heading.trim().toLowerCase() === wanted) };
}

/** The dialog's Heading box text for a setting: "## Inbox" shows "Inbox", but "## #1 picks" stays whole to round-trip. */
export function headingInputValue(setting: string): string {
  const name = headingName(setting);
  return headingName(name) === name ? name : setting.trim();
}

function parseHeadingSetting(setting: string): { text: string; level: number } | null {
  const raw = setting.trim();
  if (raw.length === 0) return null;
  const m = /^(#{1,6})\s*(.*)$/.exec(raw);
  const text = (m ? m[2] : raw).trim();
  if (text.length === 0) return null;
  return { text, level: m ? m[1].length : 2 };
}
