import { App, PluginSettingTab, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import { isSettingKey, setSetting } from "./data.ts";
import { headingName } from "./format.ts";
import { DestinationModal } from "./link-modal.ts";
import type JotImportPlugin from "./main.ts";
import { headingsFrom, linkedIdsFrom } from "./routing.ts";

const BLANK_LINES = { "0": "None", "1": "1", "2": "2", "3": "3" };

/**
 * Declarative settings (Obsidian 1.13), so every option shows up in settings search.
 * Rebuilt when the tab opens and after a change that alters them (an unlink).
 */
export class JotImportSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: JotImportPlugin,
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const links = this.linkedNotes();
    return [
      {
        name: "Folder for new notes",
        desc: "Where a category's note is created if you don't choose an existing one.",
        control: { type: "folder", key: "folder", placeholder: "Vault root", includeRoot: true },
      },
      {
        name: "Position",
        desc: "Where new jots go in the note, or in the heading's section.",
        control: { type: "dropdown", key: "position", options: { top: "Top", bottom: "Bottom" }, defaultValue: "top" },
      },
      {
        name: "Heading",
        desc: "Put the jots under this heading. It's added to the note if missing. Type ### Inbox to choose its level. A linked note can have its own heading, below.",
        // "None" rather than an example, which reads as a value already set.
        control: { type: "text", key: "heading", placeholder: "None" },
      },
      {
        name: "New headings go at",
        desc: "Where a heading is added when the note doesn't have it yet. The top is right after the note's properties.",
        control: {
          type: "dropdown",
          key: "newHeadingPosition",
          options: { bottom: "Bottom of the note", top: "Top of the note" },
          defaultValue: "bottom",
        },
      },
      {
        name: "Blank lines before",
        desc: "Between the imported jots and the text above them.",
        control: { type: "dropdown", key: "blankLinesBefore", options: BLANK_LINES, defaultValue: "1" },
      },
      {
        name: "Blank lines after",
        desc: "Between the imported jots and the text below them.",
        control: { type: "dropdown", key: "blankLinesAfter", options: BLANK_LINES, defaultValue: "1" },
      },
      {
        name: "Start line",
        desc: "Written above each import's jots. {{date}} is the day you import. Leave it empty for none.",
        control: { type: "text", key: "startMarker", placeholder: "None" },
      },
      {
        name: "End line",
        desc: "Written below each import's jots. --- is a divider line. Leave it empty for none.",
        control: { type: "text", key: "endMarker", placeholder: "None" },
      },
      {
        name: "Trash export files after importing",
        desc: "Only files in the vault. A file you choose from elsewhere is never touched.",
        control: { type: "toggle", key: "trashAfterImport", defaultValue: true },
      },
      {
        name: "Offer to import new exports",
        desc: "When a Jot export is saved in the exports folder, ask whether to import it. It's never imported without asking.",
        control: { type: "toggle", key: "offerNewExports", defaultValue: true },
      },
      {
        name: "Exports folder",
        desc: "Save Jot exports here to be asked about them. Only this folder and the folders in it are looked at; the vault root means the whole vault.",
        control: { type: "folder", key: "exportsFolder", placeholder: "Vault root", includeRoot: true },
      },
      {
        name: "Shorten long paths",
        desc: "Where a note's path is cut when it doesn't fit in the choose-notes dialog. Hover over it to see all of it.",
        control: {
          type: "dropdown",
          key: "shortenPaths",
          options: { start: "At the start", middle: "In the middle", end: "At the end" },
          defaultValue: "middle",
        },
      },
      {
        name: "Collapse already-linked categories",
        desc: "When the choose-notes dialog opens for a new category, the ones that already have a note start folded away.",
        control: { type: "toggle", key: "collapseLinked", defaultValue: false },
      },
      {
        name: "Change where categories go",
        desc: "Choose another note or heading for any linked category. Nothing is imported.",
        visible: links.length > 0,
        render: (setting) => {
          setting
            .setName("Change where categories go")
            .setDesc("Choose another note or heading for any linked category. Nothing is imported.")
            .addButton((btn) => btn.setButtonText("Change…").onClick(() => void this.plugin.changeLinks()));
        },
      },
      {
        type: "list",
        heading: "Linked notes",
        emptyState: "None yet. You choose a note for each category the first time it's imported.",
        items: links.map(
          (link): SettingDefinition => ({
            // Obsidian keys list rows by name, so it must be unique; render shows the category alone.
            name: `${link.category}: ${link.path}`,
            desc: this.where(link),
            aliases: [link.category],
            render: (setting) => {
              setting
                .setName(link.category)
                .setDesc(this.where(link))
                .addExtraButton((btn) =>
                  btn
                    .setIcon("heading")
                    .setTooltip("Change heading")
                    .onClick(() => {
                      const context = this.plugin.linkContext([]);
                      new DestinationModal(this.app, context, {
                        title: `Heading for ${link.category}`,
                        note: null,
                        path: link.path,
                        heading: link.heading ?? this.plugin.settings.heading,
                        onDone: ({ heading }) => {
                          void this.plugin.setCategoryHeading(link.path, link.id, heading).then(() => this.update());
                        },
                      }).open();
                    }),
                )
                .addExtraButton((btn) =>
                  btn
                    .setIcon("unlink")
                    .setTooltip("Unlink. The note and its jots stay.")
                    .onClick(async () => {
                      await this.plugin.unlink(link.path, link.id);
                      this.update();
                    }),
                );
            },
          }),
        ),
      },
    ];
  }

  // The blank-line counts are numbers; their dropdown's options are strings.
  getControlValue(key: string): unknown {
    if (!isSettingKey(key)) return undefined;
    const value = this.plugin.settings[key];
    return typeof value === "number" ? String(value) : value;
  }

  // Not super's, which saves `settings` alone and would drop the import history saved beside them.
  async setControlValue(key: string, value: unknown) {
    if (!isSettingKey(key) || !setSetting(this.plugin.settings, key, value)) return;
    this.plugin.chooseSetting(key);
    await this.plugin.saveSettings();
  }

  /** "Projects/Dev.md › Inbox": the note and the heading its jots go under, if any. */
  private where(link: { path: string; heading?: string }): string {
    const heading = headingName(link.heading ?? this.plugin.settings.heading);
    return heading ? `${link.path} › ${heading}` : link.path;
  }

  /** Every (note, category) link in the vault, by category name. Also tells the plugin which notes hold links. */
  private linkedNotes(): Array<{ path: string; id: string; category: string; heading?: string }> {
    const out: Array<{ path: string; id: string; category: string; heading?: string }> = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const ids = linkedIdsFrom(frontmatter);
      const headings = headingsFrom(frontmatter);
      this.plugin.noteLinked(file.path, ids.length > 0);
      for (const id of ids) {
        out.push({ path: file.path, id, category: this.plugin.categoryName(id), heading: headings[id] });
      }
    }
    return out.sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path));
  }
}
