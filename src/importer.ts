/*
 * Plans where each block goes, asks about categories with no linked note, then writes. No Obsidian
 * imports: the plugin passes a `VaultPort` over the real vault and the tests pass one over a map.
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
  resolveFolder,
  suggestNote,
  workspaceFolder,
} from "./routing.ts";

/** What the importer needs from the vault. Paths are vault paths ("Folder/Note.md"). */
export interface VaultPort {
  exists(path: string): boolean;
  /** Also creates any missing folders. */
  create(path: string, content: string): Promise<void>;
  process(path: string, fn: (data: string) => string): Promise<void>;
  /** Add `id` to the note's `jot-category-id` and, when given, set its `jot-category-heading` entry. */
  link(path: string, id: string, heading?: string): Promise<void>;
  /** Take `id` and its heading entry off the note. Its jots stay. */
  unlink(path: string, id: string): Promise<void>;
  /** Save where Obsidian puts new attachments for the note, or reuse a file there with the same bytes (`saveDeduped`). */
  saveAttachment(name: string, data: Uint8Array, notePath: string): Promise<{ path: string; created: boolean }>;
  /** A link in the user's link format, without "!". */
  linkTo(path: string, notePath: string, alias?: string): string;
}

/** What saving an attachment needs from the vault. */
export interface AttachmentFiles {
  /** Where Obsidian saves a new attachment with this name for the note, numbered ("photo 1.png") if taken. */
  availablePath(name: string, notePath: string): Promise<string>;
  /** Null when there's no file. */
  size(path: string): number | null;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
}

/**
 * Saves an attachment where Obsidian saves new ones, unless a file there already has its bytes: its name, or a
 * numbered copy an earlier import saved because the name was taken.
 */
