/*
 * What the plugin keeps in data.json: the settings, the import history and the last-seen name of each
 * category id. No Obsidian imports, so the tests read saved data exactly the way the plugin does.
 */

import type { Position } from "./format.ts";
import { HISTORY_LIMIT, type ImportRecord, mergeHistories } from "./importer.ts";
import { cleanFolder } from "./routing.ts";

export interface JotImportSettings {
  /** Where new notes are made, and where an export with no category ids finds its notes. "" is the vault root. */
  folder: string;
  position: Position;
  /** Heading to insert under; "" means the note itself. */
  heading: string;
  /** Where a heading the note doesn't have yet is added. */
  newHeadingPosition: Position;
  /** Blank lines above the imported jots, 0 to 3. */
  blankLinesBefore: number;
  /** Blank lines below the imported jots, 0 to 3. */
  blankLinesAfter: number;
  /** A line above each import's jots, with `{{date}}` and `{{time}}` filled in; "" for none. */
  startMarker: string;
  /** A line below each import's jots; "" for none. */
  endMarker: string;
  /** Move an export file that lives inside the vault to the trash once imported. */
  trashAfterImport: boolean;
  /**
   * Show a notice with an Import button when an export is saved in `exportsFolder`, and list that folder's
   * exports in the import window. Off to start (2026-10-31), so Jot Import reads only the file you pick.
   */
  offerNewExports: boolean;
  /** The one folder (and its subfolders) watched for new exports; "" is the whole vault. */
  exportsFolder: string;
  /** Where the "choose notes" dialog cuts a path that doesn't fit on its row. */
  shortenPaths: PathShortening;
  /** The dialog's already linked categories start folded away. */
  collapseLinked: boolean;
}

export type PathShortening = "start" | "middle" | "end";

export const DEFAULT_SETTINGS: JotImportSettings = {
  folder: "Jots",
  // Jot exports newest first, so inserting at the top keeps the whole note newest first.
  position: "top",
  heading: "",
  newHeadingPosition: "bottom",
  blankLinesBefore: 1,
  blankLinesAfter: 1,
  startMarker: "*Jots imported {{date}}*",
  endMarker: "---",
  trashAfterImport: true,
  offerNewExports: false,
  exportsFolder: "Jots",
  shortenPaths: "middle",
  collapseLinked: false,
};

export type SettingKey = keyof JotImportSettings;
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return SETTING_KEYS.some((k) => k === key);
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const flag = (value: unknown) => (typeof value === "boolean" ? value : undefined);
// Cleaned on load too: a folder saved as typed ("Inbox ") would miss its folder.
const folder = (value: unknown) => (typeof value === "string" ? cleanFolder(value) : undefined);
const oneOf =
  <T extends string>(...options: T[]) =>
  (value: unknown): T | undefined =>
    options.find((option) => option === value);

/** A count of blank lines, a number or a numeric string, as a whole number from 0 to 3. */
function blankLines(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), 3) : undefined;
}

/** Each setting's value as the plugin uses it, or undefined when a saved or chosen value doesn't fit. */
const READERS: { [K in SettingKey]: (value: unknown) => JotImportSettings[K] | undefined } = {
  folder,
  position: oneOf("top", "bottom"),
  heading: text,
  newHeadingPosition: oneOf("bottom", "top"),
  blankLinesBefore: blankLines,
  blankLinesAfter: blankLines,
  startMarker: text,
  endMarker: text,
  trashAfterImport: flag,
  offerNewExports: flag,
  exportsFolder: folder,
  shortenPaths: oneOf("start", "middle", "end"),
  collapseLinked: flag,
};

/** Sets `key` to `value` if it fits the setting (cleaned, for a folder or a count); false leaves it as it was. */
export function setSetting<K extends SettingKey>(settings: JotImportSettings, key: K, value: unknown): boolean {
  const read: (value: unknown) => JotImportSettings[K] | undefined = READERS[key];
  const valid = read(value);
  if (valid === undefined) return false;
  settings[key] = valid;
  return true;
}

export interface PluginState {
  history: ImportRecord[];
  categoryNames: Record<string, string>;
  /** By category id, for those in a workspace: where "Change where categories go" offers a new note. */
  categoryWorkspaces?: Record<string, string>;
}

/**
 * Saved data with defaults for what's missing or doesn't fit. `chosen` lists the settings it holds, the only
 * ones saved back (`dataToSave`), so a setting nobody chose follows the default if a later version changes it.
 */
export function readSaved(saved: unknown): { settings: JotImportSettings; state: PluginState; chosen: SettingKey[] } {
  const data: Record<string, unknown> = saved && typeof saved === "object" && !Array.isArray(saved) ? { ...saved } : {};
  const settings = { ...DEFAULT_SETTINGS };
  const chosen = SETTING_KEYS.filter((key) => key in data && setSetting(settings, key, data[key]));
  return {
    settings,
    state: {
      history: Array.isArray(data.history) ? data.history.filter(isRecord) : [],
      categoryNames: namesFrom(data.categoryNames),
      ...workspacesFrom(namesFrom(data.categoryWorkspaces)),
    },
    chosen,
  };
}

function isRecord(value: unknown): value is ImportRecord {
  if (!value || typeof value !== "object") return false;
  const r: Record<string, unknown> = { ...value };
  const count = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v));
  return (
    typeof r.fingerprint === "string" &&
    typeof r.importedAt === "number" &&
    typeof r.notes === "number" &&
    count(r.stoppedAfter) &&
    count(r.unreadable)
  );
}

function namesFrom(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** What `saveData` gets: the chosen settings (see `readSaved`) and the state. */
export function dataToSave(settings: JotImportSettings, chosen: Iterable<string>, state: PluginState): Record<string, unknown> {
  const keep = new Set(chosen);
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) if (keep.has(key)) out[key] = settings[key];
  return { ...out, ...state };
}

/**
 * Merge another device's state (`theirs`, arrived by Obsidian Sync) into ours; their category names win.
 * `news` is true only when ours adds something theirs lacks, so the two devices never save back and forth.
 */
export function mergeState(theirs: PluginState, ours: PluginState): { state: PluginState; news: boolean } {
  const history = mergeHistories(theirs.history, ours.history, HISTORY_LIMIT);
  const categoryNames = { ...ours.categoryNames, ...theirs.categoryNames };
  const known = new Set(theirs.history.map(recordKey));
  const lacks = (mine: Record<string, string> = {}, other: Record<string, string> = {}) => Object.keys(mine).some((id) => !(id in other));
  const news =
    history.some((r) => !known.has(recordKey(r))) ||
    lacks(ours.categoryNames, theirs.categoryNames) ||
    lacks(ours.categoryWorkspaces, theirs.categoryWorkspaces);
  const workspaces = workspacesFrom({ ...ours.categoryWorkspaces, ...theirs.categoryWorkspaces });
  return { state: { history, categoryNames, ...workspaces }, news };
}

/** Left out of data.json while no category has a workspace. */
function workspacesFrom(map: Record<string, string>): Pick<PluginState, "categoryWorkspaces"> {
  return Object.keys(map).length > 0 ? { categoryWorkspaces: map } : {};
}

function recordKey(record: ImportRecord): string {
  return `${record.fingerprint} ${record.importedAt} ${record.stoppedAfter ?? ""}`;
}
