/*
 * Where each category's jots go: the note whose `jot-category-id` holds its id, anywhere, so renames on either
 * side don't break it, and the notes to suggest for a new one. An export with no ids goes by note name.
 * Pure, deterministic functions over a snapshot of the vault's notes.
 */

import { noteNameFor } from "./format.ts";

/** The frontmatter property that links a note to one or more Jot categories. */
export const LINK_PROPERTY = "jot-category-id";

/**
 * Frontmatter map from a linked category's id to its own heading in the note. A category with no entry
 * uses the Heading setting; "" means no heading.
 */
export const HEADING_PROPERTY = "jot-category-heading";

/** What routing needs to know about one Markdown note. */
export interface NoteInfo {
  /** Vault path, e.g. "Projects/Ideas.md". */
  path: string;
  basename: string;
  aliases: string[];
  /** From `jot-category-id`, upper-case. */
  linkedIds: string[];
  /** From `jot-category-heading`, by upper-case id. */
  headings?: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The category ids a note's frontmatter links it to (a single value or a list). */
export function linkedIdsFrom(frontmatter: unknown): string[] {
  if (!frontmatter || typeof frontmatter !== "object") return [];
  const raw = (frontmatter as Record<string, unknown>)[LINK_PROPERTY];
  const values = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const id = value.trim().toUpperCase();
    if (UUID.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The note's `aliases` (or `alias`) property as strings, from a single value or a list. */
export function aliasesFrom(frontmatter: unknown): string[] {
  if (!frontmatter || typeof frontmatter !== "object") return [];
  const fm = frontmatter as Record<string, unknown>;
  const raw = fm.aliases ?? fm.alias;
  const values = Array.isArray(raw) ? raw : [raw];
  return values.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/** The link property after adding `id`: always a list, so the property keeps one type across the vault. */
export function withLinkedId(existing: unknown, id: string): string[] {
  const ids = linkedIdsFrom({ [LINK_PROPERTY]: existing });
  const upper = id.toUpperCase();
  return ids.includes(upper) ? ids : [...ids, upper];
}

/** The link property after removing `id`; null means delete the property. */
export function withoutLinkedId(existing: unknown, id: string): string[] | null {
  const upper = id.toUpperCase();
  const ids = linkedIdsFrom({ [LINK_PROPERTY]: existing }).filter((x) => x !== upper);
  return ids.length > 0 ? ids : null;
}

/** A note's `jot-category-heading` map, by upper-case category id; values that aren't text are left out. */
export function headingsFrom(frontmatter: unknown): Record<string, string> {
  if (!frontmatter || typeof frontmatter !== "object") return {};
  const raw = (frontmatter as Record<string, unknown>)[HEADING_PROPERTY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = key.trim().toUpperCase();
    // YAML reads "id:" with nothing after it as null, meaning no heading.
    if (UUID.test(id) && (typeof value === "string" || value === null)) out[id] = (value ?? "").trim();
  }
  return out;
}

/** The heading map after setting `id`'s heading (undefined removes it); null means delete the property. */
export function withHeading(existing: unknown, id: string, heading: string | undefined): Record<string, string> | null {
  const map = headingsFrom({ [HEADING_PROPERTY]: existing });
  const upper = id.toUpperCase();
  if (heading === undefined) delete map[upper];
  else map[upper] = heading.trim();
  return Object.keys(map).length > 0 ? map : null;
}

/**
 * The folder setting as Obsidian's `normalizePath` would write it. Vault paths are always in this form,
 * so "Inbox " or "A//B" would otherwise miss the existing folder and create a second one beside it.
 */
export function cleanFolder(folder: string): string {
  return folder
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\u00A0|\u202F/g, " ")
    .normalize("NFC");
}

/** Where a category's notes go: the folder, or a folder named after its workspace inside it. */
export function workspaceFolder(folder: string, workspace: string | null): string {
  if (workspace === null) return cleanFolder(folder);
  const name = noteNameFor(workspace);
  return cleanFolder(folder).length > 0 ? `${cleanFolder(folder)}/${name}` : name;
}

/** "Folder/Name.md", or "Name.md" at the vault root. */
export function joinPath(folder: string, basename: string): string {
  const clean = cleanFolder(folder);
  return clean.length > 0 ? `${clean}/${basename}.md` : `${basename}.md`;
}

/** Whether `path` is in `folder` or a folder inside it ("" is the whole vault), the way the disk matches names. */
export function isInFolder(path: string, folder: string): boolean {
  const own = fold(cleanFolder(folder));
  return own.length === 0 || fold(path).startsWith(own + "/");
}

/** A path as the disk compares it on macOS, iOS and Windows, where "Work.md" and "work.md" are one file. */
export function fold(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/**
 * The folder setting spelled the way the vault spells it, so "jot/inbox" means the existing "Jot/Inbox"
 * rather than a second folder the disk would refuse. A level that doesn't exist keeps its own spelling.
 */
export function resolveFolder(folders: string[], folder: string): string {
  let current = "";
  for (const part of folder.normalize("NFC").split("/")) {
    if (part.length === 0) continue;
    const wanted = current ? `${current}/${part}` : part;
    const key = fold(wanted);
    current = folders.includes(wanted) ? wanted : (folders.filter((f) => fold(f) === key).sort()[0] ?? wanted);
  }
  return current;
}

/** An exact match first, then one ignoring case and Unicode form, as the disk does. */
export function findNote(notes: NoteInfo[], path: string): NoteInfo | undefined {
  return notes.find((n) => n.path === path) ?? notes.find((n) => fold(n.path) === fold(path));
}

/**
 * A note typed in the choose-note dialog, with a folder and a slash in front or in the Folder setting: an existing
 * note, where a new one goes, or why it can't be used. `exclude` holds the export file.
 */
export function typedNote(
  typed: string,
  context: { notes: NoteInfo[]; folders: string[]; folder: string; exclude: Set<string> },
): { path: string; exists: boolean } | { problem: string } {
  const name = typed.trim().replace(/\.md$/i, "");
  if (name.length === 0) return { problem: "Type a note name." };
  const existing = findNote(context.notes, `${name}.md`);
  if (existing) return { path: existing.path, exists: true };
  const slash = name.lastIndexOf("/");
  if (name.slice(slash + 1).trim().length === 0) return { problem: "Type a note name." };
  // "..", "." and hidden folders like ".obsidian": outside the vault, or never shown.
  const typedFolder = slash === -1 ? null : name.slice(0, slash);
  if (typedFolder?.split(/[\\/]/).some((part) => part.trim().startsWith("."))) return { problem: "A folder name can't start with a dot." };
  const folder = typedFolder === null ? context.folder : cleanFolder(typedFolder);
  const path = joinPath(resolveFolder(context.folders, folder), noteNameFor(name.slice(slash + 1)));
  if ([...context.exclude].some((p) => fold(p) === fold(path))) return { problem: "That's the Jot export file. Choose another name." };
  const cleaned = findNote(context.notes, path);
  return cleaned ? { path: cleaned.path, exists: true } : { path, exists: false };
}

/** The folder setting after the folder `oldPath` became `newPath`, or null when the setting isn't in it. */
export function movedFolder(setting: string, oldPath: string, newPath: string): string | null {
  const own = fold(setting);
  const old = fold(oldPath);
  if (own.length === 0) return null;
  if (own === old) return newPath;
  if (!own.startsWith(old + "/")) return null;
  // By folder, not by character: changing case can change a name's length ("İ" lower-cases to two).
  return [newPath, ...setting.normalize("NFC").split("/").slice(oldPath.split("/").length)].join("/");
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function depth(path: string): number {
  return path.split("/").length;
}

/** Stable order: shallower first, then shorter, then alphabetical. */
function byPlace(a: NoteInfo, b: NoteInfo): number {
  return depth(a.path) - depth(b.path) || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/**
 * Lower-case letters, digits, "+", "#" and "&" only, so "Game Dev", "game-dev" and "GAMEDEV" compare equal
 * but "C", "C#" and "C++" don't.
 */
export function compact(s: string): string {
  return s.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}+#&]+/gu, "");
}

function words(s: string): string[] {
  return s.normalize("NFKD").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

interface NoteKeys {
  path: string;
  name: string;
  aliases: string[];
  words: string[];
}

/**
 * A note's `fold`, `compact` and `words` keys, worked out once per note: routing and suggestions run once per
 * category, over every note. The cache goes with the note list it was built from.
 */
const noteKeys = new WeakMap<NoteInfo, NoteKeys>();

function keysOf(note: NoteInfo): NoteKeys {
  let keys = noteKeys.get(note);
  if (!keys) {
    keys = { path: fold(note.path), name: compact(note.basename), aliases: note.aliases.map(compact), words: words(note.basename) };
    noteKeys.set(note, keys);
  }
  return keys;
}

/** The notes with each word in their names. Built once per note list, which mustn't change after. */
const wordIndex = new WeakMap<NoteInfo[], Map<string, NoteInfo[]>>();

function notesWithWord(notes: NoteInfo[], word: string): NoteInfo[] {
  let index = wordIndex.get(notes);
  if (!index) {
    index = new Map();
    for (const note of notes) {
      for (const w of new Set(keysOf(note).words)) {
        const list = index.get(w);
        if (list) list.push(note);
        else index.set(w, [note]);
      }
    }
    wordIndex.set(notes, index);
  }
  return index.get(word) ?? [];
}

/** Whether `needle` appears in `hay` as a run of consecutive words. */
function containsWords(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((w, j) => hay[i + j] === w)) return true;
  }
  return false;
}

/** The note named after a category in the folder: an existing note, or a path to create. */
export function nameTarget(notes: NoteInfo[], folder: string, category: string): { path: string; exists: boolean } {
  const path = joinPath(folder, noteNameFor(category));
  if (notes.some((n) => n.path === path)) return { path, exists: true };
  // Reuse a note at the same path in another case or Unicode form; the disk treats them as one file.
  const key = fold(path);
  const loose = notes
    .filter((n) => keysOf(n).path === key)
    .map((n) => n.path)
    .sort()[0];
  return loose !== undefined ? { path: loose, exists: true } : { path, exists: false };
}

/** The notes linked to a category id, in a stable order (the first is where its jots go). */
export function linkedNotes(notes: NoteInfo[], id: string): NoteInfo[] {
  const upper = id.toUpperCase();
  return notes.filter((n) => n.linkedIds.includes(upper)).sort(byPlace);
}

export interface LinkSuggestion {
  /** A note with the category's name (or alias), picked unless the user changes it. */
  pick: NoteInfo | null;
  /** Unlinked notes whose names contain the category's name, offered as one-tap choices. */
  others: NoteInfo[];
}

/**
 * `pick`: an unlinked note whose name or alias equals the category's, ignoring case and punctuation, with
 * notes in `folder` first, then shallower ones. `others`: up to 3 unlinked notes containing its words.
 */
export function suggestNote(
  notes: NoteInfo[],
  category: string,
  folder: string,
  options: { exclude?: Set<string> } = {},
): LinkSuggestion {
  const exclude = options.exclude ?? new Set<string>();
  const key = compact(category);
  const needle = words(category);
  const home = cleanFolder(folder);

  const sameName = (key.length === 0 ? [] : notes)
    .filter((n) => (keysOf(n).name === key || keysOf(n).aliases.includes(key)) && !exclude.has(n.path))
    .sort((a, b) => Number(parentOf(b.path) === home) - Number(parentOf(a.path) === home) || byPlace(a, b));
  const pick = sameName.find((n) => n.linkedIds.length === 0) ?? null;

  const similar = needle.length === 0 ? [] : notesWithWord(notes, needle[0]).filter((n) => containsWords(keysOf(n).words, needle));
  // Linked notes aren't one-tap choices; they stay reachable through the note search.
  const others = [...new Set([...sameName, ...similar])]
    .filter((n) => n !== pick && n.linkedIds.length === 0 && !exclude.has(n.path))
    .sort((a, b) => a.basename.length - b.basename.length || byPlace(a, b))
    .slice(0, 3);
  return { pick, others };
}
