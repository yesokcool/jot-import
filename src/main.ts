import { App, Modal, Notice, Plugin, Setting, TFile, TFolder, debounce, getFrontMatterInfo, normalizePath, parseYaml } from "obsidian";
import { dataToSave, DEFAULT_SETTINGS, HISTORY_LIMIT, type JotImportSettings, mergeState, type PluginState, readSaved } from "./data";
import { isJotExport, isWholeExport, parseJotExport } from "./format";
import {
  fingerprint,
  type ImportResult,
  type LinkChoice,
  type MediaSource,
  OFFER_WINDOW,
  OfferedExports,
  planImport,
  type PriorImport,
  priorImport,
  recordImport,
  resolvePlan,
  runImport,
  stoppedText,
  summaryText,
  type VaultPort,
} from "./importer";
import { type LinkContext, LinkModal } from "./link-modal";
import {
  aliasesFrom,
  HEADING_PROPERTY,
  headingsFrom,
  LINK_PROPERTY,
  linkedIdsFrom,
  movedFolder,
  type NoteInfo,
  resolveFolder,
  withHeading,
  withLinkedId,
  withoutLinkedId,
} from "./routing";
import { JotImportSettingTab } from "./settings";
import { looksLikeZip, ZIP_LIMITS, ZipError } from "./zip";
import { openZipExport, type ZipExport } from "./zip-export";

export default class JotImportPlugin extends Plugin {
  settings: JotImportSettings = { ...DEFAULT_SETTINGS };
  /** The settings the user set (or a 1.0 install saved); only these are saved, see `readSaved`. */
  private chosen = new Set<string>();
  private state: PluginState = { history: [], categoryNames: {} };
  /** The export text in each zip looked at, by path, so listing exports doesn't unzip them again. */
  private zipTexts = new Map<string, { stamp: string; text: string | null }>();
  /** Exports already offered this session, so a notice shows once per file. */
  private offered = new OfferedExports();
  /** Set while an import runs, so a second one can't interleave writes. */
  private busy = false;
  private settingTab: JotImportSettingTab | null = null;
  /** Notes that held a link at the last look, so removing one by hand refreshes the list too. */
  private linkedPaths = new Set<string>();
  /**
   * Links this plugin just wrote that Obsidian's index may not show yet, by
   * note path. An import right after another reads them from here, so it
   * doesn't ask about a category that was linked a moment ago.
   */
  private pendingLinks = new Map<string, Set<string>>();
  /**
   * The new-export notice last shown (one at a time), hidden when a newer
   * export's takes its place, and on unload so its Import button can't run
   * a disabled plugin.
   */
  private offerNotice: Notice | null = null;

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

    // Keep the settings' "Linked notes" list current when a link is added
    // or removed anywhere, including by hand in the properties panel.
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

    // A file that's gone frees its path, so the next export saved there
    // (the same day's, by Jot's file names) is offered too.
    this.registerEvent(this.app.vault.on("delete", (file) => this.offered.release(file.path)));

