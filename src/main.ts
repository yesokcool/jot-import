import { App, Modal, moment, Notice, Platform, Plugin, Setting, TFile, TFolder, debounce, getFrontMatterInfo, normalizePath, parseYaml } from "obsidian";
import { dataToSave, DEFAULT_SETTINGS, type JotImportSettings, mergeState, type PluginState, readSaved } from "./data.ts";
import { fillMarker, isJotExport, isWholeExport, parseJotExport } from "./format.ts";
import {
  applyLinkMoves,
  createdText,
  errorReason,
  exportToOffer,
  fingerprint,
  HISTORY_LIMIT,
  importExport,
  type ImportResult,
  linkedCategories,
  linkMoves,
  looksLikeExportName,
  OfferedExports,
  OfferNotice,
  type PriorImport,
  priorImport,
  recordImport,
  saveDeduped,
  stoppedText,
  summaryText,
  type VaultPort,
} from "./importer.ts";
import { ByNameModal, type LinkContext, LinkModal } from "./link-modal.ts";
import {
  aliasesFrom,
  HEADING_PROPERTY,
  headingsFrom,
  isInFolder,
  LINK_PROPERTY,
  linkedIdsFrom,
  movedFolder,
  type NoteInfo,
  resolveFolder,
  withHeading,
  withLinkedId,
  withoutLinkedId,
} from "./routing.ts";
import { JotImportSettingTab } from "./settings.ts";
import { looksLikeZip, MOBILE_ZIP_LIMITS, wholeBuffer, ZIP_LIMITS, ZipError, type ZipLimits } from "./zip.ts";
import { OBSIDIAN_FORMAT_HINT, openZipExport, type ZipExport, zipMedia } from "./zip-export.ts";

