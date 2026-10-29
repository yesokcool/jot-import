/*
 * The import itself: plan where every block goes, ask about the categories
 * that aren't linked yet, then write. No Obsidian imports — the plugin hands
 * in a `VaultPort` over the real vault, and the tests hand in one over a
 * plain map — so the whole flow runs under Node.
 */

import { insertIntoNote, type InsertOptions, type JotBlock, type JotExport, noteNameFor, withoutBom } from "./format.ts";
import { mediaName, mediaRefs, rewriteMediaRefs, usefulAlt } from "./media.ts";
import {
  fold,
  joinPath,
  type LinkSuggestion,
  linkedNotes,
  nameTarget,
  type NoteInfo,
  type RoutingMode,
  suggestNote,
} from "./routing.ts";

/** What the importer needs from the vault. Paths are vault paths ("Folder/Note.md"). */
export interface VaultPort {
  exists(path: string): boolean;
  /** Create a note (and any missing folders) with this content. */
  create(path: string, content: string): Promise<void>;
  /** Rewrite a note's text. */
  process(path: string, fn: (data: string) => string): Promise<void>;
  /**
   * Add `id` to the note's `jot-category-id` property, and when `heading`
   * is given, set the category's entry in `jot-category-heading` too.
   */
  link(path: string, id: string, heading?: string): Promise<void>;
  /**
   * Save an attachment where Obsidian's "Default location for new
   * attachments" puts one for the note at `notePath`, under a name no other
   * file has. A file already there with the same name and the same bytes
   * (from an earlier import of the export) is used instead of a copy.
   */
  saveAttachment(name: string, data: Uint8Array, notePath: string): Promise<{ path: string; created: boolean }>;
  /** A link from the note at `notePath` to the file at `path`, in the user's link format, without "!". */
  linkTo(path: string, notePath: string, alias?: string): string;
}

/** The files a zipped export's jots point at, by the path they use ("media/…"). */
export interface MediaSource {
  has(ref: string): boolean;
  read(ref: string): Promise<Uint8Array>;
}

export interface ImportSettings extends InsertOptions {
  mode: RoutingMode;
  /** Name mode: where the notes live. Linked mode: where new notes are created. */
  folder: string;
}

/** A category that needs a note picked before the import can run. */
export interface LinkRequest {
  block: JotBlock & { id: string };
  suggestion: LinkSuggestion;
  /** Where "New note" puts it: the same-named note in the folder, created if missing. */
  newPath: string;
  /** Whether a note is already at `newPath` (then "New note" adds to it). */
  newPathExists: boolean;
}

/**
 * The user's answer for one LinkRequest: an existing note, or a new one
 * (at `path` when the user typed one, else the request's `newPath`).
 * `heading`: the category's own heading in that note ("" for none);
 * undefined uses the Heading setting.
 */
export type LinkChoice = { kind: "note"; path: string; heading?: string } | { kind: "new"; path?: string; heading?: string };

export interface PlannedWrite {
  block: JotBlock;
  /** The note to write to; null while it waits for a LinkChoice. */
  path: string | null;
  /** Stamp the block's id into the note before writing (a new link). */
  link: boolean;
  /** The category's own heading in the note ("" for none); undefined uses the Heading setting. */
  heading?: string;
}

export interface Plan {
  /** Every block, in export order. */
  writes: PlannedWrite[];
  /** One per category id that has no linked note yet. */
  toLink: LinkRequest[];
  /** Linked mode only: blocks routed by name because the export has no ids (Jot 1.5). */
  unlinkable: number;
  /** Category names whose id is in more than one note; the first note is used. */
  ambiguous: string[];
  /**
   * Categories routed by name whose note is the export file itself (an
   * export pasted into a note named like one): `path` is the new note they
   * go to instead, `exportPath` the note holding the export.
   */
  besideExport: Array<{ name: string; path: string; exportPath: string }>;
}

export interface ImportResult {
  /** Basenames of the notes written to, in order, without repeats. */
  notes: string[];
  created: string[];
  /** Category names that were linked to a note during this import. */
  linked: string[];
  /** Attachments saved into the vault (not counting ones already there from an earlier import). */
  attachments: number;
}

