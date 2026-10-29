/*
 * What the plugin keeps in its data.json: the settings, and beside them the
 * import history and the last-seen name of each category id. No Obsidian
 * imports, so the tests read saved data exactly the way the plugin does.
 */

import type { Position } from "./format.ts";
import { type ImportRecord, mergeHistories } from "./importer.ts";
import { cleanFolder, type RoutingMode } from "./routing.ts";

export interface JotImportSettings {
  /** "name": the note named after the category. "linked": the note holding its id. */
  mode: RoutingMode;
  /** Name mode: where the category notes live. Linked mode: where new ones are made. "" is the vault root. */
  folder: string;
  position: Position;
  /** Heading to insert under; "" means the note itself. */
  heading: string;
  /** Move an export file that lives inside the vault to the trash once imported. */
  trashAfterImport: boolean;
  /** Show a notice with an Import button when an export appears in the vault. */
  offerNewExports: boolean;
}

/**
 * Since 1.1.0 jots go to a note you choose (the first import asks, with
 * same-named notes already picked) and at the top: Jot exports newest
 * first, so each import's jots land above the older ones and the note reads
 * newest first all the way down. 1.0 sent them to the same-named note, at
 * the bottom.
 */
export const DEFAULT_SETTINGS: JotImportSettings = {
  mode: "linked",
  folder: "",
  position: "top",
  heading: "",
  trashAfterImport: true,
  offerNewExports: true,
};

type SettingKey = keyof JotImportSettings;
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];

/** Saved beside the settings: recent imports, and the last-seen name of each category id. */
export interface PluginState {
  history: ImportRecord[];
  categoryNames: Record<string, string>;
}

export const HISTORY_LIMIT = 100;

/**
 * Saved data (whatever `loadData` returned) as the plugin uses it, with
 * defaults for what's missing. The folder is cleaned the way the setting
 * saves it now: 1.0.0 saved it as typed, and "Inbox " never matched the
 * "Inbox" folder (nor followed it when it was renamed).
 *
 * `chosen` lists the settings the saved data holds, which are the only ones
 * saved back (`dataToSave`), so a setting nobody chose follows the default
 * when a later version changes it. 1.0 saved every setting with its first
 * import, so a 1.0 vault keeps all of its values, the routing mode and
 * position included: its notes were filled the 1.0 way, and switching
 * either under it would change where the next jots go without asking.
 */
export function readSaved(saved: unknown): { settings: JotImportSettings; state: PluginState; chosen: SettingKey[] } {
  const { history, categoryNames, ...rest } = (saved && typeof saved === "object" ? saved : {}) as Partial<
    JotImportSettings & PluginState
  >;
  const settings = Object.assign({}, DEFAULT_SETTINGS, rest);
  settings.folder = typeof settings.folder === "string" ? cleanFolder(settings.folder) : DEFAULT_SETTINGS.folder;
  return {
    settings,
    state: {
      history: Array.isArray(history) ? history : [],
      categoryNames: categoryNames && typeof categoryNames === "object" ? categoryNames : {},
    },
    chosen: SETTING_KEYS.filter((key) => key in rest),
  };
}

/** What `saveData` gets: the chosen settings (see `readSaved`) and the state. */
export function dataToSave(settings: JotImportSettings, chosen: Iterable<string>, state: PluginState): Record<string, unknown> {
  const keep = new Set(chosen);
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) if (keep.has(key)) out[key] = settings[key];
  return { ...out, ...state };
}

/**
 * This device's state once another device's saved data (`theirs`) has
 * arrived by Obsidian Sync: every import either device recorded (the
 * newest record of each export) and both devices' category names, theirs
 * winning a clash since they're newer. `news` says whether ours added
 * anything theirs lacks: then it's saved back so the other device gets it
 * too, and when it didn't, nothing is saved, so the two never save back and
 * forth.
 */
export function mergeState(theirs: PluginState, ours: PluginState): { state: PluginState; news: boolean } {
  const history = mergeHistories(theirs.history, ours.history, HISTORY_LIMIT);
  const categoryNames = { ...ours.categoryNames, ...theirs.categoryNames };
  const known = new Set(theirs.history.map(recordKey));
  const news =
    history.some((r) => !known.has(recordKey(r))) || Object.keys(ours.categoryNames).some((id) => !(id in theirs.categoryNames));
  return { state: { history, categoryNames }, news };
}

function recordKey(record: ImportRecord): string {
  return `${record.fingerprint} ${record.importedAt} ${record.stoppedAfter ?? ""}`;
}