export default class JotImportPlugin extends Plugin {
  settings: JotImportSettings = { ...DEFAULT_SETTINGS };
  /** Setting keys the user chose. Only these are saved, so the rest follow the defaults. */
  private chosen = new Set<string>();
  private state: PluginState = { history: [], categoryNames: {} };
  /** Export text per zip path, so listing exports doesn't unzip them again. */
  private zipTexts = new Map<string, { stamp: string; text: string | null }>();
  /** Exports already offered this session, so a notice shows once per file. */
  private offered = new OfferedExports();
  /** Set while an import runs, so a second one can't interleave writes. */
  private busy = false;
  private settingTab: JotImportSettingTab | null = null;
  /** Notes that held a link at the last look, so removing one by hand refreshes the list too. */
  private linkedPaths = new Set<string>();
  /** Links just written that the metadata cache may not show yet, so the next import doesn't ask about them again. */
  private pendingLinks = new Map<string, Set<string>>();
  /** The one new-export notice shown. Hidden on unload so its Import button can't run a disabled plugin. */
  private offerNotice = new OfferNotice<Notice>();
  /** A zip that's still arriving, by path: it's read once it stops changing. */
  private settling = new Map<string, number>();

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "import-jot-export",
      name: "Import a Jot export…",
      callback: () => new ImportModal(this.app, this).open(),
    });

    this.addCommand({
      id: "import-active-file",
      name: "Import the active file as a Jot export",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isExportExtension(file)) return false;
        if (!checking) void this.importVaultFile(file);
        return true;
      },
    });

    this.addRibbonIcon("notebook-pen", "Import a Jot export", () => new ImportModal(this.app, this).open());
    this.settingTab = new JotImportSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // Refresh the "Linked notes" list when a link changes anywhere, including by hand.
    const refresh = debounce(() => this.settingTab?.update(), 500, true);
    this.registerEvent(
      this.app.metadataCache.on("changed", (file, _data, cache) => {
        const ids = linkedIdsFrom(cache.frontmatter);
        this.indexedLinks(file.path, ids);
        const linked = ids.length > 0;
        if (linked || this.linkedPaths.has(file.path)) {
          if (linked) this.linkedPaths.add(file.path);
          else this.linkedPaths.delete(file.path);
          refresh();
        }
      }),
    );

    // Jot names exports by day, so the next export may reuse a deleted one's path.
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.offered.release(file.path);
        this.offerNotice.fileGone(file.path);
      }),
    );

    // Folder settings follow a renamed folder, so new notes don't start over in an empty one.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.offered.release(oldPath);
        if (!(file instanceof TFolder)) return;
        const folder = movedFolder(this.settings.folder, oldPath, file.path);
        const exportsFolder = movedFolder(this.settings.exportsFolder, oldPath, file.path);
        if (folder === null && exportsFolder === null) return;
        if (folder !== null) this.settings.folder = folder;
        if (exportsFolder !== null) this.settings.exportsFolder = exportsFolder;
        void this.saveSettings();
        this.settingTab?.update();
      }),
    );

    // After layout-ready, or the vault's initial load fires "create" for every file.
    // Exports that arrived while Obsidian was closed are found by offerRecentExports.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (!(file instanceof TFile)) return;
          if (file.extension === "zip") this.offerWhenSettled(file);
          else void this.offerImport(file);
        }),
      );
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && file.extension === "zip") this.offerWhenSettled(file);
        }),
      );
      void this.offerRecentExports();
      this.settingTab?.update();
    });
  }

  async loadSettings() {
    const { settings, state, chosen } = readSaved(await this.loadData());
    this.settings = settings;
    this.state = state;
    this.chosen = new Set(chosen);
  }

  async saveSettings() {
    await this.saveData(dataToSave(this.settings, this.chosen, this.state));
  }

  /** Mark a setting as chosen, so it's saved and no longer follows the default. */
  chooseSetting(key: string) {
    this.chosen.add(key);
  }

  /**
   * data.json changed on disk, usually by Obsidian Sync. Its settings win, but import
   * histories are merged so the repeat-import guard knows what every device imported.
   */
  async onExternalSettingsChange() {
    const { settings, state, chosen } = readSaved(await this.loadData());
    const merged = mergeState(state, this.state);
    this.settings = settings;
    this.chosen = new Set(chosen);
    this.state = merged.state;
    if (merged.news) await this.saveSettings();
    // The offered export may have been imported on another device.
    this.offerNotice.hideIfImported((print) => priorImport(this.state.history, print).kind === "done");
    this.settingTab?.update();
  }

  noteLinked(path: string, linked: boolean) {
    if (linked) this.linkedPaths.add(path);
    else this.linkedPaths.delete(path);
  }

  /** The name a category id had in the last export that carried it. */
  categoryName(id: string): string {
    return this.state.categoryNames[id] ?? `Category ${id.slice(0, 8)}`;
  }

  async unlink(path: string, id: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return;
    this.pendingLinks.get(path)?.delete(id.toUpperCase());
    const indexed = this.metadataChange(file);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      const next = withoutLinkedId(fm[LINK_PROPERTY], id);
      if (next) fm[LINK_PROPERTY] = next;
      else delete fm[LINK_PROPERTY];
      setHeadingProperty(fm, id, undefined);
    });
    await indexed;
  }

  /** `heading`: "" for none, undefined to follow the Heading setting. */
  async setCategoryHeading(path: string, id: string, heading: string | undefined): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return;
    const indexed = this.metadataChange(file);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => setHeadingProperty(fm, id, heading));
    await indexed;
  }

  /** The settings' "Change where categories go": the dialog for every linked category, then only the links move. */
  async changeLinks(): Promise<void> {
    if (this.busy) {
      new Notice("A Jot import is already running. Try again in a moment.");
      return;
    }
    this.busy = true;
    try {
      const port = new ObsidianVault(this.app, this);
      const notes = await port.notes();
      const folders = this.app.vault.getAllFolders(false).map((f) => f.path);
      const settings = { ...this.settings, folder: resolveFolder(folders, this.settings.folder), folders };
      const requests = linkedCategories(
        notes,
        (id) => ({ name: this.categoryName(id), workspace: this.state.categoryWorkspaces?.[id] ?? null }),
        settings,
      );
      if (requests.length === 0) return;
      const choices = await LinkModal.ask(this.app, requests, this.linkContext(notes), { changeOnly: true });
      if (!choices) return;
      const moves = linkMoves(requests, choices);
      if (moves.length === 0) return;
      const { created } = await applyLinkMoves(moves, port);
      const moved = moves.length === 1 ? "Changed where 1 category goes." : `Changed where ${moves.length} categories go.`;
      new Notice(created.length > 0 ? `${moved} ${createdText(created)}` : moved);
    } catch (e) {
      new Notice(`Jot Import couldn't change the links: ${errorReason(e)}.`, 0);
    } finally {
      this.busy = false;
      this.settingTab?.update();
    }
  }

  headingsOf(path: string): Array<{ heading: string; level: number }> {
    const file = this.app.vault.getFileByPath(path);
    const headings = file ? this.app.metadataCache.getFileCache(file)?.headings : undefined;
    return (headings ?? []).map((h) => ({ heading: h.heading, level: h.level }));
  }

  /** `exclude`: the export file itself, left out of the notes to choose from. */
  linkContext(notes: NoteInfo[], exclude: Set<string> = new Set()): LinkContext {
    const folders = this.app.vault.getAllFolders(false).map((f) => f.path);
    return {
      notes: notes.filter((n) => !exclude.has(n.path)),
      folders,
      folder: resolveFolder(folders, this.settings.folder),
      heading: this.settings.heading,
      shortenPaths: this.settings.shortenPaths,
      newHeading: this.settings.newHeadingPosition,
      exclude,
      headingsOf: (path) => this.headingsOf(path),
    };
  }

  onunload() {
    this.offerNotice.hide();
    for (const timer of this.settling.values()) window.clearTimeout(timer);
  }

  /** A zip arriving in pieces changes many times and can't be read until it's whole. */
  private offerWhenSettled(file: TFile) {
    window.clearTimeout(this.settling.get(file.path));
    const timer = window.setTimeout(() => {
      this.settling.delete(file.path);
      void this.offerImport(file);
    }, 2000);
    this.settling.set(file.path, timer);
  }

  notePendingLink(path: string, id: string) {
    const ids = this.pendingLinks.get(path) ?? new Set<string>();
    ids.add(id.toUpperCase());
    this.pendingLinks.set(path, ids);
  }

  pendingLinksOf(path: string): string[] {
    return [...(this.pendingLinks.get(path) ?? [])];
  }

  private indexedLinks(path: string, ids: string[]) {
    const pending = this.pendingLinks.get(path);
    if (!pending) return;
    for (const id of ids) pending.delete(id);
    if (pending.size === 0) this.pendingLinks.delete(path);
  }

  /** Resolves when the metadata cache re-reads the file (or after a second), so a list built next sees the change. */
  private metadataChange(file: TFile): Promise<void> {
    return new Promise((resolve) => {
      const ref = this.app.metadataCache.on("changed", (changed) => {
        if (changed.path !== file.path) return;
        this.app.metadataCache.offref(ref);
        resolve();
      });
      this.registerEvent(ref);
      window.setTimeout(() => {
        this.app.metadataCache.offref(ref);
        resolve();
      }, 1000);
    });
  }

  async importVaultFile(file: TFile): Promise<void> {
    await this.guarded(() => this.importFromVault(file));
  }

  /** A file picked from disk is outside the vault, so it's never trashed. */
  async importPickedFile(file: File): Promise<void> {
    await this.guarded(() => this.importFromDisk(file));
  }

  /** `sourcePath`: the vault file the text is from, never written to. Null when nothing was written. */
  async importText(text: string, sourcePath: string | null = null): Promise<ImportResult | null> {
    const imported = await this.guarded(() => this.importOnce(text, { path: sourcePath, name: sourcePath ?? "the export" }));
    return imported?.result ?? null;
  }

  /** A failure outside the write loop (reading the file, saving progress, trashing it) still gets a notice. */
  private async guarded<T>(work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (e) {
      new Notice(`Jot Import couldn't finish: ${errorReason(e)}. The Jot export file was kept.`, 0);
      return null;
    }
  }

  private async importFromVault(file: TFile): Promise<void> {
    if (!this.app.vault.getFileByPath(file.path)) {
      new Notice(`${file.name} is no longer in the vault. The file may have been imported on another device.`);
      return;
    }
    if (file.extension === "zip") return this.importVaultZip(file);
    const text = await this.app.vault.read(file);
    if (!isJotExport(text)) {
      new Notice(notExportText(file.name));
      return;
    }
    const imported = await this.importOnce(text, { path: file.path, name: file.path });
    if (!imported || !this.settings.trashAfterImport || !this.app.vault.getFileByPath(file.path)) return;
    // Trash only an unchanged file that holds nothing but the export.
    if (isWholeExport(text) && (await this.app.vault.read(file)) === text) {
      await this.app.fileManager.trashFile(file);
    } else {
      new Notice(`Kept ${file.name} because the file has more in it than the Jot export.`);
    }
  }

  /** Like a .md export, the zip is trashed only if it's unchanged and holds nothing but the export, all of it imported. */
  private async importVaultZip(file: TFile): Promise<void> {
    const stamp = stampOf(file);
    let zip: ZipExport;
    try {
      zip = await this.openZip(file);
    } catch (e) {
      new Notice(zipProblem(file.name, e), 0);
      return;
    }
    const imported = await this.importOnce(zip.text, { path: file.path, name: file.path, zip });
    const still = this.app.vault.getFileByPath(file.path);
    // With attachments left in it, the import's notice already says the zip was kept.
    if (!imported || imported.attachmentsLeft > 0 || !this.settings.trashAfterImport || !still) return;
    if (zip.onlyExport && isWholeExport(zip.text) && stampOf(still) === stamp) {
      await this.app.fileManager.trashFile(still);
    } else {
      new Notice(`Kept ${file.name} because the file has more in it than the Jot export.`);
    }
  }

  private async openZip(file: TFile): Promise<ZipExport> {
    const limits = zipLimits();
    if (file.stat.size > limits.zipBytes) throw new ZipError("The zip is too large to import.");
    return openZipExport(new Uint8Array(await this.app.vault.readBinary(file)), limits);
  }

  private async importFromDisk(file: File): Promise<void> {
    const limits = zipLimits();
    if (file.size > limits.zipBytes) {
      new Notice(`${file.name} is too large to import.`);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    // A .zip always goes the zip way, so one that can't be read says why instead of being read as text.
    if (!looksLikeZip(bytes) && !/\.zip$/i.test(file.name)) {
      await this.importOnce(new TextDecoder("utf-8").decode(bytes), { path: null, name: file.name });
      return;
    }
    let zip: ZipExport;
    try {
      zip = await openZipExport(bytes, limits);
    } catch (e) {
      new Notice(zipProblem(file.name, e), 0);
      return;
    }
    await this.importOnce(zip.text, { path: null, name: file.name, zip });
  }

  /** Returns null when nothing was written (not an export, cancelled or failed), so the caller keeps the file. */
  private async importOnce(text: string, origin: ExportOrigin): Promise<Imported | null> {
    if (this.busy) {
      new Notice("A Jot import is already running. Try again in a moment.");
      return null;
    }
    this.busy = true;
    try {
      return await this.runImport(text, origin);
    } finally {
      this.busy = false;
    }
  }

  private async runImport(text: string, origin: ExportOrigin): Promise<Imported | null> {
    const parsed = parseJotExport(text);
    if (!parsed) {
      new Notice(
        isJotExport(text)
          ? "This Jot export is from a newer version of Jot. Update Jot Import to import it."
          : notExportText(origin.name),
      );
      return null;
    }
    if (parsed.problem) {
      // Importing anyway would drop the cut-off jots and then trash their only copy.
      new Notice(`Jot Import can't import this Jot export without losing jots. ${parsed.problem} The file was kept.`, 0);
      return null;
    }
    if (parsed.blocks.length === 0) {
      new Notice("The Jot export has no jots in it.");
      return null;
    }

    const print = fingerprint(text);
    const prior = priorImport(this.state.history, print);
    if (prior.kind === "done" && !(await confirmReimport(this.app, prior.at))) return null;

    const port = new ObsidianVault(this.app, this);
    const notes = await port.notes();
    const exclude = new Set(origin.path !== null ? [origin.path] : []);
    const folders = this.app.vault.getAllFolders(false).map((f) => f.path);
    // One time for the whole import, so every note's start line agrees.
    const now = (moment as unknown as MomentNow)();
    const fill = (template: string) => fillMarker(template, (kind, pattern) => now.format(pattern ?? (kind === "date" ? "LL" : "LT")));
    const outcome = await importExport({
      parsed,
      print,
      prior,
      notes,
      settings: { ...this.settings, folder: resolveFolder(folders, this.settings.folder), folders },
      exclude,
      ask: async (plan) => {
        if (plan.toLink.length > 0 || plan.linked.length > 0) {
          return LinkModal.ask(this.app, plan.toLink, this.linkContext(notes, exclude), {
            linked: plan.linked,
            collapseLinked: this.settings.collapseLinked,
          });
        }
        // An older export goes by note name, so there's nothing to choose, only to confirm.
        const rows = plan.writes.flatMap((w) => (w.path === null ? [] : [{ category: w.block.name, path: w.path, exists: port.exists(w.path) }]));
        return (await ByNameModal.ask(this.app, rows, this.settings.shortenPaths)) ? new Map() : null;
      },
      port,
      options: {
        position: this.settings.position,
        heading: this.settings.heading,
        newHeading: this.settings.newHeadingPosition,
        blankLinesBefore: this.settings.blankLinesBefore,
        blankLinesAfter: this.settings.blankLinesAfter,
        startMarker: fill(this.settings.startMarker),
        endMarker: fill(this.settings.endMarker),
      },
      media: origin.zip ? zipMedia(origin.zip) : undefined,
      progress: async (record) => {
        this.state.history = recordImport(this.state.history, record, HISTORY_LIMIT);
        await this.saveSettings();
      },
    });
    if (!outcome) return null;
    const { plan, result, error, resumed, unreadable, record } = outcome;

    for (const block of parsed.blocks) {
      if (block.id === null) continue;
      this.state.categoryNames[block.id] = block.name;
      if (block.workspace !== null) this.state.categoryWorkspaces = { ...this.state.categoryWorkspaces, [block.id]: block.workspace };
      else delete this.state.categoryWorkspaces?.[block.id];
    }
    if (record) this.state.history = recordImport(this.state.history, record, HISTORY_LIMIT);
    await this.saveSettings();
    this.settingTab?.update();

    if (error) {
      new Notice(stoppedText(error, result), 0);
      return null;
    }
    this.offerNotice.hideIfImported((offered) => offered === print);
    const left = (origin.zip?.unlinked ?? 0) + unreadable;
    const summary = summaryText(result, { ...plan, resumed, left: { count: left, where: origin.name } });
    new Notice(summary, left > 0 ? 0 : 8000);
    return { result, attachmentsLeft: left };
  }

  /**
   * Vault files that hold a Jot export, newest first, with their text so callers don't read them again. A zip
   * older than `UNZIP_TO_LIST` is listed without its text: unzipping every one a vault keeps is slow on a phone.
   */
  async candidateFiles(): Promise<Array<{ file: TFile; text: string | null }>> {
    const now = Date.now();
    const byDate = this.exportFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
    const out: Array<{ file: TFile; text: string | null }> = [];
    for (const file of byDate) {
      if (file.extension === "zip" && now - file.stat.mtime > UNZIP_TO_LIST) {
        out.push({ file, text: null });
        continue;
      }
      const text = await this.exportTextOf(file);
      if (text !== null) out.push({ file, text });
    }
    return out;
  }

  /** Files the new-export notice may read. Nothing outside the exports folder is read unasked. */
  private isWatched(file: TFile): boolean {
    return isExportExtension(file) && looksLikeExportName(file.basename) && isInFolder(file.path, this.settings.exportsFolder);
  }

  private exportFiles(): TFile[] {
    return this.app.vault.getFiles().filter((f) => isExportExtension(f) && looksLikeExportName(f.basename));
  }

  private async exportTextOf(file: TFile): Promise<string | null> {
    if (file.extension !== "zip") {
      const text = await this.app.vault.cachedRead(file);
      return isJotExport(text) ? text : null;
    }
    const stamp = stampOf(file);
    const known = this.zipTexts.get(file.path);
    if (known?.stamp === stamp) return known.text;
    let text: string | null = null;
    try {
      text = (await this.openZip(file)).text;
    } catch {
      // Not a readable export; importing it shows why.
    }
    this.zipTexts.set(file.path, { stamp, text });
    return text;
  }

  priorImport(text: string): PriorImport {
    return priorImport(this.state.history, fingerprint(text));
  }

  wasImported(text: string): boolean {
    return this.priorImport(text).kind === "done";
  }

  /** Offer a new export with an Import button (rules in `OfferedExports.claim`). It's never imported without asking. */
  private async offerImport(file: TFile): Promise<void> {
    if (!this.settings.offerNewExports || !this.isWatched(file)) return;
    // Checked before reading, so an old or too-large file is never read.
    if (!this.offered.mayClaim(file.path, file.stat.mtime, Date.now()) || file.stat.size > offerLimit(file)) return;
    const text = await this.exportTextOf(file);
    if (text === null || this.wasImported(text) || !this.offered.claim(file.path, file.stat.mtime, Date.now())) return;

    const close = () => {
      notice.hide();
      this.offerNotice.hide(notice);
    };
    const notice = new Notice(
      createFragment((f) => {
        f.createDiv({ text: `New Jot export: ${file.basename}` });
        const actions = f.createDiv({ cls: "jot-import-notice-actions" });
        actions.createEl("button", { text: "Import", cls: "mod-cta" }, (btn) =>
          btn.addEventListener("click", () => {
            close();
            void this.importVaultFile(file);
          }),
        );
        actions.createEl("button", { text: "Not now" }, (btn) => btn.addEventListener("click", close));
      }),
      0,
    );
    this.offerNotice.set(notice, file, fingerprint(text));
  }

  /** At startup, offer the newest recent export that wasn't imported yet. */
  private async offerRecentExports(): Promise<void> {
    if (!this.settings.offerNewExports) return;
    const file = await exportToOffer(
      this.exportFiles().filter((f) => this.isWatched(f)),
      Date.now(),
      zipLimits(),
      (f) => this.exportTextOf(f),
      (text) => this.wasImported(text),
    );
    if (file) await this.offerImport(file);
  }
}

