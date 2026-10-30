import { AbstractInputSuggest, App, Menu, Modal, prepareFuzzySearch, Setting, setIcon, setTooltip, type TextComponent } from "obsidian";
import type { PathShortening } from "./data.ts";
import { headingInputValue, headingName, headingSettingFor, type Position } from "./format.ts";
import { type LinkChoice, type LinkRequest, startingChoice } from "./importer.ts";
import { fold, type NoteInfo, typedNote } from "./routing.ts";
import { middleCut } from "./shorten.ts";

/** What the dialogs need to know about the vault and the settings. */
export interface LinkContext {
  /** Notes that can be chosen (the export file left out). */
  notes: NoteInfo[];
  /** The vault's folders, so a typed folder matches the vault's spelling. */
  folders: string[];
  /** The Folder setting: where a note name typed without a folder is created. */
  folder: string;
  /** The Heading setting, for categories without a heading of their own. */
  heading: string;
  shortenPaths: PathShortening;
  /** Where a heading the note doesn't have yet is added. */
  newHeading: Position;
  /** Paths that can't be chosen or created (the export file). */
  exclude: Set<string>;
  headingsOf(path: string): Array<{ heading: string; level: number }>;
}

const HOLDS_ANOTHER = "already holds another category's jots";

/** Where a row's jots go. */
interface Target {
  path: string;
  exists: boolean;
  /** The effective heading ("" for the note itself). */
  heading: string;
}

/** How the choose-notes dialog is used. */
export interface LinkDialogOptions {
  /** Categories that already have a note, listed after the new ones so they can be changed too. */
  linked?: LinkRequest[];
  /** Start the already linked section folded away. */
  collapseLinked?: boolean;
  /** The settings' "Change where categories go": every row is already linked and nothing is imported. */
  changeOnly?: boolean;
}

/**
 * Asks once which note each new category goes into, and lets already linked ones move. Resolves to the
 * choices, or null when cancelled, in which case nothing is written.
 */
export class LinkModal extends Modal {
  /** Keyed by category id. A row without an entry still needs a note. */
  private choices = new Map<string, LinkChoice>();
  private linkButton: HTMLButtonElement | null = null;
  private status: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private done = false;
  private linked: LinkRequest[];

  private constructor(
    app: App,
    private requests: LinkRequest[],
    private context: LinkContext,
    private options: LinkDialogOptions,
    private finish: (choices: Map<string, LinkChoice> | null) => void,
  ) {
    super(app);
    this.linked = options.linked ?? [];
    for (const request of [...requests, ...this.linked]) {
      const choice = startingChoice(request);
      if (choice) this.choices.set(request.block.id, choice);
    }
  }

  static ask(app: App, requests: LinkRequest[], context: LinkContext, options: LinkDialogOptions = {}): Promise<Map<string, LinkChoice> | null> {
    return new Promise((resolve) => new LinkModal(app, requests, context, options, resolve).open());
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("jot-import-link-modal");
    const count = this.requests.length;
    if (this.options.changeOnly) {
      this.setTitle("Change where categories go");
      contentEl.createEl("p", {
        cls: "jot-import-lede",
        text: "From the next import on, each category's jots go to this note and heading. Notes keep the jots they have.",
      });
    } else {
      this.setTitle(count === 1 ? "Choose an Obsidian note for 1 category" : `Choose Obsidian notes for ${count} categories`);
      contentEl.createEl("p", {
        cls: "jot-import-lede",
        text:
          count === 1
            ? "A category with a note of the same name starts on that note. Your choice is saved for future imports. To change it later, use Change where categories go in the plugin's settings."
            : "Categories with a note of the same name start on that note. Your choices are saved for future imports. To change one later, use Change where categories go in the plugin's settings.",
      });
    }

    const list = contentEl.createDiv({ cls: "jot-import-link-list" });
    for (const request of this.requests) this.renderRow(list.createDiv({ cls: "jot-import-link-row" }), request);
    if (this.linked.length > 0) {
      let section: HTMLElement;
      if (this.options.collapseLinked) {
        section = list.createEl("details", { cls: "jot-import-linked" });
        const n = this.linked.length;
        section.createEl("summary", { cls: "jot-import-linked-label", text: `${n} already linked` });
      } else {
        section = list.createDiv({ cls: "jot-import-linked" });
        section.createDiv({ cls: "jot-import-linked-label", text: "Already linked" });
      }
      for (const request of this.linked) this.renderRow(section.createDiv({ cls: "jot-import-link-row" }), request);
    }
    // Also fires once when it starts observing, which does the first cut, and when the section opens.
    this.resizeObserver = new ResizeObserver(() => list.findAll(".jot-import-link-path.is-cut-middle").forEach(fitMiddle));
    this.resizeObserver.observe(list);
    for (const section of list.findAll(".jot-import-linked")) this.resizeObserver.observe(section);

    const buttons = new Setting(contentEl)
      .setClass("jot-import-link-buttons")
      .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((btn) => {
        this.linkButton = btn.buttonEl;
        btn
          .setButtonText(this.options.changeOnly ? "Save" : count === 1 ? "Link and import" : "Link all and import")
          .setCta()
          .onClick(() => {
            this.done = true;
            this.finish(this.choices);
            this.close();
          });
      });
    this.status = buttons.descEl;
    this.updateLinkButton();
  }

