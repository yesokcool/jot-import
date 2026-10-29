import { AbstractInputSuggest, App, Modal, prepareFuzzySearch, Setting, setIcon, type TextComponent } from "obsidian";
import { headingInputValue, headingName, headingSettingFor, noteNameFor } from "./format";
import type { LinkChoice, LinkRequest } from "./importer";
import { cleanFolder, fold, joinPath, type NoteInfo, resolveFolder } from "./routing";

/** What the dialogs need to know about the vault and the settings. */
export interface LinkContext {
  /** Every note that can be chosen (the export file left out). */
  notes: NoteInfo[];
  /** The vault's folder paths, so a typed folder is spelled the way the vault spells it. */
  folders: string[];
  /** Where a typed note name without a folder is created (the Folder setting). */
  folder: string;
  /** The Heading setting: where every category's jots go unless it has a heading of its own. */
  heading: string;
  /** Paths that can't be chosen or created (the export file). */
  exclude: Set<string>;
  /** The headings in a note, in order. */
  headingsOf(path: string): Array<{ heading: string; level: number }>;
}

/** Where a row's jots go: the note, whether it exists yet, and the heading in it. */
interface Target {
  path: string;
  exists: boolean;
  /** The effective heading ("" for the note itself). */
  heading: string;
}

/**
 * Asks which note each new category goes into, once. Every row starts on
 * the same-named note if there is one, else a new note, so most imports
 * are one tap: "Link all and import". "Change" picks another note, a new
 * one with a name of your own, and a heading in it. Resolves to the
 * answers, or null when the user cancels (then nothing is written).
 */
export class LinkModal extends Modal {
  private choices = new Map<string, LinkChoice>();
  private done = false;

  private constructor(
    app: App,
    private requests: LinkRequest[],
    private context: LinkContext,
    private finish: (choices: Map<string, LinkChoice> | null) => void,
  ) {
    super(app);
    for (const request of requests) {
      const pick = request.suggestion.pick;
      this.choices.set(request.block.id, pick ? { kind: "note", path: pick.path } : { kind: "new" });
    }
  }

  static ask(app: App, requests: LinkRequest[], context: LinkContext): Promise<Map<string, LinkChoice> | null> {
    return new Promise((resolve) => new LinkModal(app, requests, context, resolve).open());
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("jot-import-link-modal");
    const count = this.requests.length;
    this.setTitle(count === 1 ? "Choose an Obsidian note for 1 category" : `Choose Obsidian notes for ${count} categories`);
    contentEl.createEl("p", {
      cls: "jot-import-lede",
      text:
        count === 1
          ? "A default selection has been made based on the category name. This selection will be saved for future imports and can be changed in the plugin's settings."
          : "Default selections have been made based on category name. These selections will be saved for future imports and can be changed in the plugin's settings.",
    });

    const list = contentEl.createDiv({ cls: "jot-import-link-list" });
    for (const request of this.requests) this.renderRow(list.createDiv({ cls: "jot-import-link-row" }), request);

    new Setting(contentEl)
      .setClass("jot-import-link-buttons")
      .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((btn) =>
        btn
          .setButtonText(count === 1 ? "Link and import" : "Link all and import")
          .setCta()
          .onClick(() => {
            this.done = true;
            this.finish(this.choices);
            this.close();
          }),
      );
  }

  private target(request: LinkRequest, choice: LinkChoice): Target {
    const heading = choice.heading ?? this.context.heading;
    if (choice.kind === "note") return { path: choice.path, exists: true, heading };
    if (choice.path === undefined) return { path: request.newPath, exists: request.newPathExists, heading };
    return { path: choice.path, exists: false, heading };
  }