/** Where an export came from: `path` in the vault (never written to), or null for a file picked from disk. */
interface ExportOrigin {
  path: string | null;
  /** The vault path or the picked file's name, for the notices. */
  name: string;
  zip?: ZipExport;
}

interface Imported {
  result: ImportResult;
  /** Attachments in the zip that didn't reach the vault. */
  attachmentsLeft: number;
}

/** The largest file the new-export notice reads. A .md may be as large as a zip's export text. */
function offerLimit(file: TFile): number {
  const limits = zipLimits();
  return file.extension === "zip" ? limits.zipBytes : limits.textBytes;
}

const UNZIP_TO_LIST = 30 * 24 * 60 * 60 * 1000;

/**
 * The part of Obsidian's moment used here. Obsidian's types get moment's from the moment package, which the
 * community directory's review can't resolve, so it flagged every use as unsafe.
 */
type MomentNow = () => { format(pattern: string): string };

/** Lower limits on mobile, which has less memory. */
function zipLimits(): ZipLimits {
  return Platform.isMobile ? MOBILE_ZIP_LIMITS : ZIP_LIMITS;
}

/** Jot zips an export when it has photos or files. */
function isExportExtension(file: TFile): boolean {
  return file.extension === "md" || file.extension === "zip";
}

/** Compared between two looks at a file to tell whether it changed. */
function stampOf(file: TFile): string {
  return `${file.stat.size}:${file.stat.mtime}`;
}

