import { App, Modal, Notice, Plugin, Setting, TFile, debounce, getFrontMatterInfo, normalizePath, parseYaml } from "obsidian";
import { isJotExport, parseJotExport, type Position } from "./format";
import { fingerprint, type ImportResult, type LinkChoice, planImport, resolvePlan, runImport, type VaultPort } from "./importer";
import { LinkModal } from "./link-modal";
import {
  aliasesFrom,
  LINK_PROPERTY,
  linkedIdsFrom,
  type NoteInfo,
  type RoutingMode,
  withLinkedId,
  withoutLinkedId,
} from "./routing";
import { JotImportSettingTab } from "./settings";

interface JotImportSettings {
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

const DEFAULT_SETTINGS: JotImportSettings = {
  mode: "name",
  folder: "",
  position: "bottom",
  heading: "",
  trashAfterImport: true,
  offerNewExports: true,
};

/** One finished import, kept so the same file isn't imported twice by accident. */
interface ImportRecord {
  fingerprint: string;
  importedAt: number;
  notes: number;
}

/** Saved beside the settings: recent imports, and the last-seen name of each category id. */
interface PluginState {
  history: ImportRecord[];
  categoryNames: Record<string, string>;
}

const HISTORY_LIMIT = 100;

export default class JotImportPlugin extends Plugin {
  settings: JotImportSettings = { ...DEFAULT_SETTINGS };
  private state: PluginState = { history: [], categoryNames: {} };
  /** Exports already offered this session, so a notice shows once per file. */
  private offered = new Set<string>();
  /** Set while an import runs, so a second one can't interleave writes. */
  private busy = false;
  private settingTab: JotImportSettingTab | null = null;
  /** Notes that held a link at the last look, so removing one by hand refreshes the list too. */
  private linkedPaths = new Set<string>();

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
        if (!file || file.extension !== "md") return false;
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
        const linked = linkedIdsFrom(cache.frontmatter).length > 0;
        if (linked || this.linkedPaths.has(file.path)) {
          if (linked) this.linkedPaths.add(file.path);
          else this.linkedPaths.delete(file.path);
          refresh();
        }
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
      void this.offerRecentExports();
      this.settingTab?.update();
    });
  }

  async loadSettings() {
    const saved = ((await this.loadData()) ?? {}) as Partial<JotImportSettings & PluginState>;
    const { history, categoryNames, ...settings } = saved;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
    this.state = {
      history: Array.isArray(history) ? history : [],
      categoryNames: categoryNames && typeof categoryNames === "object" ? categoryNames : {},
    };
  }

  async saveSettings() {
    await this.saveData({ ...this.settings, ...this.state });
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

  /** Remove one category's id from a note's properties. */
  async unlink(path: string, id: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return;
    const indexed = this.metadataChange(file);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      const next = withoutLinkedId(fm[LINK_PROPERTY], id);
      if (next) fm[LINK_PROPERTY] = next;
      else delete fm[LINK_PROPERTY];
    });
    await indexed;
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
    const text = await this.app.vault.read(file);
    if (!isJotExport(text)) {
      new Notice(`${file.name} is not a Jot export.`);
      return;
    }
    const result = await this.importText(text, file.path);
    if (result && this.settings.trashAfterImport && this.app.vault.getFileByPath(file.path)) {
      await this.app.fileManager.trashFile(file);
    }
  }

  /**
   * Import export text from anywhere (a picked file, a vault file). Returns
   * null when nothing was written (not an export, cancelled, or failed), so
   * the caller keeps the file.
   */
  async importText(text: string, sourcePath: string | null = null): Promise<ImportResult | null> {
    if (this.busy) {
      new Notice("An import is already running. Try again in a moment.");
      return null;
    }
    this.busy = true;
    try {
      return await this.runImport(text, sourcePath);
    } finally {
      this.busy = false;
    }
  }

  private async runImport(text: string, sourcePath: string | null): Promise<ImportResult | null> {
    const parsed = parseJotExport(text);
    if (!parsed) {
      new Notice(
        isJotExport(text)
          ? "This export is from a newer Jot. Update Jot Import to read it."
          : "That file is not a Jot export this plugin understands.",
      );
      return null;
    }
    if (parsed.blocks.length === 0) {
      new Notice("The Jot export has no jots in it.");
      return null;
    }

    const print = fingerprint(text);
    const earlier = this.state.history.find((r) => r.fingerprint === print);
    if (earlier && !(await confirmReimport(this.app, earlier.importedAt))) return null;

    const port = new ObsidianVault(this.app);
    const notes = await port.notes();
    const exclude = new Set(sourcePath ? [sourcePath] : []);
    const plan = planImport(parsed, notes, this.settings, exclude);

    let choices = new Map<string, LinkChoice>();
    if (plan.toLink.length > 0) {
      const answered = await LinkModal.ask(
        this.app,
        plan.toLink,
        notes.filter((n) => !exclude.has(n.path)),
      );
      if (!answered) return null;
      choices = answered;
    }

    const writes = resolvePlan(plan, choices);
    const { result, error } = await runImport(writes, port, {
      position: this.settings.position,
      heading: this.settings.heading,
    });

    for (const block of parsed.blocks) {
      if (block.id) this.state.categoryNames[block.id] = block.name;
    }
    if (!error) {
      this.state.history = [{ fingerprint: print, importedAt: Date.now(), notes: result.notes.length }, ...this.state.history].slice(
        0,
        HISTORY_LIMIT,
      );
    }
    await this.saveSettings();
    this.settingTab?.update();

    if (error) {
      const done = result.notes.length > 0 ? ` Already added to: ${result.notes.join(", ")}.` : "";
      new Notice(`Jot Import stopped at ${error.path}: ${error.message}.${done} The export file was kept.`, 0);
      return null;
    }
    new Notice(summary(result, plan.unlinkable, plan.ambiguous), 8000);
    return result;
  }

  /** Vault files that look like Jot exports (by name, then by header), newest first. */
  async candidateFiles(): Promise<TFile[]> {
    const byName = this.app.vault
      .getMarkdownFiles()
      .filter(looksLikeExportName)
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    const out: TFile[] = [];
    for (const file of byName) {
      if (isJotExport(await this.app.vault.cachedRead(file))) out.push(file);
    }
    return out;
  }

  /** Whether this exact export text was imported before. */
  wasImported(text: string): boolean {
    const print = fingerprint(text);
    return this.state.history.some((r) => r.fingerprint === print);
  }

  /** A notice with an Import button for a new export in the vault (once per file per session). */
  private async offerImport(file: TFile): Promise<void> {
    if (!this.settings.offerNewExports || file.extension !== "md" || !looksLikeExportName(file)) return;
    if (this.offered.has(file.path)) return;
    const text = await this.app.vault.cachedRead(file);
    if (!isJotExport(text) || this.wasImported(text)) return;
    this.offered.add(file.path);

    const notice = new Notice(
      createFragment((f) => {
        f.createDiv({ text: `New Jot export: ${file.basename}` });
        const actions = f.createDiv({ cls: "jot-import-notice-actions" });
        actions.createEl("button", { text: "Import", cls: "mod-cta" }, (btn) =>
          btn.addEventListener("click", () => {
            notice.hide();
            void this.importVaultFile(file);
          }),
        );
        actions.createEl("button", { text: "Not now" }, (btn) => btn.addEventListener("click", () => notice.hide()));
      }),
      0,
    );
  }

  /** At startup: offer the newest export that arrived in the last few days and wasn't imported. */
  private async offerRecentExports(): Promise<void> {
    if (!this.settings.offerNewExports) return;
    const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const recent = (await this.candidateFiles()).filter((f) => f.stat.mtime >= cutoff);
    for (const file of recent) {
      const text = await this.app.vault.cachedRead(file);
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

function summary(result: ImportResult, unlinkable: number, ambiguous: string[]): string {
  const count = result.notes.length === 1 ? "1 note" : `${result.notes.length} notes`;
  const parts = [`Jot: added to ${count}: ${result.notes.join(", ")}.`];
  if (result.created.length > 0) parts.push(`Created ${result.created.join(", ")}.`);
  if (result.linked.length > 0) {
    parts.push(result.linked.length === 1 ? "Linked 1 category." : `Linked ${result.linked.length} categories.`);
  }
  if (unlinkable > 0) parts.push("This export is from an older Jot, so it went by note name. Update Jot to link categories.");
  if (ambiguous.length > 0) parts.push(`More than one note is linked to ${ambiguous.join(", ")}; the first was used.`);
  return parts.join(" ");
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
  constructor(private app: App) {}

  async notes(): Promise<NoteInfo[]> {
    const out: NoteInfo[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      // Not indexed yet (right after startup): read the frontmatter
      // directly, so a linked note is never mistaken for an unlinked one.
      const fm: unknown = cache ? cache.frontmatter : await this.readFrontmatter(file);
      out.push({ path: file.path, basename: file.basename, aliases: aliasesFrom(fm), linkedIds: linkedIdsFrom(fm) });
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

  async link(path: string, id: string): Promise<void> {
    await this.app.fileManager.processFrontMatter(this.file(path), (fm: Record<string, unknown>) => {
      fm[LINK_PROPERTY] = withLinkedId(fm[LINK_PROPERTY], id);
    });
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
    input.accept = ".md,.txt,text/markdown,text/plain";
    input.hidden = true;
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      void (async () => {
        const text = await file.text();
        this.close();
        await this.plugin.importText(text);
      })();
    });

    new Setting(contentEl)
      .setName("Choose a file")
      .setDesc("A .md file exported from Jot with Obsidian Format on.")
      .addButton((btn) => {
        btn.setButtonText("Choose…").setCta().onClick(() => input.click());
      });

    const candidates = await this.plugin.candidateFiles();
    if (candidates.length > 0) {
      new Setting(contentEl).setName("In this vault").setHeading();
      for (const file of candidates) {
        const text = await this.app.vault.cachedRead(file);
        const when = new Date(file.stat.mtime).toLocaleString();
        new Setting(contentEl)
          .setName(file.path)
          .setDesc(this.plugin.wasImported(text) ? `${when}. Already imported.` : when)
          .addButton((btn) =>
            btn.setButtonText("Import").onClick(() => {
              this.close();
              void this.plugin.importVaultFile(file);
            }),
          );
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