  private renderRow(el: HTMLElement, request: LinkRequest) {
    el.empty();
    const id = request.block.id;
    const choice = this.choices.get(id) ?? { kind: "new" };
    const target = this.target(request, choice);
    const heading = headingName(target.heading);

    const info = el.createDiv({ cls: "jot-import-link-info" });
    const line = info.createDiv({ cls: "jot-import-link-line" });
    line.createSpan({ cls: "jot-import-link-category", text: request.block.name });
    line.createSpan({ cls: "jot-import-link-arrow", text: "→", attr: { "aria-hidden": "true" } });
    line.createSpan({ cls: "jot-import-link-note", text: fileName(target.path) });
    if (heading) line.createSpan({ cls: "jot-import-link-heading", text: `› ${heading}` });

    const where = info.createDiv({ cls: "jot-import-target" });
    setIcon(where.createSpan({ cls: "jot-import-target-icon" }), target.exists ? "file-text" : "file-plus");
    const whereText = where.createSpan({ text: target.exists ? target.path : `New note: ${target.path}` });
    if (heading && !(target.exists && hasHeading(this.context.headingsOf(target.path), heading))) {
      whereText.createSpan({ cls: "jot-import-target-new", text: " · New heading" });
    }

    // The suggested note stays a chip while something else is chosen, so
    // trying another chip is one tap to undo.
    const pick = request.suggestion.pick;
    const others = [...(pick ? [pick] : []), ...request.suggestion.others].filter((n) => !(choice.kind === "note" && n.path === choice.path));
    // "New note" only when it would land somewhere else than the chosen note
    // and the suggested one (already the folder's same-named note).
    const showNew =
      (choice.kind === "note" || choice.path !== undefined) && fold(target.path) !== fold(request.newPath) && pick?.path !== request.newPath;
    if (others.length > 0 || showNew) {
      const chips = info.createDiv({ cls: "jot-import-chips" });
      chips.createSpan({ cls: "jot-import-chips-label", text: "More suggestions:" });
      // A chip picks a note; the heading goes back to the default, since the
      // one chosen before may not be in it.
      for (const note of others) {
        const chip = chips.createEl("button", { cls: "jot-import-chip", text: note.basename });
        chip.setAttribute("aria-label", `Use ${note.path}`);
        chip.addEventListener("click", () => {
          this.choices.set(id, { kind: "note", path: note.path });
          this.renderRow(el, request);
        });
      }
      if (showNew) {
        const chip = chips.createEl("button", { cls: "jot-import-chip", text: "New note" });
        chip.setAttribute("aria-label", `Use a new note, ${request.newPath}`);
        chip.addEventListener("click", () => {
          this.choices.set(id, { kind: "new" });
          this.renderRow(el, request);
        });
      }
    }

    const change = el.createEl("button", { cls: "jot-import-change", text: "Change" });
    change.setAttribute("aria-label", `Change where ${request.block.name} goes`);
    change.addEventListener("click", () => {
      new DestinationModal(this.app, this.context, {
        title: `Choose a note for ${request.block.name}`,
        note: { path: target.path, exists: target.exists },
        heading: target.heading,
        onDone: (picked) => {
          if (picked.note) {
            const isNew = !picked.note.exists;
            const sameAsSuggested = isNew && fold(picked.note.path) === fold(request.newPath);
            this.choices.set(
              id,
              !isNew
                ? { kind: "note", path: picked.note.path, heading: picked.heading }
                : { kind: "new", path: sameAsSuggested ? undefined : picked.note.path, heading: picked.heading },
            );
          }
          this.renderRow(el, request);
        },
      }).open();
    });
  }

  onClose() {
    this.contentEl.empty();
    if (!this.done) this.finish(null);
  }
}

/** What DestinationModal hands back: the note (when it was asked for) and the heading. */
export interface Destination {
  note?: { path: string; exists: boolean };
  /** The category's own heading ("" for the note itself), or undefined to use the Heading setting. */
  heading: string | undefined;
}

/**
 * One category's destination: a note (an existing one, or a name for a new
 * one, with a folder in front if wanted) and a heading in it (one it has,
 * or a new one). With `note: null` it asks for the heading alone, for a
 * note that's already linked (the settings' list).
 */