/** For a file that isn't an export Jot Import can read. It may still be a Jot export, made without Obsidian Format. */
function notExportText(name: string): string {
  return `Jot Import can't read ${name} because it has no Obsidian Format markers. ${OBSIDIAN_FORMAT_HINT}`;
}

function zipProblem(name: string, e: unknown): string {
  const reason = e instanceof ZipError ? e.message : "The file can't be read as a zip.";
  return `Jot Import can't import ${name}. ${reason}`;
}

/** Set one category's entry in the heading property; undefined removes it. */
function setHeadingProperty(fm: Record<string, unknown>, id: string, heading: string | undefined) {
  const next = withHeading(fm[HEADING_PROPERTY], id, heading);
  if (next) fm[HEADING_PROPERTY] = next;
  else delete fm[HEADING_PROPERTY];
}

function confirmReimport(app: App, importedAt: number): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let answered = false;
    modal.setTitle("Import this Jot export again?");
    modal.contentEl.createEl("p", {
      text: `You imported this Jot export on ${new Date(importedAt).toLocaleString()}. Importing it again adds the same jots a second time.`,
    });
    new Setting(modal.contentEl)
      .addButton((btn) => btn.setButtonText("Cancel").onClick(() => modal.close()))
      .addButton((btn) =>
        btn
          .setButtonText("Import again")
          .setDestructive()
          .onClick(() => {
            answered = true;
            resolve(true);
            modal.close();
          }),
      );
    modal.onClose = () => {
      if (!answered) resolve(false);
    };
    modal.open();
  });
}

