import { App, PluginSettingTab, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import type JotImportPlugin from "./main";
import { linkedIdsFrom } from "./routing";

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
          options: { name: "Same-named note", linked: "Note you choose" },
          defaultValue: "name",
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
        control: { type: "dropdown", key: "position", options: { bottom: "Bottom", top: "Top" }, defaultValue: "bottom" },
      },
      {
        name: "Heading",
        desc: "Put the jots under this heading. It's added at the end of the note if missing. Type ### Inbox to choose its level.",
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
            desc: link.path,
            aliases: [link.category],
            render: (setting) => {
              setting
                .setName(link.category)
                .setDesc(link.path)
                .addExtraButton((btn) =>
                  btn
                    .setIcon("unlink")
                    .setTooltip("Unlink. The note and its jots stay.")
                    .onClick(() => {
                      void this.plugin.unlink(link.path, link.id).then(() => this.update());
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
    settings[key] = key === "folder" && typeof value === "string" ? value.replace(/^\/+|\/+$/g, "") : value;
    await this.plugin.saveSettings();
    if (key === "mode") this.update();
  }

  /** Every (note, category) link in the vault, by category name. */
  private linkedNotes(): Array<{ path: string; id: string; category: string }> {
    const out: Array<{ path: string; id: string; category: string }> = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const ids = linkedIdsFrom(this.app.metadataCache.getFileCache(file)?.frontmatter);
      this.plugin.noteLinked(file.path, ids.length > 0);
      for (const id of ids) {
        out.push({ path: file.path, id, category: this.plugin.categoryName(id) });
      }
    }
    return out.sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path));
  }
}