    // The folder setting follows its folder when it's renamed or moved, so
    // the category notes aren't started again in a new, empty folder.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.offered.release(oldPath);
        if (!(file instanceof TFolder)) return;
        const folder = movedFolder(this.settings.folder, oldPath, file.path);
        if (folder === null) return;
        this.settings.folder = folder;
        void this.saveSettings();
        this.settingTab?.update();
      }),
    );

    // Registered after layout-ready so the vault's initial load doesn't
    // count as new files; exports that arrived while Obsidian was closed
    // are picked up by the one-time look below instead.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (file instanceof TFile) void this.offerImport(file);
        }),
      );
      // A zip still being copied in can't be read when it appears; it's
      // offered once it's whole (the offer is still once per file).
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && file.extension === "zip") void this.offerImport(file);
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

  /** The user set this setting: it's saved from now on, and no longer follows the default. */
  chooseSetting(key: string) {
    this.chosen.add(key);
  }

  /**
   * data.json changed on disk: another device's arrived by Obsidian Sync
   * (or another program wrote it). Its settings replace this device's, so
   * stale ones in memory can't revert them at the next save. The import
   * histories are merged rather than replaced, so the repeat-import guard
   * knows what every device imported; what only this device knew is saved
   * back. Obsidian refreshes the settings tab afterwards.
   */
  async onExternalSettingsChange() {
    const { settings, state, chosen } = readSaved(await this.loadData());
    const merged = mergeState(state, this.state);
    this.settings = settings;
    this.chosen = new Set(chosen);
    this.state = merged.state;
    if (merged.news) await this.saveSettings();
  }

  /** Remember which notes hold links (the settings list reads them). */
  noteLinked(path: string, linked: boolean) {
    if (linked) this.linkedPaths.add(path);
    else this.linkedPaths.delete(path);
  }

  /** The name a category id had in the last export that carried it. */
  categoryName(id: string): string {
    return this.state.categoryNames[id] ?? `Category ${id.slice(0, 8)}`;
  }

  /** Remove one category's id (and its heading) from a note's properties. */
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

  /** Set a linked category's own heading in its note ("" for none; undefined: the Heading setting). */
  async setCategoryHeading(path: string, id: string, heading: string | undefined): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return;
    const indexed = this.metadataChange(file);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => setHeadingProperty(fm, id, heading));
    await indexed;
  }

  /** The headings in a note, in order, as Obsidian indexed them. */
  headingsOf(path: string): Array<{ heading: string; level: number }> {
    const file = this.app.vault.getFileByPath(path);
    const headings = file ? this.app.metadataCache.getFileCache(file)?.headings : undefined;
    return (headings ?? []).map((h) => ({ heading: h.heading, level: h.level }));
  }

  /** What the "choose notes" dialogs need, with the export file at `exclude` left out. */
  linkContext(notes: NoteInfo[], exclude: Set<string> = new Set()): LinkContext {
    const folders = this.app.vault.getAllFolders(false).map((f) => f.path);
    return {
      notes: notes.filter((n) => !exclude.has(n.path)),
      folders,
      folder: resolveFolder(folders, this.settings.folder),
      heading: this.settings.heading,
      exclude,
      headingsOf: (path) => this.headingsOf(path),
    };
  }

  onunload() {
    this.offerNotice?.hide();
    this.offerNotice = null;
  }

  /** A link just written to a note, until Obsidian's index shows it. */
  notePendingLink(path: string, id: string) {
    const ids = this.pendingLinks.get(path) ?? new Set<string>();
    ids.add(id.toUpperCase());
    this.pendingLinks.set(path, ids);
  }

  /** The note's links as written but maybe not indexed yet. */
  pendingLinksOf(path: string): string[] {
    return [...(this.pendingLinks.get(path) ?? [])];
  }

  /** Obsidian indexed the note: the links it shows are no longer pending. */
  private indexedLinks(path: string, ids: string[]) {
    const pending = this.pendingLinks.get(path);
    if (!pending) return;
    for (const id of ids) pending.delete(id);
    if (pending.size === 0) this.pendingLinks.delete(path);
  }

  /** Resolves once Obsidian has re-read the file's properties (or after a second), so a list built next sees the change. */
  private metadataChange(file: TFile): Promise<void> {
    return new Promise((resolve) => {
      const ref = this.app.metadataCache.on("changed", (changed) => {
        if (changed.path !== file.path) return;
        this.app.metadataCache.offref(ref);
        resolve();
      });
      window.setTimeout(() => {
        this.app.metadataCache.offref(ref);
        resolve();
      }, 1000);
    });
  }

  /** Import a file that lives inside the vault, then trash it if configured. */
  async importVaultFile(file: TFile): Promise<void> {
    if (!this.app.vault.getFileByPath(file.path)) {
      new Notice(`${file.name} is gone. It may have been imported on another device.`);
      return;
    }
    if (file.extension === "zip") return this.importVaultZip(file);
    const text = await this.app.vault.read(file);
    if (!isJotExport(text)) {
      new Notice(`${file.name} is not a Jot export.`);
      return;
    }
    const result = await this.importText(text, file.path);
    if (!result || !this.settings.trashAfterImport || !this.app.vault.getFileByPath(file.path)) return;
    // Only the file exactly as imported, and only if it is the export alone:
    // a note the export was pasted into, or a file replaced while the
    // import ran, keeps its other text.
    if (isWholeExport(text) && (await this.app.vault.read(file)) === text) {
      await this.app.fileManager.trashFile(file);
    } else {
      new Notice(`Kept ${file.name} because it holds more than the imported export.`);
    }
  }

  /**
   * A zipped export in the vault (Jot shares one when the export has photos
   * or files): the jots go in, the files they point at are saved where
   * Obsidian saves attachments, and the zip goes to the trash like a .md
   * export, if it's unchanged and holds only the export.
   */
  private async importVaultZip(file: TFile): Promise<void> {
    const stamp = stampOf(file);
    let zip: ZipExport;
    try {
      zip = await this.openZip(file);
    } catch (e) {
      new Notice(zipProblem(file.name, e), 0);
      return;
    }
    const result = await this.importText(zip.text, file.path, mediaOf(zip));
    const still = this.app.vault.getFileByPath(file.path);
    if (!result || !this.settings.trashAfterImport || !still) return;
    if (zip.onlyExport && isWholeExport(zip.text) && stampOf(still) === stamp) {
      await this.app.fileManager.trashFile(still);
    } else {
      new Notice(`Kept ${file.name} because it holds more than the imported export.`);
    }
  }

  /** A vault zip's export, refusing one too large to read into memory. */
  private async openZip(file: TFile): Promise<ZipExport> {
    if (file.stat.size > ZIP_LIMITS.zipBytes) throw new ZipError("The zip is too large to import.");
    return openZipExport(new Uint8Array(await this.app.vault.readBinary(file)));
  }

  /** Import a file picked from disk: a .md export, or a zipped one. Nothing is done to the file itself. */
  async importPickedFile(file: File): Promise<void> {
    if (file.size > ZIP_LIMITS.zipBytes) {
      new Notice(`${file.name} is too large to import.`);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!looksLikeZip(bytes)) {
      await this.importText(new TextDecoder("utf-8").decode(bytes));
      return;
    }
    let zip: ZipExport;
    try {
      zip = await openZipExport(bytes);
    } catch (e) {
      new Notice(zipProblem(file.name, e), 0);
      return;
    }
    await this.importText(zip.text, null, mediaOf(zip));
  }

  /**
   * Import export text from anywhere (a picked file, a vault file). Returns
   * null when nothing was written (not an export, cancelled, or failed), so
   * the caller keeps the file. `media`: a zipped export's attachments.
   */
  async importText(text: string, sourcePath: string | null = null, media?: MediaSource): Promise<ImportResult | null> {
    if (this.busy) {
      new Notice("An import is already running. Try again in a moment.");
      return null;
    }
    this.busy = true;
    try {
      return await this.runImport(text, sourcePath, media);
    } finally {
      this.busy = false;
    }
  }

  private async runImport(text: string, sourcePath: string | null, media?: MediaSource): Promise<ImportResult | null> {
    const parsed = parseJotExport(text);
    if (!parsed) {
      new Notice(
        isJotExport(text)
          ? "This export is from a newer Jot. Update Jot Import to read it."
          : "That file is not a Jot export this plugin understands.",
      );
      return null;
    }
    if (parsed.problem) {
      // Importing anyway would leave out the jots the markers cut off, and
      // then trash the only copy of them, so nothing is written.
      new Notice(`Jot Import can't import this export without losing jots. ${parsed.problem} The file was kept.`, 0);
      return null;
    }
    if (parsed.blocks.length === 0) {
      new Notice("The Jot export has no jots in it.");
      return null;
    }

    const print = fingerprint(text);
    const prior = priorImport(this.state.history, print);
    if (prior.kind === "done" && !(await confirmReimport(this.app, prior.at))) return null;
    // An import of this file that stopped partway wrote its first blocks
    // already: carry on after them rather than add them a second time.
    const skip = prior.kind === "stopped" ? prior.written : 0;
    const remaining = { ...parsed, blocks: parsed.blocks.slice(skip) };

    const port = new ObsidianVault(this.app, this);
    const notes = await port.notes();
    const exclude = new Set(sourcePath ? [sourcePath] : []);
    const folders = this.app.vault.getAllFolders(false).map((f) => f.path);
    const folder = resolveFolder(folders, this.settings.folder);
    const plan = planImport(remaining, notes, { ...this.settings, folder }, exclude);

    let choices = new Map<string, LinkChoice>();
    if (plan.toLink.length > 0) {
      const answered = await LinkModal.ask(this.app, plan.toLink, this.linkContext(notes, exclude));
      if (!answered) return null;
      choices = answered;
    }

    const writes = resolvePlan(plan, choices);
    // How far this import got is saved before the first write and after
    // each block but the last (the finished record follows right after),
    // so an import cut off midway (Obsidian quit or killed, the plugin
    // reloaded) resumes after what it wrote instead of adding it again. At
    // worst the one block it was writing when it stopped goes in twice.
    const previous = this.state.history.find((r) => r.fingerprint === print);
    const saveProgress = async (written: number, notes: number) => {
      const progress = { fingerprint: print, importedAt: Date.now(), notes, stoppedAfter: skip + written };
      this.state.history = recordImport(this.state.history, progress, HISTORY_LIMIT);
      await this.saveSettings();
    };
    await saveProgress(0, 0);
    const { result, error, written } = await runImport(
      writes,
      port,
      { position: this.settings.position, heading: this.settings.heading },
      (count, sofar) => (count < writes.length ? saveProgress(count, sofar.notes.length) : Promise.resolve()),
      media,
    );

    for (const block of parsed.blocks) {
      if (block.id) this.state.categoryNames[block.id] = block.name;
    }
    const record = { fingerprint: print, importedAt: Date.now(), notes: result.notes.length };
    if (!error) {
      this.state.history = recordImport(this.state.history, record, HISTORY_LIMIT);
    } else if (skip + written > 0) {
      this.state.history = recordImport(this.state.history, { ...record, stoppedAfter: skip + written }, HISTORY_LIMIT);
    } else {
      // Nothing went in: the history goes back to what it said before.
      this.state.history = previous
        ? recordImport(this.state.history, previous, HISTORY_LIMIT)
        : this.state.history.filter((r) => r.fingerprint !== print);
    }
    await this.saveSettings();
    this.settingTab?.update();

    if (error) {
      new Notice(stoppedText(error, result), 0);
      return null;
    }
    new Notice(summaryText(result, plan.unlinkable, plan.ambiguous, skip, plan.besideExport), 8000);
    return result;
  }

  /**
   * Vault files that look like Jot exports (.md or .zip, by name, then by
   * header), newest first, with the export text read to check the header so
   * callers don't read each file again.
   */
  async candidateFiles(): Promise<Array<{ file: TFile; text: string }>> {
    const byName = this.app.vault
      .getFiles()
      .filter((f) => isExportExtension(f) && looksLikeExportName(f))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    const out: Array<{ file: TFile; text: string }> = [];
    for (const file of byName) {
      const text = await this.exportTextOf(file);
      if (text !== null) out.push({ file, text });
    }
    return out;
  }

  /** The export text in a vault file (a .md, or the one in a .zip), or null when it holds none Jot Import can read. */
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
      // Not an export Jot Import can read; importing it says why.
    }
    this.zipTexts.set(file.path, { stamp, text });
    return text;
  }

  /** What the history says about this exact export text: new, imported, or stopped partway. */
  priorImport(text: string): PriorImport {
    return priorImport(this.state.history, fingerprint(text));
  }

  /** Whether this exact export text was imported to the end before. */
  wasImported(text: string): boolean {
    return this.priorImport(text).kind === "done";
  }

  /**
   * A notice with an Import button for a new export in the vault: once per
   * file per session, only for a recent export, one notice at a time (see
   * `OfferedExports.claim`).
   */
  private async offerImport(file: TFile): Promise<void> {
    if (!this.settings.offerNewExports || !isExportExtension(file) || !looksLikeExportName(file)) return;
    if (this.offered.has(file.path)) return;
    const text = await this.exportTextOf(file);
    if (text === null || this.wasImported(text) || !this.offered.claim(file.path, file.stat.mtime, Date.now())) return;

    // A newer export than the one offered before: its notice takes that one's place.
    this.offerNotice?.hide();
    const close = () => {
      notice.hide();
      if (this.offerNotice === notice) this.offerNotice = null;
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
    this.offerNotice = notice;
  }

  /** At startup: offer the newest export that arrived in the last few days and wasn't imported. */
  private async offerRecentExports(): Promise<void> {
    if (!this.settings.offerNewExports) return;
    const cutoff = Date.now() - OFFER_WINDOW;
    const recent = (await this.candidateFiles()).filter(({ file }) => file.stat.mtime >= cutoff);
    for (const { file, text } of recent) {
      if (!this.wasImported(text)) {
        await this.offerImport(file);
        return;
      }
    }
  }
}