/** Decide where each block goes. `exclude` holds paths that are never targets (the export file). */
export function planImport(parsed: JotExport, notes: NoteInfo[], settings: ImportSettings, exclude: Set<string> = new Set()): Plan {
  const plan: Plan = { writes: [], toLink: [], unlinkable: 0, ambiguous: [], besideExport: [] };
  const usable = notes.filter((n) => !exclude.has(n.path));
  // Paths this import will create, by `fold`: "Work" and "work" in one
  // export get one note, not a second the disk would refuse halfway through.
  const planned = new Map<string, string>();
  const claim = (path: string): string => {
    const key = fold(path);
    const first = planned.get(key);
    if (first !== undefined) return first;
    planned.set(key, path);
    return path;
  };
  // The export file is never written to, in any case or Unicode form. A
  // category whose note it would be (the export pasted into "Ideas.md")
  // gets a new note numbered the way Obsidian numbers a copy, "Ideas 1.md",
  // rather than being left out: the import still finishes in one go and
  // the export's note keeps exactly what it had. The number skips notes
  // that exist and names other categories in this export would use.
  const excluded = new Map([...exclude].map((path) => [fold(path), path]));
  const taken = new Set([
    ...notes.map((n) => fold(n.path)),
    ...parsed.blocks.map((b) => fold(joinPath(settings.folder, noteNameFor(b.name)))),
  ]);
  const instead = new Map<string, string>();
  const target = (name: string): { path: string; exists: boolean; exportPath: string | null } => {
    const found = nameTarget(usable, settings.folder, name);
    const key = fold(found.path);
    const exportPath = excluded.get(key);
    if (exportPath === undefined) return { ...found, exportPath: null };
    let path = instead.get(key);
    for (let n = 1; path === undefined; n++) {
      const numbered = `${found.path.slice(0, -".md".length)} ${n}.md`;
      if (!taken.has(fold(numbered)) && !excluded.has(fold(numbered))) path = numbered;
    }
    instead.set(key, path);
    return { path, exists: false, exportPath };
  };
  for (const block of parsed.blocks) {
    if (settings.mode === "linked" && block.id !== null) {
      const id = block.id;
      const linked = linkedNotes(usable, id);
      if (linked.length > 0) {
        if (linked.length > 1 && !plan.ambiguous.includes(block.name)) plan.ambiguous.push(block.name);
        plan.writes.push({ block, path: linked[0].path, link: false, heading: linked[0].headings?.[id] });
        continue;
      }
      if (!plan.toLink.some((r) => r.block.id === id)) {
        // The dialog shows where "New note" goes, so a numbered one needs no word in the summary.
        const goes = target(block.name);
        plan.toLink.push({
          block: { ...block, id },
          suggestion: suggestNote(usable, block.name, settings.folder, { exclude }),
          newPath: claim(goes.path),
          newPathExists: goes.exists,
        });
      }
      plan.writes.push({ block, path: null, link: false });
      continue;
    }
    if (settings.mode === "linked") plan.unlinkable++;
    const goes = target(block.name);
    const path = claim(goes.path);
    if (goes.exportPath !== null) plan.besideExport.push({ name: block.name, path, exportPath: goes.exportPath });
    // A heading the note keeps for this category (set while it was linked) still applies.
    const heading = block.id !== null ? usable.find((n) => n.path === path)?.headings?.[block.id] : undefined;
    plan.writes.push({ block, path, link: false, heading });
  }
  return plan;
}

/**
 * Fill in the waiting writes from the user's answers; a category with no
 * answer gets a new note. A typed new note's path takes the spelling of a
 * note this import already writes to in another case ("ideas.md" and
 * "Ideas.md" are one file on the disk), so the two share it.
 */
export function resolvePlan(plan: Plan, choices: Map<string, LinkChoice>): Array<PlannedWrite & { path: string }> {
  const known = new Map<string, string>();
  for (const write of plan.writes) if (write.path !== null && !known.has(fold(write.path))) known.set(fold(write.path), write.path);
  for (const request of plan.toLink) if (!known.has(fold(request.newPath))) known.set(fold(request.newPath), request.newPath);
  const pathFor = new Map<string, { path: string; heading?: string }>();
  for (const request of plan.toLink) {
    const choice = choices.get(request.block.id);
    let path = request.newPath;
    if (choice?.kind === "note") path = choice.path;
    else if (choice?.path !== undefined) {
      path = known.get(fold(choice.path)) ?? choice.path;
      known.set(fold(path), path);
    }
    pathFor.set(request.block.id, { path, heading: choice?.heading });
  }
  const stamped = new Set<string>();
  return plan.writes.map((write) => {
    if (write.path !== null) return { ...write, path: write.path };
    const id = write.block.id ?? "";
    const first = !stamped.has(id);
    stamped.add(id);
    const chosen = pathFor.get(id);
    return { block: write.block, path: chosen?.path ?? "", link: first, heading: chosen?.heading };
  });
}

