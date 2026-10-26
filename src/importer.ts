/*
 * The import itself: plan where every block goes, ask about the categories
 * that aren't linked yet, then write. No Obsidian imports — the plugin hands
 * in a `VaultPort` over the real vault, and the tests hand in one over a
 * plain map — so the whole flow runs under Node.
 */

import { insertIntoNote, type InsertOptions, type JotBlock, type JotExport } from "./format.ts";
import {
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
  /** Add `id` to the note's `jot-category-id` property. */
  link(path: string, id: string): Promise<void>;
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

/** The user's answer for one LinkRequest: an existing note's path, or a new note. */
export type LinkChoice = { kind: "note"; path: string } | { kind: "new" };

export interface PlannedWrite {
  block: JotBlock;
  /** The note to write to; null while it waits for a LinkChoice. */
  path: string | null;
  /** Stamp the block's id into the note before writing (a new link). */
  link: boolean;
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
}

export interface ImportResult {
  /** Basenames of the notes written to, in order, without repeats. */
  notes: string[];
  created: string[];
  /** Category names that were linked to a note during this import. */
  linked: string[];
}

/** Decide where each block goes. `exclude` holds paths that are never targets (the export file). */
export function planImport(parsed: JotExport, notes: NoteInfo[], settings: ImportSettings, exclude: Set<string> = new Set()): Plan {
  const plan: Plan = { writes: [], toLink: [], unlinkable: 0, ambiguous: [] };
  const usable = notes.filter((n) => !exclude.has(n.path));
  for (const block of parsed.blocks) {
    if (settings.mode === "linked" && block.id !== null) {
      const id = block.id;
      const linked = linkedNotes(usable, id);
      if (linked.length > 0) {
        if (linked.length > 1 && !plan.ambiguous.includes(block.name)) plan.ambiguous.push(block.name);
        plan.writes.push({ block, path: linked[0].path, link: false });
        continue;
      }
      if (!plan.toLink.some((r) => r.block.id === id)) {
        const target = nameTarget(usable, settings.folder, block.name);
        plan.toLink.push({
          block: { ...block, id },
          suggestion: suggestNote(usable, block.name, settings.folder, { exclude }),
          newPath: target.path,
          newPathExists: target.exists,
        });
      }
      plan.writes.push({ block, path: null, link: false });
      continue;
    }
    if (settings.mode === "linked") plan.unlinkable++;
    plan.writes.push({ block, path: nameTarget(usable, settings.folder, block.name).path, link: false });
  }
  return plan;
}

/** Fill in the waiting writes from the user's answers; a category with no answer gets a new note. */
export function resolvePlan(plan: Plan, choices: Map<string, LinkChoice>): Array<PlannedWrite & { path: string }> {
  const pathFor = new Map<string, string>();
  for (const request of plan.toLink) {
    const choice = choices.get(request.block.id);
    pathFor.set(request.block.id, choice?.kind === "note" ? choice.path : request.newPath);
  }
  const stamped = new Set<string>();
  return plan.writes.map((write) => {
    if (write.path !== null) return { ...write, path: write.path };
    const id = write.block.id ?? "";
    const first = !stamped.has(id);
    stamped.add(id);
    return { block: write.block, path: pathFor.get(id) ?? "", link: first };
  });
}

/** Write every planned block. Stops at the first failure and says what was written before it. */
export async function runImport(
  writes: Array<PlannedWrite & { path: string }>,
  port: VaultPort,
  options: InsertOptions,
): Promise<{ result: ImportResult; error: { path: string; message: string } | null }> {
  const result: ImportResult = { notes: [], created: [], linked: [] };
  for (const write of writes) {
    const basename = baseOf(write.path);
    try {
      if (!port.exists(write.path)) {
        await port.create(write.path, "");
        result.created.push(basename);
      }
      // Link first, so a "top" insert lands below the new property.
      if (write.link && write.block.id !== null) {
        await port.link(write.path, write.block.id);
        result.linked.push(write.block.name);
      }
      await port.process(write.path, (data) => insertIntoNote(data, write.block.body, options));
      if (!result.notes.includes(basename)) result.notes.push(basename);
    } catch (e) {
      return { result, error: { path: write.path, message: e instanceof Error ? e.message : String(e) } };
    }
  }
  return { result, error: null };
}

function baseOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
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