  private updateLinkButton() {
    if (!this.linkButton) return;
    const missing = this.requests.filter((r) => !this.choices.has(r.block.id)).map((r) => r.block.name);
    this.linkButton.disabled = missing.length > 0;
    this.status?.setText(
      missing.length === 0 ? "" : missing.length === 1 ? `Choose a note for ${missing[0]}.` : `Choose notes for ${missing.length} categories.`,
    );
  }

  /**
   * Obsidian focuses the first row's path, which then looks like a text field or a picked row.
   * Focus the import button instead, as confirm dialogs do, or the dialog while it's disabled.
   */
  open() {
    super.open();
    if (this.linkButton && !this.linkButton.disabled) {
      this.linkButton.focus({ preventScroll: true });
    } else {
      this.modalEl.tabIndex = -1;
      this.modalEl.focus({ preventScroll: true });
    }
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
    const choice = this.choices.get(id);
    const target = choice ? this.target(request, choice) : null;
    const heading = headingName(target?.heading ?? this.context.heading);
    const newHeading = target !== null && heading !== "" && !(target.exists && hasHeading(this.context.headingsOf(target.path), heading));

    const line = el.createDiv({ cls: "jot-import-link-line" });
    const category = line.createSpan({ cls: "jot-import-link-category", text: request.block.name });
    // Two workspaces can each have an Inbox.
    if (request.block.workspace !== null) category.createSpan({ cls: "jot-import-link-workspace", text: ` · ${request.block.workspace}` });
    line.createSpan({ cls: "jot-import-link-arrow", text: "→", attr: { "aria-hidden": "true" } });
    const dest = line.createSpan({ cls: "jot-import-link-dest", attr: { role: "button", tabindex: "0", "aria-haspopup": "menu" } });
    let label: HTMLElement;
    if (target) {
      label = dest.createSpan({ cls: "jot-import-link-path" });
      renderPath(label, target.path, this.context.shortenPaths);
      if (!target.exists) dest.createSpan({ cls: "jot-import-link-new", text: "(new)" });
      const held = target.path === request.linkedSameName ? ` ${HOLDS_ANOTHER}.` : "";
      setTooltip(dest, target.exists ? `${target.path}${held}` : `New note: ${target.path}`);
    } else {
      label = dest.createSpan({ cls: "jot-import-link-choose", text: "Choose a note" });
      const held = request.linkedSameName ? `. ${request.linkedSameName} ${HOLDS_ANOTHER}.` : "";
      setTooltip(dest, `Choose where ${request.block.name} goes${held}`);
    }
    setIcon(dest.createSpan({ cls: "jot-import-link-chevron" }), "chevron-down");
    const openChange = () => {
      const rect = label.getBoundingClientRect();
      this.changeMenu(el, request, target).showAtPosition({ x: rect.left, y: rect.bottom + 4 }, dest.doc);
    };
    dest.addEventListener("click", openChange);
    dest.addEventListener("keydown", (evt) => {
      if (evt.key !== "Enter" && evt.key !== " ") return;
      evt.preventDefault();
      openChange();
    });

    const headingButton = el.createEl("button", { cls: "jot-import-menu-button jot-import-heading-button" });
    headingButton.toggleClass("is-none", heading === "");
    headingButton.createSpan({ cls: "jot-import-button-text", text: heading || "No heading" });
    // A new note's "(new)" already covers its heading.
    if (newHeading && target?.exists) headingButton.createSpan({ cls: "jot-import-link-new", text: "(new)" });
    setIcon(headingButton.createSpan({ cls: "jot-import-button-chevron" }), "chevron-down");
    if (target) {
      setTooltip(headingButton, heading ? `Under the heading ${heading}${newHeading ? " (new)" : ""}` : "In the note, under no heading");
      headingButton.addEventListener("click", () => {
        const rect = headingButton.getBoundingClientRect();
        this.headingMenu(el, request, target).showAtPosition({ x: rect.left, y: rect.bottom + 4 }, headingButton.doc);
      });
      // Nothing to measure until the dialog is on screen; the resize observer cuts it then.
      if (el.isConnected && label.hasClass("is-cut-middle")) fitMiddle(label);
    } else {
      headingButton.disabled = true;
      setTooltip(headingButton, "Choose a note first");
    }
    this.updateLinkButton();
  }