function looksLikeExportName(file: TFile): boolean {
  return /^jot-export/i.test(file.basename) || /jots$/i.test(file.basename);
}

/** A Markdown export, or a zipped one (Jot zips the export when it has photos or files). */
function isExportExtension(file: TFile): boolean {
  return file.extension === "md" || file.extension === "zip";
}

/** Size and modified time: whether a file changed between two looks at it. */
function stampOf(file: TFile): string {
  return `${file.stat.size}:${file.stat.mtime}`;
}

/** A zipped export's attachments, for the importer. */
function mediaOf(zip: ZipExport): MediaSource {
  return {
    has: (ref) => zip.media.has(ref),
    read: (ref) => {
      const entry = zip.media.get(ref);
      if (!entry) throw new ZipError("The file isn't in the zip.");
      return zip.read(entry);
    },
  };
}

/** The notice for a zip that can't be imported. */
function zipProblem(name: string, e: unknown): string {
  const reason = e instanceof ZipError ? e.message : "It can't be read as a zip.";
  return `Jot Import can't import ${name}. ${reason}`;
}

/** Set (or with undefined, remove) one category's entry in a note's `jot-category-heading`. */
function setHeadingProperty(fm: Record<string, unknown>, id: string, heading: string | undefined) {
  const next = withHeading(fm[HEADING_PROPERTY], id, heading);
  if (next) fm[HEADING_PROPERTY] = next;
  else delete fm[HEADING_PROPERTY];
}