/** The importer's view of the real vault. */
class ObsidianVault implements VaultPort {
  constructor(
    private app: App,
    private plugin: JotImportPlugin,
  ) {}

  async notes(): Promise<NoteInfo[]> {
    const out: NoteInfo[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      // Not indexed yet (right after startup): read the frontmatter so a linked note isn't missed.
      const fm: unknown = cache ? cache.frontmatter : await this.readFrontmatter(file);
      const linkedIds = [...new Set([...linkedIdsFrom(fm), ...this.plugin.pendingLinksOf(file.path)])];
      out.push({ path: file.path, basename: file.basename, aliases: aliasesFrom(fm), linkedIds, headings: headingsFrom(fm) });
    }
    return out;
  }

  exists(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
  }

  async create(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);
    const slash = normalized.lastIndexOf("/");
    if (slash > 0) await this.ensureFolder(normalized.slice(0, slash));
    await this.app.vault.create(normalized, content);
  }

  async process(path: string, fn: (data: string) => string): Promise<void> {
    await this.app.vault.process(this.file(path), fn);
  }

  async link(path: string, id: string, heading?: string): Promise<void> {
    const file = this.file(path);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm[LINK_PROPERTY] = withLinkedId(fm[LINK_PROPERTY], id);
      if (heading !== undefined) setHeadingProperty(fm, id, heading);
    });
    this.plugin.notePendingLink(file.path, id);
  }

  unlink(path: string, id: string): Promise<void> {
    return this.plugin.unlink(normalizePath(path), id);
  }

  saveAttachment(name: string, data: Uint8Array, notePath: string): Promise<{ path: string; created: boolean }> {
    const { vault, fileManager } = this.app;
    return saveDeduped(
      {
        availablePath: async (file, note) => normalizePath(await fileManager.getAvailablePathForAttachment(file, normalizePath(note))),
        size: (path) => vault.getFileByPath(normalizePath(path))?.stat.size ?? null,
        read: async (path) => new Uint8Array(await vault.readBinary(this.file(path))),
        write: async (path, bytes) => {
          await vault.createBinary(normalizePath(path), wholeBuffer(bytes));
        },
      },
      safeFileName(name),
      data,
      notePath,
    );
  }

  linkTo(path: string, notePath: string, alias?: string): string {
    const file = this.file(path);
    return this.app.fileManager.generateMarkdownLink(file, normalizePath(notePath), undefined, alias);
  }

  private file(path: string): TFile {
    const file = this.app.vault.getFileByPath(normalizePath(path));
    if (!file) throw new Error("the Obsidian note is missing");
    return file;
  }

  private async readFrontmatter(file: TFile): Promise<unknown> {
    const info = getFrontMatterInfo(await this.app.vault.cachedRead(file));
    if (!info.exists) return null;
    try {
      return parseYaml(info.frontmatter) as unknown;
    } catch {
      return null;
    }
  }

  private async ensureFolder(folder: string): Promise<void> {
    // One level at a time, so a nested folder that doesn't exist yet works.
    let current = "";
    for (const part of folder.split("/")) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }
}