export async function saveDeduped(files: AttachmentFiles, name: string, data: Uint8Array, notePath: string): Promise<{ path: string; created: boolean }> {
  const path = await files.availablePath(name, notePath);
  const folder = path.slice(0, path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  // Obsidian takes the first free number, so the copies so far are the plain name and the numbers before it.
  for (let n = 0; ; n++) {
    const candidate = `${folder}${n === 0 ? stem : `${stem} ${n}`}${extension}`;
    if (candidate === path) continue;
    const size = files.size(candidate);
    if (size === null) break;
    if (size === data.byteLength && sameBytes(await files.read(candidate), data)) return { path: candidate, created: false };
  }
  await files.write(path, data);
  return { path, created: true };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The files a zipped export's jots point at, by the path they use ("media/…"). */
export interface MediaSource {
  has(ref: string): boolean;
  read(ref: string): Promise<Uint8Array>;
}

export interface ImportSettings extends InsertOptions {
  /** Where new notes are created, and an export with no ids finds its notes. A workspace has a folder in it. */
  folder: string;
  /** The vault's folders, so a workspace's folder takes the spelling the vault has. */
  folders?: string[];
}

/** A category that needs a note picked before the import can run. */
export interface LinkRequest {
  block: JotBlock & { id: string };
  suggestion: LinkSuggestion;
  /**
   * Where "New note" puts it: the same-named note in the folder, created if missing, or a numbered one
   * ("Ideas 1.md") when that note holds another category or another category here has the same name.
   */
  newPath: string;
  newPathExists: boolean;
  /** The folder's same-named note when another category is linked to it. The row then waits for a choice. */
  linkedSameName: string | null;
  /**
   * For a category that already has a note: the notes holding its id (its jots go to the first) and its own
   * heading. Choosing another note or heading moves the link.
   */
  linked: { paths: string[]; heading?: string } | null;
}

/**
 * An existing note, or a new one (at `path` if the user typed one, else the request's `newPath`).
 * `heading`: "" for none; undefined uses the Heading setting.
 */
export type LinkChoice = { kind: "note"; path: string; heading?: string } | { kind: "new"; path?: string; heading?: string };

/**
 * The dialog's starting choice: where an already linked category goes now, the same-named note, or a new note
 * when nothing is named like the category. Null when only similar notes exist or the same-named note holds
 * another category, so the user has to pick before the import goes on.
 */
export function startingChoice(request: LinkRequest): LinkChoice | null {
  if (request.linked) return { kind: "note", path: request.linked.paths[0], heading: request.linked.heading };
  if (request.suggestion.pick) return { kind: "note", path: request.suggestion.pick.path };
  return request.suggestion.others.length === 0 && request.linkedSameName === null ? { kind: "new" } : null;
}

export interface PlannedWrite {
  block: JotBlock;
  /** Null while it waits for a LinkChoice. */
  path: string | null;
  /** Stamp the block's id into the note before writing. */
  link: boolean;
  /** "" for none; undefined uses the Heading setting. */
  heading?: string;
  /** With `link`: notes to take the block's id off first, where the category was linked before. */
  unlinkFrom?: string[];
}

export interface Plan {
  /** Every block, in export order. */
  writes: PlannedWrite[];
  /** One per category id that has no linked note yet. */
  toLink: LinkRequest[];
  /** One per category id that has a note already, for the dialog to change. */
  linked: LinkRequest[];
  /** Blocks routed by name because the export is from an older Jot with no ids. */
  unlinkable: number;
  /** Categories whose id is in more than one note; the first note is used. */
  ambiguous: string[];
  /** Categories routed by name whose note is the export file itself, sent to `path` instead. */
  besideExport: Array<{ name: string; path: string; exportPath: string }>;
}

export interface ImportResult {
  /** The notes written to, in order, by name (or by path where two share a name). */
  notes: string[];
  created: string[];
  /** Names of the categories linked during this import. */
  linked: string[];
  /** Not counting files reused from an earlier import. */
  attachments: number;
  /** Attachments that couldn't be read from the zip; their jots keep the links as Jot wrote them. */
  unreadable: number;
}

/** Decide where each block goes. `exclude` holds paths that are never targets (the export file). */
export function planImport(parsed: JotExport, notes: NoteInfo[], settings: ImportSettings, exclude: Set<string> = new Set()): Plan {
  const plan: Plan = { writes: [], toLink: [], linked: [], unlinkable: 0, ambiguous: [], besideExport: [] };
  const usable = notes.filter((n) => !exclude.has(n.path));
  // Every note this plan writes to or offers as new, keyed by `fold`. Routed by name, "Work" and "work"
  // share a note instead of failing halfway.
  const planned = new Map<string, string>();
  const claim = (path: string): string => {
    const key = fold(path);
    const first = planned.get(key);
    if (first !== undefined) return first;
    planned.set(key, path);
    return path;
  };
  // The export file is never written to. A category whose note it is (an export pasted into
  // "Ideas.md") goes to "Ideas 1.md" instead, as Obsidian numbers a copy, skipping names in use.
  const excluded = new Map([...exclude].map((path) => [fold(path), path]));
  const folderOf = (block: JotBlock) => resolveFolder(settings.folders ?? [], workspaceFolder(settings.folder, block.workspace));
  const taken = new Set([
    ...notes.map((n) => fold(n.path)),
    ...parsed.blocks.map((b) => fold(joinPath(folderOf(b), noteNameFor(b.name)))),
  ]);
  const numbered = (path: string): string => {
    for (let n = 1; ; n++) {
      const candidate = `${path.slice(0, -".md".length)} ${n}.md`;
      const key = fold(candidate);
      if (!taken.has(key) && !excluded.has(key) && !planned.has(key)) return candidate;
    }
  };
  const instead = new Map<string, string>();
  const target = (block: JotBlock): { path: string; exists: boolean; exportPath: string | null } => {
    const found = nameTarget(usable, folderOf(block), block.name);
    const key = fold(found.path);
    const exportPath = excluded.get(key);
    if (exportPath === undefined) return { ...found, exportPath: null };
    const path = instead.get(key) ?? numbered(found.path);
    instead.set(key, path);
    return { path, exists: false, exportPath };
  };
  // "New note" is never a note a category is linked to, or one another category here is about to get.
  const request = (block: JotBlock & { id: string }, linked: LinkRequest["linked"]): LinkRequest => {
    const folder = folderOf(block);
    const found = nameTarget(usable, folder, block.name);
    const key = fold(found.path);
    const holder = found.exists ? usable.find((n) => n.path === found.path && n.linkedIds.length > 0) : undefined;
    const free = holder === undefined && !excluded.has(key) && !planned.has(key);
    const path = free ? found.path : numbered(found.path);
    planned.set(fold(path), path);
    return {
      block,
      suggestion: suggestNote(usable, block.name, folder, { exclude }),
      newPath: path,
      newPathExists: free && found.exists,
      linkedSameName: holder?.linkedIds.some((other) => other !== block.id) ? holder.path : null,
      linked,
    };
  };
  const alreadyLinked: Array<{ block: JotBlock & { id: string }; notes: NoteInfo[] }> = [];
  for (const block of parsed.blocks) {
    if (block.id !== null) {
      const id = block.id;
      const linked = linkedNotes(usable, id);
      if (linked.length > 0) {
        if (linked.length > 1 && !plan.ambiguous.includes(block.name)) plan.ambiguous.push(block.name);
        plan.writes.push({ block, path: linked[0].path, link: false, heading: linked[0].headings?.[id] });
        if (!alreadyLinked.some((c) => c.block.id === id)) alreadyLinked.push({ block: { ...block, id }, notes: linked });
        continue;
      }
      // Not added to `besideExport`: the dialog already shows where "New note" goes.
      if (!plan.toLink.some((r) => r.block.id === id)) plan.toLink.push(request({ ...block, id }, null));
      plan.writes.push({ block, path: null, link: false });
      continue;
    }
    // An older Jot wrote no ids, so its categories go to the notes named after them.
    plan.unlinkable++;
    const goes = target(block);
    const path = claim(goes.path);
    if (goes.exportPath !== null) plan.besideExport.push({ name: block.name, path, exportPath: goes.exportPath });
    plan.writes.push({ block, path, link: false });
  }
  // After the new categories, so their new notes get the plain names.
  for (const { block, notes: linked } of alreadyLinked) {
    plan.linked.push(request(block, { paths: linked.map((n) => n.path), heading: linked[0].headings?.[block.id] }));
  }
  return plan;
}

/** Every category linked in the vault, as dialog rows, so where they go can change without an import. */
export function linkedCategories(
  notes: NoteInfo[],
  categoryOf: (id: string) => { name: string; workspace: string | null },
  settings: ImportSettings,
): LinkRequest[] {
  const blocks = [...new Set(notes.flatMap((n) => n.linkedIds))]
    .map((id) => ({ ...categoryOf(id), id, body: "" }))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  return planImport({ version: 1, date: null, blocks, problem: null }, notes, settings).linked;
}

/** Whether a choice for an already linked category moves it to another note or gives it another heading. */
export function changesLink(request: LinkRequest, choice: LinkChoice | undefined): boolean {
  if (!request.linked || !choice) return false;
  return choice.kind !== "note" || choice.path !== request.linked.paths[0] || choice.heading !== request.linked.heading;
}

/** Where a category goes after the dialog, and the notes to take its id off first. */
export interface LinkMove {
  id: string;
  name: string;
  path: string;
  /** "" for none; undefined uses the Heading setting. */
  heading?: string;
  from: string[];
}

/**
 * The dialog's answers as moves: a new category to its choice (a new note when unanswered), an already linked one
 * only when its note or heading changed. A typed path takes the spelling of a note in `known` ("Jot/ideas.md"
 * for "Jot/Ideas.md"), since the disk sees one file.
 */
export function linkMoves(requests: LinkRequest[], choices: Map<string, LinkChoice>, known = new Map<string, string>()): LinkMove[] {
  const moves: LinkMove[] = [];
  for (const request of requests) {
    const choice = choices.get(request.block.id);
    if (request.linked && !changesLink(request, choice)) continue;
    let path = request.newPath;
    if (choice?.kind === "note") path = choice.path;
    else if (choice?.path !== undefined) {
      path = known.get(fold(choice.path)) ?? choice.path;
      known.set(fold(path), path);
    }
    moves.push({ id: request.block.id, name: request.block.name, path, heading: choice?.heading, from: request.linked?.paths ?? [] });
  }
  return moves;
}

/**
 * "Change where categories go" in the settings: each move's note is created if missing and linked, and the old
 * notes lose the id. No jots are written; the old notes keep the ones they have.
 */
export async function applyLinkMoves(moves: LinkMove[], port: VaultPort): Promise<{ created: string[] }> {
  const created: string[] = [];
  for (const move of moves) {
    if (!port.exists(move.path)) {
      await port.create(move.path, "");
      created.push(baseOf(move.path));
    }
    for (const from of move.from) await port.unlink(from, move.id);
    await port.process(move.path, withoutBom);
    await port.link(move.path, move.id, move.heading);
  }
  return { created };
}

/**
 * Fill in the writes from the user's answers (`linkMoves`): the waiting ones, and an already linked category's
 * when it moved. Its first write links the new note and takes the id off the old ones.
 */
export function resolvePlan(plan: Plan, choices: Map<string, LinkChoice>): Array<PlannedWrite & { path: string }> {
  const known = new Map<string, string>();
  for (const write of plan.writes) if (write.path !== null && !known.has(fold(write.path))) known.set(fold(write.path), write.path);
  for (const request of plan.toLink) if (!known.has(fold(request.newPath))) known.set(fold(request.newPath), request.newPath);
  const moves = new Map(linkMoves([...plan.toLink, ...plan.linked], choices, known).map((move) => [move.id, move]));
  const stamped = new Set<string>();
  return plan.writes.map((write) => {
    const move = write.block.id === null ? undefined : moves.get(write.block.id);
    if (!move) return { ...write, path: write.path ?? "" };
    const first = !stamped.has(move.id);
    stamped.add(move.id);
    return { block: write.block, path: move.path, link: first, heading: move.heading, unlinkFrom: first ? move.from : [] };
  });
}

/**
 * Write every block, stopping at the first failure. `written` counts the blocks fully written, always the
 * first ones; `progress` gets it after each block so the plugin can save it and a cut-off import resumes.
 */
export async function runImport(
  writes: Array<PlannedWrite & { path: string }>,
  port: VaultPort,
  options: InsertOptions,
  progress?: (written: number, result: ImportResult) => Promise<void>,
  media?: MediaSource,
): Promise<{ result: ImportResult; error: { path: string; message: string } | null; written: number }> {
  const result: ImportResult = { notes: [], created: [], linked: [], attachments: 0, unreadable: 0 };
  // By media ref, so a file two blocks point at is saved once.
  const saved = new Map<string, string>();
  const unread = new Set<string>();
  const notePaths: string[] = [];
  const createdPaths: string[] = [];
  let written = 0;
  for (const write of writes) {
    try {
      if (!port.exists(write.path)) {
        await port.create(write.path, "");
        createdPaths.push(write.path);
        result.created = noteLabels(createdPaths);
      }
      // Link first, so a "top" insert lands below the new property.
      if (write.link && write.block.id !== null) {
        for (const from of write.unlinkFrom ?? []) await port.unlink(from, write.block.id);
        // Drop any byte-order mark so the id joins the existing properties; Obsidian skips unchanged writes.
        await port.process(write.path, withoutBom);
        await port.link(write.path, write.block.id, write.heading);
        result.linked.push(write.block.name);
      }
      let body = write.block.body;
      if (media) {
        const known = (ref: string) => media.has(ref);
        for (const ref of mediaRefs(body, known)) {
          if (!media.has(ref) || saved.has(ref) || unread.has(ref)) continue;
          let data: Uint8Array;
          try {
            data = await media.read(ref);
          } catch {
            // Damaged or too large to unpack here: the jot goes in with Jot's link, and the export is kept.
            unread.add(ref);
            result.unreadable++;
            continue;
          }
          const file = await port.saveAttachment(mediaName(ref), data, write.path);
          saved.set(ref, file.path);
          if (file.created) result.attachments++;
        }
        body = rewriteMediaRefs(
          body,
          (ref, embed, alt) => {
            const path = saved.get(ref);
            return path === undefined ? null : port.linkTo(path, write.path, embed ? usefulAlt(alt, ref) : undefined);
          },
          known,
        );
      }
      const insert = write.heading === undefined ? options : { ...options, heading: write.heading };
      await port.process(write.path, (data) => insertIntoNote(data, body, insert));
      if (!notePaths.includes(write.path)) notePaths.push(write.path);
      result.notes = noteLabels(notePaths);
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
  /** Set when the import stopped partway: how many leading blocks went in, so importing again resumes. */
  stoppedAfter?: number;
  /** With `stoppedAfter`: attachments those blocks couldn't import, still to report when it finishes. */
  unreadable?: number;
}

export const HISTORY_LIMIT = 100;

export type PriorImport = { kind: "new" } | { kind: "done"; at: number } | { kind: "stopped"; written: number; unreadable: number };

export function priorImport(history: ImportRecord[], print: string): PriorImport {
  const record = history.find((r) => r.fingerprint === print);
  if (!record) return { kind: "new" };
  if (record.stoppedAfter === undefined) return { kind: "done", at: record.importedAt };
  // Stopped before any block went in: nothing to resume.
  return record.stoppedAfter > 0 ? { kind: "stopped", written: record.stoppedAfter, unreadable: record.unreadable ?? 0 } : { kind: "new" };
}

/** Everything one import of an export needs; `importExport` runs it. */
export interface ImportJob {
  parsed: JotExport;
  /** The export's fingerprint, its key in the history. */
  print: string;
  prior: PriorImport;
  notes: NoteInfo[];
  settings: ImportSettings;
  /** Paths that are never targets (the export file). */
  exclude?: Set<string>;
  /** Asks which note each new category goes to; null cancels the import before anything is written. */
  ask(plan: Plan): Promise<Map<string, LinkChoice> | null>;
  port: VaultPort;
  options: InsertOptions;
  media?: MediaSource;
  /** Gets a record to save after each block but the last, so an import cut off midway resumes there. */
  progress(record: ImportRecord): Promise<void>;
  now?: () => number;
}

export interface ImportOutcome {
  plan: Plan;
  result: ImportResult;
  error: { path: string; message: string } | null;
  /** Blocks a stopped import of the same export wrote earlier, skipped this time. */
  resumed: number;
  /** Attachments that couldn't be read, by this import and the stopped one it finishes. */
  unreadable: number;
  /** The history record for this import, or null when nothing was written. */
  record: ImportRecord | null;
}

/**
 * Plans, asks and writes, starting after the blocks a stopped import of the same export wrote. At worst the
 * block being written when an import is cut off goes in twice. Null when the user cancels.
 */
export async function importExport(job: ImportJob): Promise<ImportOutcome | null> {
  const now = job.now ?? Date.now;
  const resumed = job.prior.kind === "stopped" ? job.prior.written : 0;
  const unreadBefore = job.prior.kind === "stopped" ? job.prior.unreadable : 0;
  const plan = planImport({ ...job.parsed, blocks: job.parsed.blocks.slice(resumed) }, job.notes, job.settings, job.exclude);
  const choices = plan.toLink.length > 0 ? await job.ask(plan) : new Map<string, LinkChoice>();
  if (!choices) return null;
  const writes = resolvePlan(plan, choices);
  const record = (sofar: ImportResult, written: number | null): ImportRecord => {
    const r: ImportRecord = { fingerprint: job.print, importedAt: now(), notes: sofar.notes.length };
    if (written === null) return r;
    r.stoppedAfter = resumed + written;
    if (unreadBefore + sofar.unreadable > 0) r.unreadable = unreadBefore + sofar.unreadable;
    return r;
  };
  const { result, error, written } = await runImport(
    writes,
    job.port,
    job.options,
    (count, sofar) => (count < writes.length ? job.progress(record(sofar, count)) : Promise.resolve()),
    job.media,
  );
  let last: ImportRecord | null = null;
  if (error === null) last = record(result, null);
  else if (resumed + written > 0) last = record(result, written);
  return { plan, result, error, resumed, unreadable: unreadBefore + result.unreadable, record: last };
}

export function recordImport(history: ImportRecord[], record: ImportRecord, limit: number): ImportRecord[] {
  return [record, ...history.filter((r) => r.fingerprint !== record.fingerprint)].slice(0, limit);
}

/**
 * Two devices' histories as one (Obsidian Sync carries data.json between them): the newest record of
 * each export. The order doesn't depend on argument order, so both devices end up with the same one.
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

/** Each note's name, or its path without ".md" where two notes here share a name (two workspaces' Inbox). */
function noteLabels(paths: string[]): string[] {
  const names = paths.map(baseOf);
  return paths.map((path, i) => (names.indexOf(names[i]) === names.lastIndexOf(names[i]) ? names[i] : path.replace(/\.md$/, "")));
}

function baseOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

function nameList(names: string[], max = 10): string {
  return names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

export interface SummaryDetails {
  /** Blocks routed by name because the export has no ids. */
  unlinkable?: number;
  ambiguous?: string[];
  /** Blocks an earlier, stopped import of the same file wrote. */
  resumed?: number;
  besideExport?: Plan["besideExport"];
  /** Attachments that didn't reach the vault, and the export file (path or name) they're still in. */
  left?: { count: number; where: string };
}

/** The notice after a finished import. */
export function summaryText(result: ImportResult, details: SummaryDetails = {}): string {
  const { unlinkable = 0, ambiguous = [], resumed = 0, besideExport = [], left } = details;
  const count = result.notes.length === 1 ? "1 note" : `${result.notes.length} notes`;
  const parts = [`Jot: added to ${count}: ${nameList(result.notes)}.`];
  if (resumed > 0) {
    parts.push(`Finished the import that stopped earlier, after the ${resumed === 1 ? "category" : `${resumed} categories`} it had added.`);
  }
  if (result.created.length > 0) parts.push(`Created ${nameList(result.created)}.`);
  if (result.attachments > 0) parts.push(result.attachments === 1 ? "Saved 1 attachment." : `Saved ${result.attachments} attachments.`);
  if (left && left.count > 0) {
    const what = left.count === 1 ? "1 attachment wasn't imported. It's" : `${left.count} attachments weren't imported. They're`;
    parts.push(`${what} still in ${left.where}, which was kept.`);
  }
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

/** An error's message without its closing period, to end a sentence of ours. Obsidian's own messages have one. */
export function errorReason(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/[.\s]+$/, "");
}

export function stoppedText(error: { path: string; message: string }, result: ImportResult): string {
  const reason = errorReason(error.message);
  const done = result.notes.length > 0 ? ` Already added to: ${nameList(result.notes)}.` : "";
  return `Jot Import stopped at ${error.path}: ${reason}.${done} The export file was kept; import it again to finish, and what's in already won't be added twice.`;
}

/**
 * Jot names exports "jot-export-…", or "<category> Jots" when shared from a category. Files and browsers
 * number a second copy: "Work Jots 2", "Work Jots (1)".
 */
export function looksLikeExportName(basename: string): boolean {
  return /^jot-export/i.test(basename) || /jots(?: \d+| ?\(\d+\))?$/i.test(basename);
}

/** Only exports changed this recently are offered: ones synced from another device keep their old dates. */
export const OFFER_WINDOW = 3 * 24 * 60 * 60 * 1000;

/**
 * Exports offered this session, so the notice shows once per file. A path is released when its file goes
 * away: Jot names exports by date, so a second export the same day lands at the same path.
 */
export class OfferedExports {
  private paths = new Set<string>();
  private newest = -Infinity;

  /**
   * Whether to show a notice now: recent, not offered yet, and newer than every export offered so far.
   * One notice shows at a time, so only a newer export replaces it; the import dialog lists them all.
   */
  claim(path: string, mtime: number, now: number): boolean {
    if (!this.mayClaim(path, mtime, now)) return false;
    this.paths.add(path);
    this.newest = mtime;
    return true;
  }

  /** `claim` without claiming, checked before the file is read so an old export is never read. */
  mayClaim(path: string, mtime: number, now: number): boolean {
    return now - mtime <= OFFER_WINDOW && mtime > this.newest && !this.paths.has(path);
  }

  release(path: string): void {
    this.paths.delete(path);
  }
}

/**
 * The new-export notice on screen, hidden once its Import button has nothing left to do: the file is gone,
 * or its export was imported another way. `file` is the vault's own file object, whose path follows a rename.
 */
export class OfferNotice<N extends { hide(): void }> {
  private shown: { notice: N; file: { path: string }; print: string } | null = null;

  /** Replaces the notice shown before. `print` is the offered export's fingerprint. */
  set(notice: N, file: { path: string }, print: string): void {
    this.hide();
    this.shown = { notice, file, print };
  }

  /** With `notice`, only if that one is still the notice shown. */
  hide(notice?: N): void {
    if (!this.shown || (notice !== undefined && this.shown.notice !== notice)) return;
    this.shown.notice.hide();
    this.shown = null;
  }

  fileGone(path: string): void {
    if (this.shown?.file.path === path) this.hide();
  }

  hideIfImported(done: (print: string) => boolean): void {
    if (this.shown && done(this.shown.print)) this.hide();
  }
}

/** The parts of a vault file (a TFile) read before deciding whether to open it. */
export interface ExportFileStat {
  extension: string;
  stat: { mtime: number; size: number };
}

/**
 * At startup: the newest recent export not yet imported, or null. Files are filtered by date and size, then
 * read newest first, stopping at the first to offer, so a vault with years of exports reads almost nothing.
 */
export async function exportToOffer<F extends ExportFileStat>(
  files: F[],
  now: number,
  limits: { zipBytes: number; textBytes: number },
  read: (file: F) => Promise<string | null>,
  wasImported: (text: string) => boolean,
): Promise<F | null> {
  const recent = files
    .filter((f) => now - f.stat.mtime <= OFFER_WINDOW && f.stat.size <= (f.extension === "zip" ? limits.zipBytes : limits.textBytes))
    .sort((a, b) => b.stat.mtime - a.stat.mtime);
  for (const file of recent) {
    const text = await read(file);
    if (text !== null && !wasImported(text)) return file;
  }
  return null;
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