/** Ask before importing the same file a second time. */
function confirmReimport(app: App, importedAt: number): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let answered = false;
    modal.setTitle("Import this export again?");
    modal.contentEl.createEl("p", {
      text: `You imported this exact file on ${new Date(importedAt).toLocaleString()}. Importing it again adds the same jots a second time.`,
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
      // Not indexed yet (right after startup): read the frontmatter
      // directly, so a linked note is never mistaken for an unlinked one.
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

  async saveAttachment(name: string, data: Uint8Array, notePath: string): Promise<{ path: string; created: boolean }> {
    // Obsidian's own rule for where a pasted file goes (the vault root, a
    // folder, beside the note, or a subfolder of it), deduped against what's
    // there, with the folder created if missing.
    const path = normalizePath(await this.app.fileManager.getAvailablePathForAttachment(safeFileName(name), normalizePath(notePath)));
    // A deduped name means a file by the plain name is already there. The
    // same bytes (this export imported before) are used rather than copied.
    const plain = normalizePath(`${path.slice(0, path.lastIndexOf("/") + 1)}${safeFileName(name)}`);
    if (plain !== path) {
      const existing = this.app.vault.getFileByPath(plain);
      if (existing && existing.stat.size === data.byteLength && sameBytes(new Uint8Array(await this.app.vault.readBinary(existing)), data)) {
        return { path: plain, created: false };
      }
    }
    await this.app.vault.createBinary(path, data.slice().buffer);
    return { path, created: true };
  }

  linkTo(path: string, notePath: string, alias?: string): string {
    const file = this.file(path);
    return this.app.fileManager.generateMarkdownLink(file, normalizePath(notePath), undefined, alias);
  }

  private file(path: string): TFile {
    const file = this.app.vault.getFileByPath(normalizePath(path));
    if (!file) throw new Error("the note is missing");
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
    // Create each level so a nested folder that doesn't exist yet works.
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
      .setDesc("A .md or .zip file exported from Jot with Obsidian Format on.")
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

  /** A candidate's description: when it arrived, and whether it was imported or stopped partway. */
  private importedNote(text: string, when: string): string {
    const prior = this.plugin.priorImport(text);
    if (prior.kind === "done") return `${when}. Already imported.`;
    if (prior.kind === "stopped") return `${when}. Stopped partway; importing it again finishes it.`;
    return when;
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** A file name Obsidian accepts: the characters it refuses become "-". */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "attachment";
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
