/*
 * Where each category's jots go — pure functions over a snapshot of the
 * vault's notes, no Obsidian imports, so they can be unit-tested with Node.
 *
 * Two ways to route, picked in settings:
 *
 * - "name": the note named after the category, in the chosen folder
 *   (created if missing). Nothing to set up; renaming either side breaks it.
 * - "linked": the note whose `jot-category-id` property holds the category's
 *   id, anywhere in the vault. The first time a category shows up, the
 *   import asks which note it belongs to (the same-named note is picked for
 *   you) and writes the id into that note, so after that a note can be
 *   renamed or moved and the category renamed in Jot without anything
 *   breaking. A note can hold several ids to collect several categories.
 *
 * Suggestions are deterministic: the same vault and category always give the
 * same suggestion. No fuzzy scoring, no guessing beyond names.
 */

import { noteNameFor } from "./format.ts";

export type RoutingMode = "name" | "linked";

/** The frontmatter property that links a note to one or more Jot categories. */
export const LINK_PROPERTY = "jot-category-id";

/**
 * The frontmatter property that puts a linked category's jots under a
 * heading of its own: a map from category id to heading, beside the ids.
 * A category with no entry uses the Heading setting; "" means the note
 * itself, no heading.
 */
export const HEADING_PROPERTY = "jot-category-heading";

/** What routing needs to know about one Markdown note. */
export interface NoteInfo {
  /** Vault path, e.g. "Projects/Ideas.md". */
  path: string;
  /** File name without ".md". */
  basename: string;
  /** The note's `aliases` property, as strings. */
  aliases: string[];
  /** Category ids in its `jot-category-id` property, upper-case. */
  linkedIds: string[];
  /** Its `jot-category-heading` property: heading by category id (upper-case). */
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

/** The note's `aliases` property as strings (a single value or a list). */
export function aliasesFrom(frontmatter: unknown): string[] {
  if (!frontmatter || typeof frontmatter !== "object") return [];
  const fm = frontmatter as Record<string, unknown>;
  const raw = fm.aliases ?? fm.alias;
  const values = Array.isArray(raw) ? raw : [raw];
  return values.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/**
 * The frontmatter value after adding `id`: always a list, so the property
 * keeps one type across the vault, existing ids kept in order.
 */
export function withLinkedId(existing: unknown, id: string): string[] {
  const ids = linkedIdsFrom({ [LINK_PROPERTY]: existing });
  const upper = id.toUpperCase();
  return ids.includes(upper) ? ids : [...ids, upper];
}

/** The frontmatter value after removing `id`; null means delete the property. */
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
    // null is what YAML makes of "id:" with nothing after it: the note itself.
    if (UUID.test(id) && (typeof value === "string" || value === null)) out[id] = (value ?? "").trim();
  }
  return out;
}

/**
 * The `jot-category-heading` value after setting `id`'s heading (undefined
 * removes it, so the category uses the Heading setting again); null means
 * delete the property.
 */
export function withHeading(existing: unknown, id: string, heading: string | undefined): Record<string, string> | null {
  const map = headingsFrom({ [HEADING_PROPERTY]: existing });
  const upper = id.toUpperCase();
  if (heading === undefined) delete map[upper];
  else map[upper] = heading.trim();
  return Object.keys(map).length > 0 ? map : null;
}

/**
 * The folder setting as a vault path, the way Obsidian's `normalizePath`
 * writes one: trimmed, one slash between folders, none at either end. The
 * vault's own paths are always in this form, so a setting typed as
 * "Inbox " or "A//B" would otherwise miss the notes already there and
 * create a second folder beside them.
 */
export function cleanFolder(folder: string): string {
  return folder
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\u00A0|\u202F/g, " ")
    .normalize("NFC");
}

/** "Folder/Name.md", or "Name.md" at the vault root. */
export function joinPath(folder: string, basename: string): string {
  const clean = cleanFolder(folder);
  return clean.length > 0 ? `${clean}/${basename}.md` : `${basename}.md`;
}

/**
 * A path as the disk compares it on macOS, iOS and Windows: case and
 * Unicode form don't count, so "Work.md" and "work.md" are one file there
 * and creating the second fails with "File already exists."
 */
export function fold(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/**
 * The folder setting spelled the way the vault spells it, level by level,
 * so "jot/inbox" means the existing "Jot/Inbox" rather than a second "jot"
 * folder the disk would refuse. A level that doesn't exist keeps its own
 * spelling. `folders` are the vault's folder paths.
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

/** The folder setting after the folder `oldPath` became `newPath`, or null when the setting isn't in it. */
export function movedFolder(setting: string, oldPath: string, newPath: string): string | null {
  const own = fold(setting);
  const old = fold(oldPath);
  if (own.length === 0) return null;
  if (own === old) return newPath;
  return own.startsWith(old + "/") ? newPath + setting.normalize("NFC").slice(oldPath.normalize("NFC").length) : null;
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

/** Lower-case letters and digits only, so "Game Dev", "game-dev" and "GAMEDEV" compare equal. */
export function compact(s: string): string {
  return s.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function words(s: string): string[] {
  return s.normalize("NFKD").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

/** Whether `needle`'s words appear in `hay`'s words, in order and next to each other. */
function containsWords(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((w, j) => hay[i + j] === w)) return true;
  }
  return false;
}

/** Where "name" routing sends a category: an existing note or a path to create. */
export function nameTarget(notes: NoteInfo[], folder: string, category: string): { path: string; exists: boolean } {
  const path = joinPath(folder, noteNameFor(category));
  if (notes.some((n) => n.path === path)) return { path, exists: true };
  // The same path in another case or Unicode form: reuse that note rather
  // than create a second one the disk would treat as the same file.
  const key = fold(path);
  const loose = notes
    .filter((n) => fold(n.path) === key)
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
 * Suggest a note for a category that isn't linked yet. `pick` is a note
 * whose name or alias equals the category's (ignoring case, spaces and
 * punctuation) and that isn't already linked to another category; notes in
 * `folder` win ties, then shallower paths. `others` (at most `limit`) are
 * notes whose names contain the category's words, e.g. "Project Jot" for
 * "Jot". `exclude` drops paths that must never be targets (the export file).
 */
export function suggestNote(
  notes: NoteInfo[],
  category: string,
  folder: string,
  options: { exclude?: Set<string>; limit?: number } = {},
): LinkSuggestion {
  const exclude = options.exclude ?? new Set<string>();
  const limit = options.limit ?? 3;
  const key = compact(category);
  const needle = words(category);
  const home = cleanFolder(folder);
  const candidates = notes.filter((n) => !exclude.has(n.path));

  const sameName = candidates
    .filter((n) => key.length > 0 && (compact(n.basename) === key || n.aliases.some((a) => compact(a) === key)))
    .sort((a, b) => Number(parentOf(b.path) === home) - Number(parentOf(a.path) === home) || byPlace(a, b));
  const pick = sameName.find((n) => n.linkedIds.length === 0) ?? null;

  // Notes already linked to a category aren't offered as one-tap choices
  // (they stay reachable through the note search).
  const others = candidates
    .filter((n) => n !== pick && n.linkedIds.length === 0 && (sameName.includes(n) || containsWords(words(n.basename), needle)))
    .sort((a, b) => a.basename.length - b.basename.length || byPlace(a, b))
    .slice(0, limit);
  return { pick, others };
}