/** Pick a file from disk, or one of the Jot exports already in the vault. */
class ImportModal extends Modal {
  constructor(
    app: App,
    private plugin: JotImportPlugin,
  ) {
    super(app);
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("Import a Jot export");

    const input = contentEl.createEl("input", { type: "file" });
    input.accept = ".md,.txt,.zip,text/markdown,text/plain,application/zip";
    input.hidden = true;
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      this.close();
      void this.plugin.importPickedFile(file);
    });

    new Setting(contentEl)
      .setName("Choose a file")
      .setDesc("A .md or .zip file exported from Jot with Obsidian Format toggled on.")
      .addButton((btn) => {
        btn.setButtonText("Choose…").setCta().onClick(() => input.click());
      });

    const candidates = await this.plugin.candidateFiles();
    if (candidates.length > 0) {
      new Setting(contentEl).setName("In this vault").setHeading();
      for (const { file, text } of candidates) {
        const when = new Date(file.stat.mtime).toLocaleString();
        new Setting(contentEl)
          .setName(file.path)
          .setDesc(this.importedNote(text, when))
          .addButton((btn) =>
            btn.setButtonText("Import").onClick(() => {
              this.close();
              void this.plugin.importVaultFile(file);
            }),
          );
      }
    }
  }

  private importedNote(text: string | null, when: string): string {
    if (text === null) return when;
    const prior = this.plugin.priorImport(text);
    if (prior.kind === "done") return `${when}. Already imported.`;
    if (prior.kind === "stopped") return `${when}. Import was interrupted. Importing it again will finish it.`;
    return when;
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Characters Obsidian refuses in file names become "-". */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "attachment";
}