export class DestinationModal extends Modal {
  private notePath: string;
  private noteExists: boolean;
  private noteInput: TextComponent | null = null;
  private headingInput: TextComponent | null = null;
  private noteStatus: HTMLElement | null = null;
  private headingStatus: HTMLElement | null = null;
  private doneButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private context: LinkContext,
    private options: {
      title: string;
      note: { path: string; exists: boolean } | null;
      /** The heading now (the effective one, "" for none). */
      heading: string;
      onDone: (picked: Destination) => void;
      /** Where a heading-only dialog's note is. */
      path?: string;
    },
  ) {
    super(app);
    this.notePath = options.note?.path ?? options.path ?? "";
    this.noteExists = options.note?.exists ?? true;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("jot-import-destination-modal");
    this.setTitle(this.options.title);

    if (this.options.note) {
      const setting = new Setting(contentEl)
        .setName("Note")
        .setDesc("Pick a note, or type a name for a new one, with a folder and a slash in front to choose where it goes.");
      setting.addText((text) => {
        this.noteInput = text;
        text.setValue(withoutExtension(this.notePath)).setPlaceholder("Note name");
        text.onChange(() => this.update());
        new NoteSuggest(this.app, text.inputEl, this.context.notes, (note) => {
          text.setValue(withoutExtension(note.path));
          this.update();
        });
      });
      this.noteStatus = contentEl.createDiv({ cls: "jot-import-destination-status" });
    }

    const headingSetting = new Setting(contentEl)
      .setName("Heading")
      .setDesc("Pick a heading in the note, or type a new one. Leave it empty to use the whole note.");
    headingSetting.addText((text) => {
      this.headingInput = text;
      text.setValue(headingInputValue(this.options.heading)).setPlaceholder("None");
      text.onChange(() => this.update());
      new HeadingSuggest(this.app, text.inputEl, () => (this.noteExists ? this.context.headingsOf(this.notePath) : []), (heading) => {
        text.setValue(heading);
        this.update();
      });
    });
    this.headingStatus = contentEl.createDiv({ cls: "jot-import-destination-status" });

    new Setting(contentEl)
      .setClass("jot-import-link-buttons")
      .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((btn) => {
        this.doneButton = btn.buttonEl;
        btn
          .setButtonText("Done")
          .setCta()
          .onClick(() => this.submit());
      });
    this.update();
  }

  /** The typed note as a path: an existing note, or where a new one would go; null when it can't be used. */
  private resolveNote(): { path: string; exists: boolean } | { problem: string } {
    const typed = (this.noteInput?.getValue() ?? "").trim().replace(/\.md$/i, "");
    if (typed.length === 0) return { problem: "Type a note name." };
    const existing = findNote(this.context.notes, `${typed}.md`);
    if (existing) return { path: existing.path, exists: true };
    const slash = typed.lastIndexOf("/");
    if (typed.slice(slash + 1).trim().length === 0) return { problem: "Type a note name." };
    const folderPart = slash === -1 ? this.context.folder : cleanFolder(typed.slice(0, slash));
    const name = noteNameFor(typed.slice(slash + 1));
    const path = joinPath(resolveFolder(this.context.folders, folderPart), name);
    if ([...this.context.exclude].some((p) => fold(p) === fold(path))) return { problem: "That's the export file. Choose another name." };
    const cleaned = findNote(this.context.notes, path);
    return cleaned ? { path: cleaned.path, exists: true } : { path, exists: false };
  }

  private update() {
    if (this.options.note) {
      const note = this.resolveNote();
      if ("problem" in note) {
        this.noteStatus?.setText(note.problem);
        if (this.doneButton) this.doneButton.disabled = true;
      } else {
        this.notePath = note.path;
        this.noteExists = note.exists;
        this.noteStatus?.setText(note.exists ? `Existing note: ${note.path}` : `New note: ${note.path}`);
        if (this.doneButton) this.doneButton.disabled = false;
      }
    }
    const { name, existing } = this.headingChoice();
    if (!name) this.headingStatus?.setText("The jots go in the note itself, not under a heading.");
    else if (existing) this.headingStatus?.setText(`Existing heading: ${name}`);
    else this.headingStatus?.setText(`New heading: ${name}. It's added at the end of the note.`);
  }

  /** The heading box's text as a heading setting, matched against the note's headings (see `headingSettingFor`). */
  private headingChoice(): { setting: string; name: string; existing: boolean } {
    const headings = this.noteExists ? this.context.headingsOf(this.notePath) : [];
    return headingSettingFor(this.headingInput?.getValue() ?? "", headings);
  }

  private submit() {
    const { setting, name } = this.headingChoice();
    // The Heading setting's own value isn't saved per category, so changing the setting later still moves it.
    const heading = name === headingName(this.context.heading) ? undefined : name ? setting : "";
    if (this.options.note) {
      const note = this.resolveNote();
      if ("problem" in note) return;
      this.options.onDone({ note, heading });
    } else {
      this.options.onDone({ heading });
    }
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Notes as you type: fuzzy over their paths, like Obsidian's quick switcher. */
class NoteSuggest extends AbstractInputSuggest<NoteInfo> {
  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private notes: NoteInfo[],
    private pick: (note: NoteInfo) => void,
  ) {
    super(app, inputEl);
    this.limit = 50;
  }

  protected getSuggestions(query: string): NoteInfo[] {
    const q = query.trim();
    if (q.length === 0) return this.notes.slice(0, this.limit);
    const match = prepareFuzzySearch(q);
    return this.notes
      .map((note) => ({ note, result: match(withoutExtension(note.path)) }))
      .filter((m) => m.result !== null)
      .sort((a, b) => (b.result?.score ?? 0) - (a.result?.score ?? 0))
      .map((m) => m.note);
  }

  renderSuggestion(note: NoteInfo, el: HTMLElement) {
    el.createDiv({ text: withoutExtension(note.path) });
    if (note.linkedIds.length > 0) el.createDiv({ cls: "jot-import-suggestion-note", text: "Already linked to a category" });
  }

  selectSuggestion(note: NoteInfo) {
    this.pick(note);
    this.close();
  }
}

/** The chosen note's headings as you type. */
class HeadingSuggest extends AbstractInputSuggest<{ heading: string; level: number }> {
  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private headings: () => Array<{ heading: string; level: number }>,
    private pick: (heading: string) => void,
  ) {
    super(app, inputEl);
  }

  protected getSuggestions(query: string): Array<{ heading: string; level: number }> {
    const q = headingName(query).toLowerCase();
    return this.headings().filter((h) => h.heading.toLowerCase().includes(q));
  }

  renderSuggestion(item: { heading: string; level: number }, el: HTMLElement) {
    const row = el.createDiv({ cls: "jot-import-heading-suggestion" });
    row.createSpan({ cls: "jot-import-heading-level", text: `H${item.level}` });
    row.createSpan({ text: item.heading });
  }

  selectSuggestion(item: { heading: string; level: number }) {
    this.pick(item.heading);
    this.close();
  }
}

function hasHeading(headings: Array<{ heading: string }>, name: string): boolean {
  const wanted = name.toLowerCase();
  return headings.some((h) => h.heading.trim().toLowerCase() === wanted);
}

/** The note at `path`, matched the way the disk matches names (case and Unicode form aside). */
function findNote(notes: NoteInfo[], path: string): NoteInfo | undefined {
  return notes.find((n) => n.path === path) ?? notes.find((n) => fold(n.path) === fold(path));
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function withoutExtension(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}