  /** A heading the note doesn't have yet is listed first while it's the choice. */
  private headingMenu(el: HTMLElement, request: LinkRequest, target: Target): Menu {
    const id = request.block.id;
    const choice = this.choices.get(id) ?? { kind: "new" };
    const headings = target.exists ? this.context.headingsOf(target.path) : [];
    const current = headingName(target.heading).toLowerCase();
    const fallback = headingName(this.context.heading);
    // A heading equal to the Heading setting is saved as undefined, so changing the setting still applies.
    const choose = (setting: string) => {
      const name = headingName(setting);
      this.choices.set(id, { ...choice, heading: name === fallback ? undefined : name ? setting : "" });
      this.renderRow(el, request);
    };
    const menu = new Menu();
    if (current && !hasHeading(headings, current)) {
      menu.addItem((item) =>
        item
          .setTitle(`${headingName(target.heading)} (new)`)
          .setIcon("heading")
          .setChecked(true),
      );
    }
    for (const h of headings) {
      menu.addItem((item) =>
        item
          .setTitle(createFragment((f) => {
            f.createSpan({ cls: "jot-import-heading-level", text: `H${h.level}` });
            f.appendText(` ${h.heading}`);
          }))
          .setChecked(h.heading.trim().toLowerCase() === current)
          .onClick(() => choose(headingSettingFor(h.heading, headings).setting)),
      );
    }
    menu.addItem((item) =>
      item
        .setTitle("No heading")
        .setIcon("file-text")
        .setChecked(current === "")
        .onClick(() => choose("")),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("New heading…")
        .setIcon("plus")
        .onClick(() => {
          new DestinationModal(this.app, this.context, {
            title: `Heading for ${request.block.name}`,
            note: null,
            path: target.path,
            heading: target.heading,
            onDone: ({ heading }) => {
              this.choices.set(id, { ...choice, heading });
              this.renderRow(el, request);
            },
          }).open();
        }),
    );
    return menu;
  }