/**
 * Write every planned block. Stops at the first failure and says what was
 * written before it: `written` counts the blocks that went in completely,
 * which are always the first ones, in export order. `progress` hears that
 * count after each block, before the next starts, so the plugin can save it
 * and an import cut off midway resumes rather than repeats.
 *
 * With `media` (a zipped export), the files a block's jots point at are
 * saved for its note first, and the links are rewritten to point at them.
 * A category's own heading (`write.heading`) replaces the Heading setting.
 */
export async function runImport(
  writes: Array<PlannedWrite & { path: string }>,
  port: VaultPort,
  options: InsertOptions,
  progress?: (written: number, result: ImportResult) => Promise<void>,
  media?: MediaSource,
): Promise<{ result: ImportResult; error: { path: string; message: string } | null; written: number }> {
  const result: ImportResult = { notes: [], created: [], linked: [], attachments: 0 };
  /** Where each attachment went, so a file two blocks point at is saved once. */
  const saved = new Map<string, string>();
  let written = 0;
  for (const write of writes) {
    const basename = baseOf(write.path);
    try {
      if (!port.exists(write.path)) {
        await port.create(write.path, "");
        result.created.push(basename);
      }
      // Link first, so a "top" insert lands below the new property.
      if (write.link && write.block.id !== null) {
        // Without the byte-order mark, so the link joins the note's
        // properties. (Obsidian skips the write when there's none.)
        await port.process(write.path, withoutBom);
        await port.link(write.path, write.block.id, write.heading);
        result.linked.push(write.block.name);
      }
      let body = write.block.body;
      if (media) {
        for (const ref of mediaRefs(body)) {
          if (!media.has(ref) || saved.has(ref)) continue;
          const file = await port.saveAttachment(mediaName(ref), await media.read(ref), write.path);
          saved.set(ref, file.path);
          if (file.created) result.attachments++;
        }
        body = rewriteMediaRefs(body, (ref, embed, alt) => {
          const path = saved.get(ref);
          return path === undefined ? null : port.linkTo(path, write.path, embed ? usefulAlt(alt, ref) : undefined);
        });
      }
      const insert = write.heading === undefined ? options : { ...options, heading: write.heading };
      await port.process(write.path, (data) => insertIntoNote(data, body, insert));
      if (!result.notes.includes(basename)) result.notes.push(basename);
      written++;
    } catch (e) {
      return { result, error: { path: write.path, message: e instanceof Error ? e.message : String(e) }, written };
    }
    // Outside the try: the block is in, so a failure to save progress isn't a failure to write it.
    if (progress) await progress(written, result);
  }
  return { result, error: null, written };
}

/** One import of an export, kept so the same file isn't imported twice by accident. */
export interface ImportRecord {
  fingerprint: string;
  importedAt: number;
  notes: number;
  /**
   * Set when the import stopped partway: how many of the export's blocks
   * (the first ones) were written. Importing the file again starts after
   * them instead of adding them a second time.
   */
  stoppedAfter?: number;
}

/** What the history says about an export: never imported, imported, or stopped partway. */
export type PriorImport = { kind: "new" } | { kind: "done"; at: number } | { kind: "stopped"; written: number };

export function priorImport(history: ImportRecord[], print: string): PriorImport {
  const record = history.find((r) => r.fingerprint === print);
  if (!record) return { kind: "new" };
  return record.stoppedAfter === undefined ? { kind: "done", at: record.importedAt } : { kind: "stopped", written: record.stoppedAfter };
}

/** The history with `record` first, replacing any earlier record of the same export, at most `limit` long. */
export function recordImport(history: ImportRecord[], record: ImportRecord, limit: number): ImportRecord[] {
  return [record, ...history.filter((r) => r.fingerprint !== record.fingerprint)].slice(0, limit);
}

