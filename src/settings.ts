import { App, PluginSettingTab, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import { headingName } from "./format";
import { DestinationModal } from "./link-modal";
import type JotImportPlugin from "./main";
import { cleanFolder, headingsFrom, linkedIdsFrom } from "./routing";

/**
 * Declarative settings (Obsidian 1.13), so every option shows up in
 * Obsidian's settings search. The definitions are rebuilt each time the tab
 * opens, and after a change that alters them (the routing mode, an unlink).
 */
export class JotImportSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: JotImportPlugin,
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const linked = this.plugin.settings.mode === "linked";
    const links = linked ? this.linkedNotes() : [];
    return [
      {
        name: "Send jots to",
        desc: linked
          ? "A note you choose the first time each category is imported. Rename or move it whenever you like."
          : "The note named after each category.",
        control: {
          type: "dropdown",
          key: "mode",
          options: { linked: "Note you choose", name: "Same-named note" },
          defaultValue: "linked",
        },
      },
      {
        name: linked ? "Folder for new notes" : "Folder",
        desc: linked
          ? "Where a category's note is created if you don't choose an existing one."
          : "Where the category notes live. A missing note is created here.",
        control: { type: "folder", key: "folder", placeholder: "Vault root", includeRoot: true },
      },
      {
        name: "Position",
        desc: "Where new jots go in the note, or in the heading's section.",
        control: { type: "dropdown", key: "position", options: { top: "Top", bottom: "Bottom" }, defaultValue: "top" },
      },
      {
        name: "Heading",
        desc: linked
          ? "Put the jots under this heading. It's added at the end of the note if missing. Type ### Inbox to choose its level. A linked note can have its own heading, below."
          : "Put the jots under this heading. It's added at the end of the note if missing. Type ### Inbox to choose its level.",
        control: { type: "text", key: "heading", placeholder: "Inbox" },
      },
      {
        name: "Trash export files after importing",
        desc: "Only files in the vault. A file you choose from elsewhere is never touched.",
        control: { type: "toggle", key: "trashAfterImport", defaultValue: true },
      },
      {
        name: "Offer to import new exports",
        desc: "When a Jot export shows up in the vault, ask whether to import it.",
        control: { type: "toggle", key: "offerNewExports", defaultValue: true },
      },
      {
        type: "list",
        heading: "Linked notes",
        visible: linked,
        emptyState: "None yet. You choose a note for each category the first time it's imported.",
        items: links.map(
          (link): SettingDefinition => ({
            // Unique per row (the framework keys rows by name); the row shows the category alone.
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

  // Not super's: it saves `settings` alone, which would drop the import
  // history and category names saved beside them.
  async setControlValue(key: string, value: unknown) {
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    settings[key] = key === "folder" && typeof value === "string" ? cleanFolder(value) : value;
    this.plugin.chooseSetting(key);
    await this.plugin.saveSettings();
    if (key === "mode") this.update();
  }

  /** "Projects/Dev.md › Inbox": the note, and the heading the category's jots go under, if any. */
  private where(link: { path: string; heading?: string }): string {
    const heading = headingName(link.heading ?? this.plugin.settings.heading);
    return heading ? `${link.path} › ${heading}` : link.path;
  }

  /** Every (note, category) link in the vault, by category name, with the category's own heading if it has one. */
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