  /** Picking a note resets the heading to the default, since the old one may not be in it. */
  private changeMenu(el: HTMLElement, request: LinkRequest, target: Target | null): Menu {
    const id = request.block.id;
    const choice = this.choices.get(id);
    const pick = request.suggestion.pick;
    const suggested = [...(pick ? [pick] : []), ...request.suggestion.others];
    const held = request.linkedSameName;
    const menu = new Menu();
    // The current choice goes first unless it's already listed below.
    const listed =
      !target || suggested.some((n) => n.path === target.path) || target.path === held || (choice?.kind === "new" && choice.path === undefined);
    if (!listed) {
      menu.addItem((item) =>
        item
          .setTitle(target.exists ? target.path : `New note: ${target.path}`)
          .setIcon(target.exists ? "file-text" : "file-plus")
          .setChecked(true),
      );
    }
    // An already linked category can go back to where it goes now.
    const current = request.linked;
    if (current && target?.path !== current.paths[0]) {
      menu.addItem((item) =>
        item
          .setTitle(`${current.paths[0]} (current)`)
          .setIcon("file-text")
          .onClick(() => {
            this.choices.set(id, { kind: "note", path: current.paths[0], heading: current.heading });
            this.renderRow(el, request);
          }),
      );
    }
    for (const note of suggested) {
      menu.addItem((item) =>
        item
          .setTitle(note.path)
          .setIcon("file-text")
          .setChecked(choice?.kind === "note" && choice.path === note.path)
          .onClick(() => {
            this.choices.set(id, { kind: "note", path: note.path });
            this.renderRow(el, request);
          }),
      );
    }
    if (held !== null) {
      menu.addItem((item) =>
        item
          .setTitle(`${held} (${HOLDS_ANOTHER})`)
          .setIcon("file-text")
          .setChecked(choice?.kind === "note" && choice.path === held)
          .onClick(() => {
            this.choices.set(id, { kind: "note", path: held });
            this.renderRow(el, request);
          }),
      );
    }
    // Not when the suggested note is already the folder's same-named one.
    if (pick?.path !== request.newPath) {
      menu.addItem((item) =>
        item
          .setTitle(request.newPathExists ? request.newPath : `New note: ${request.newPath}`)
          .setIcon("file-plus")
          .setChecked(choice?.kind === "new" && choice.path === undefined)
          .onClick(() => {
            this.choices.set(id, { kind: "new" });
            this.renderRow(el, request);
          }),
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Choose note and heading…")
        .setIcon("pencil")
        .onClick(() => {
          new DestinationModal(this.app, this.context, {
            title: `Choose a note for ${request.block.name}`,
            note: target ? { path: target.path, exists: target.exists } : { path: "", exists: false },
            heading: target?.heading ?? this.context.heading,
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
        }),
    );
    return menu;
  }

  onClose() {
    this.resizeObserver?.disconnect();
    this.contentEl.empty();
    if (!this.done) this.finish(null);
  }
}

/** What DestinationModal returns. `note` is set only when the dialog asked for one. */
export interface Destination {
  note?: { path: string; exists: boolean };
  /** The category's own heading ("" for the note itself), or undefined to use the Heading setting. */
  heading: string | undefined;
}

/**
 * Picks one category's note (existing, or a new name with an optional folder) and heading.
 * With `note: null` it asks only for the heading, for a note that's already linked.
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
      /** The current effective heading ("" for none). */
      heading: string;
      onDone: (picked: Destination) => void;
      /** The note's path when `note` is null. */
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

  private resolveNote(): { path: string; exists: boolean } | { problem: string } {
    return typedNote(this.noteInput?.getValue() ?? "", this.context);
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
    else this.headingStatus?.setText(`New heading: ${name}. It's added at the ${this.context.newHeading === "top" ? "top" : "end"} of the note.`);
  }

  /** The heading box's text, matched against the note's headings (see `headingSettingFor`). */
  private headingChoice(): { setting: string; name: string; existing: boolean } {
    const headings = this.noteExists ? this.context.headingsOf(this.notePath) : [];
    return headingSettingFor(this.headingInput?.getValue() ?? "", headings);
  }

  private submit() {
    const { setting, name } = this.headingChoice();
    // A heading equal to the Heading setting is saved as undefined, so changing the setting still applies.
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

/** Fuzzy matches note paths, like Obsidian's quick switcher. */
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

/** CSS can only cut a path at either end, so a middle cut is measured in code by `fitMiddle`. */
function renderPath(el: HTMLElement, path: string, shorten: PathShortening) {
  const where = shorten === "start" || shorten === "end" ? shorten : "middle";
  el.addClass(`is-cut-${where}`);
  if (where === "start") {
    // The box is right to left so the ellipsis lands at the start; <bdi> keeps the path left to right.
    el.createEl("bdi", { text: path });
  } else if (where === "end") {
    el.setText(path);
  } else {
    el.dataset.path = path;
    el.setText(path);
  }
}

/** Cuts the path to the room left beside its "(new)" and chevron (see `middleCut`). */
function fitMiddle(el: HTMLElement) {
  const path = el.dataset.path ?? "";
  el.setText(path);
  const dest = el.parentElement;
  if (!dest) return;
  const gap = parseFloat(getComputedStyle(dest).columnGap) || 0;
  // Less a pixel: widths are rounded, and a path a fraction too wide also gets its end cut by CSS.
  let room = dest.clientWidth - 1;
  for (const sibling of Array.from(dest.children)) {
    if (sibling !== el && sibling.instanceOf(HTMLElement)) room -= sibling.offsetWidth + gap;
  }
  const ruler = el.createSpan({ cls: "jot-import-path-ruler" });
  const cut = middleCut(path, (text) => {
    ruler.setText(text);
    return ruler.offsetWidth <= room;
  });
  el.setText(cut);
}

function withoutExtension(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}