/**
 * Two devices' histories as one (Obsidian Sync carries data.json between
 * them): the newest record of each export, newest first, at most `limit`.
 * The order doesn't depend on which history comes first, so both devices
 * end up with the same one.
 */
export function mergeHistories(a: ImportRecord[], b: ImportRecord[], limit: number): ImportRecord[] {
  const newest = new Map<string, ImportRecord>();
  for (const record of [...a, ...b]) {
    const kept = newest.get(record.fingerprint);
    if (!kept || record.importedAt > kept.importedAt) newest.set(record.fingerprint, record);
  }
  return [...newest.values()]
    .sort((x, y) => y.importedAt - x.importedAt || (x.fingerprint < y.fingerprint ? -1 : x.fingerprint > y.fingerprint ? 1 : 0))
    .slice(0, limit);
}

function baseOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

/** Note names for a notice: all of them, or the first `max` and how many more. */
function nameList(names: string[], max = 10): string {
  return names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/**
 * The notice after a finished import. `resumed`: blocks an earlier, stopped
 * import of the same file had written. `besideExport`: the plan's.
 */
export function summaryText(
  result: ImportResult,
  unlinkable: number,
  ambiguous: string[],
  resumed: number,
  besideExport: Plan["besideExport"] = [],
): string {
  const count = result.notes.length === 1 ? "1 note" : `${result.notes.length} notes`;
  const parts = [`Jot: added to ${count}: ${nameList(result.notes)}.`];
  if (resumed > 0) {
    parts.push(`Finished the import that stopped earlier, after the ${resumed === 1 ? "category" : `${resumed} categories`} it had added.`);
  }
  if (result.created.length > 0) parts.push(`Created ${nameList(result.created)}.`);
  if (result.attachments > 0) parts.push(result.attachments === 1 ? "Saved 1 attachment." : `Saved ${result.attachments} attachments.`);
  for (const { name, path, exportPath } of besideExport) {
    parts.push(`The ${name} jots went to ${baseOf(path)} because this export is in ${baseOf(exportPath)}.`);
  }
  if (result.linked.length > 0) {
    parts.push(result.linked.length === 1 ? "Linked 1 category." : `Linked ${result.linked.length} categories.`);
  }
  if (unlinkable > 0) parts.push("This export is from an older Jot, so it went by note name. Update Jot to link categories.");
  if (ambiguous.length > 0) parts.push(`More than one note is linked to ${nameList(ambiguous)}; the first was used.`);
  return parts.join(" ");
}

/** The notice after an import stopped at `error`. */
export function stoppedText(error: { path: string; message: string }, result: ImportResult): string {
  // Obsidian's own messages end with a period ("File already exists.").
  const reason = error.message.replace(/[.\s]+$/, "");
  const done = result.notes.length > 0 ? ` Already added to: ${nameList(result.notes)}.` : "";
  return `Jot Import stopped at ${error.path}: ${reason}.${done} The export file was kept; import it again to finish, and what's in already won't be added twice.`;
}

/** How recently an export must have changed to be offered: at startup, and when one appears. */
export const OFFER_WINDOW = 3 * 24 * 60 * 60 * 1000;

/**
 * The export files already offered this session, so the new-export notice
 * shows once per file. A path is released when its file goes away (imported
 * and trashed, deleted, moved): Jot names exports by date, so a second
 * export the same day lands at the same path and is a new file to offer.
 */
export class OfferedExports {
  private paths = new Set<string>();
  /** Modified time of the newest export offered this session. */
  private newest = -Infinity;

  /**
   * Whether to show a notice for this export now: it changed in the last
   * three days (exports kept on another device arrive by sync with their
   * old dates, and aren't news), it wasn't offered yet, and it's newer than
   * every export offered so far. Only one notice shows at a time, so a
   * newer export's takes the place of an older one's, and an older export
   * never adds a second; the import dialog lists them all.
   */
  claim(path: string, mtime: number, now: number): boolean {
    if (now - mtime > OFFER_WINDOW || mtime <= this.newest || this.paths.has(path)) return false;
    this.paths.add(path);
    this.newest = mtime;
    return true;
  }

  has(path: string): boolean {
    return this.paths.has(path);
  }

  release(path: string): void {
    this.paths.delete(path);
  }
}

/** A short, stable fingerprint of an export's text (cyrb53), for spotting a repeat import. */
export function fingerprint(text: string): string {
  const s = text.replace(/\r\n/g, "\n");
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
