import { App, FuzzySuggestModal, Modal, Setting, setIcon, type FuzzyMatch } from "obsidian";
import type { LinkChoice, LinkRequest } from "./importer";
import type { NoteInfo } from "./routing";

/**
 * Asks which note each new category goes into, once. Every row starts on
 * the same-named note if there is one, else a new note, so most imports
 * are one tap: "Link and import". Resolves to the answers, or null when
 * the user cancels (then nothing is written).
 */
export class LinkModal extends Modal {
  private choices = new Map<string, LinkChoice>();
  private done = false;

  private constructor(
    app: App,
    private requests: LinkRequest[],
    private notes: NoteInfo[],
    private finish: (choices: Map<string, LinkChoice> | null) => void,
  ) {
    super(app);
    for (const request of requests) {
      const pick = request.suggestion.pick;
      this.choices.set(request.block.id, pick ? { kind: "note", path: pick.path } : { kind: "new" });
    }
  }

  static ask(app: App, requests: LinkRequest[], notes: NoteInfo[]): Promise<Map<string, LinkChoice> | null> {
    return new Promise((resolve) => new LinkModal(app, requests, notes, resolve).open());
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("jot-import-link-modal");
    const count = this.requests.length;
    this.setTitle(count === 1 ? "Choose a note for this category" : `Choose notes for ${count} categories`);
    contentEl.createEl("p", {
      cls: "jot-import-lede",
      text:
        (count === 1 ? "From now on, its jots go straight to this note." : "From now on, each category's jots go straight to its note.") +
        " The link is saved in the note's properties, so you can rename or move the note.",
    });

    const list = contentEl.createDiv({ cls: "jot-import-link-list" });
    for (const request of this.requests) this.renderRow(list.createDiv({ cls: "jot-import-link-row" }), request);

    new Setting(contentEl)
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

  private renderRow(el: HTMLElement, request: LinkRequest) {
    el.empty();
    const id = request.block.id;
    const choice = this.choices.get(id) ?? { kind: "new" };
    const target = choice.kind === "note" ? choice.path : request.newPath;

    const setting = new Setting(el).setName(request.block.name);
    // "New note" can land on a same-named note that's already there (one
    // linked to another category); say so rather than promise a new file.
    const existing = choice.kind === "note" || request.newPathExists;
    const line = setting.descEl.createDiv({ cls: "jot-import-target" });
    setIcon(line.createSpan({ cls: "jot-import-target-icon" }), existing ? "file-text" : "file-plus");
    line.createSpan({ text: existing ? target : `New note: ${target}` });

    const others = [
      ...(request.suggestion.pick && choice.kind !== "note" ? [request.suggestion.pick] : []),
      ...request.suggestion.others,
    ].filter((n) => !(choice.kind === "note" && n.path === choice.path));
    const showNew = choice.kind === "note" && request.suggestion.pick?.path !== request.newPath;
    if (others.length > 0 || showNew) {
      const chips = setting.descEl.createDiv({ cls: "jot-import-chips" });
      chips.createSpan({ cls: "jot-import-chips-label", text: "Or" });
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
        chip.addEventListener("click", () => {
          this.choices.set(id, { kind: "new" });
          this.renderRow(el, request);
        });
      }
    }

    setting.addButton((btn) =>
      btn.setButtonText("Choose…").onClick(() => {
        new NotePicker(this.app, this.notes, request.block.name, (note) => {
          this.choices.set(id, { kind: "note", path: note.path });
          this.renderRow(el, request);
        }).open();
      }),
    );
  }

  onClose() {
    this.contentEl.empty();
    if (!this.done) this.finish(null);
  }
}

/** Search every note in the vault, starting from the category's name. */
class NotePicker extends FuzzySuggestModal<NoteInfo> {
  constructor(
    app: App,
    private notes: NoteInfo[],
    private query: string,
    private onPick: (note: NoteInfo) => void,
  ) {
    super(app);
    this.setPlaceholder("Find a note");
  }

  onOpen() {
    void super.onOpen();
    this.inputEl.value = this.query;
    this.inputEl.dispatchEvent(new Event("input"));
  }

  getItems(): NoteInfo[] {
    return this.notes;
  }

  getItemText(note: NoteInfo): string {
    return note.path.endsWith(".md") ? note.path.slice(0, -3) : note.path;
  }

  renderSuggestion(match: FuzzyMatch<NoteInfo>, el: HTMLElement) {
    super.renderSuggestion(match, el);
    if (match.item.linkedIds.length > 0) {
      el.createDiv({ cls: "jot-import-suggestion-note", text: "Already linked to a category" });
    }
  }

  onChooseItem(note: NoteInfo) {
    this.onPick(note);
  }
}
