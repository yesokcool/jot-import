# Jot Import

Jot Import brings a [Jot](https://jotquick.app) export from your iPhone into
your vault. Each category's jots go into a note you choose the first time it
comes in. They go at the top, at the bottom or under a heading, and photos and
files come with them.

## How to use

1. In Jot, open **Export ▸ Format**, turn on **Obsidian Format**, and export.
   You get a `.md` file, or a `.zip` when the jots have photos or files.
2. Import it in one of these ways:
   - Run **Import a Jot export…** from the command palette, or tap its ribbon
     icon, and choose the file. Exports already in the vault are listed there
     too.
   - Save the export in your vault's **Jots** folder (on iPhone: Share ▸ Save
     to Files ▸ your vault ▸ Jots). A notice asks whether to import it. Tap
     **Import**.
   - Open the export in Obsidian and run **Import the active file as a Jot
     export**.

Nothing is imported without asking. Importing the same file twice asks first.
After an import, an export file in the vault goes to the trash (a setting keeps
it instead). A zip whose attachments didn't all come in is always kept.

At the top of a note, each import goes above the last one, so the newest comes
first. Within an import, jots keep the order Jot exported them in.

## Choosing notes

The first time a category comes in, a dialog asks which note it goes to. Each
row starts on:

- the note with the category's name or alias, if there is one that isn't
  linked to another category;
- **Choose a note**, if no such note exists but some have similar names
  (*Project Ideas* for *Ideas*), or the note with its name in the Folder
  already holds another category's jots. The import waits until you pick one;
- a new note with the category's name in the Folder, if nothing is similar.

A new note is numbered (*Inbox 1*) when the note with its name holds another
category's jots, or another category in the export makes the same file name
(*C* and *C#*).

Tap a row's note to change it. The menu lists the similar notes and a new
note, and **Choose note and heading…** lets you search for any note or type a
name for a new one (put a folder and a slash in front to choose where it
goes). The button after the note picks the heading the jots go under. Then
tap **Link all and import**.

The export's categories that already have a note are listed too, under
**Already linked**, so you can move one to another note or heading on the
way. Its link leaves the old note, which keeps its jots. The dialog only
opens when a category is new; the **Change where categories go** button in
the settings opens it for every linked category, without importing.

![The dialog that asks which note each category goes to.](link-dialog.png)

Your choice is saved in the note's properties:

```yaml
jot-category-id:
  - 0D4C2A1B-5E7F-4A2B-9C3D-8E1F2A3B4C5D
jot-category-heading:
  0D4C2A1B-5E7F-4A2B-9C3D-8E1F2A3B4C5D: Inbox
```

After that, the category's jots always go to that note, even if you rename
or move the note or rename the category in Jot. Several categories can share
a note, each under its own heading. The settings list every link, where you
can change its heading or unlink it, or change several at once with **Change
where categories go**.

**Workspaces.** A category that's in a workspace in Jot gets its new note in a
folder named after the workspace, inside the Folder: Work's *Inbox* goes to
`Jots/Work/Inbox.md` and Home's to `Jots/Home/Inbox.md`. Older exports don't
name workspaces, so their new notes go in the Folder.

**Exports from older versions of Jot** have no category ids, so nothing can be
linked and the dialog doesn't open: each category's jots go into the note with
its name in the Folder, created if it's missing. Case doesn't matter, and
characters Obsidian can't use in file names are replaced (*Work / Life* goes
into `Work - Life.md`). Update Jot to choose notes.

## Settings

| Setting | What it does |
|---|---|
| **Folder for new notes** | Where new notes are created. A workspace's categories use a folder in it named after the workspace. **Jots** to start; empty is the vault root. |
| **Position** | **Top** (the default) or **Bottom** of the note, or of the heading's section. Top is right after the note's properties. To put the jots under the note's `# Title`, make it the heading. |
| **Heading** | Put the jots under this heading, added if the note doesn't have it. Type `### Inbox` to set its level; `Inbox` alone makes `## Inbox`. A linked category's own heading takes its place. |
| **New headings go at** | Where a missing heading is added: the bottom of the note (the default) or the top, right after its properties. |
| **Blank lines before** / **after** | Blank lines between the jots and the text above and below them, from none to 3. 1 to start. |
| **Start line** / **End line** | A line above and below each import's jots. They start as `*Jots imported {{date}}*` and `---`. `{{date}}` and `{{time}}` are when you import; `{{date:YYYY-MM-DD}}` sets the format. Empty means no line. |
| **Trash export files after importing** | On to start. Only for exports in the vault. A file chosen from elsewhere is never touched. |
| **Offer to import new exports** | On to start. Shows a notice when an export is saved in the exports folder. |
| **Exports folder** | The folder, and the folders in it, watched for new exports. **Jots** to start; the vault root watches the whole vault. |
| **Shorten long paths** | Where the dialog cuts a path that doesn't fit: at the start, in the middle (the default) or at the end. |
| **Collapse already-linked categories** | Off to start. In the dialog, the categories that already have a note start folded away behind a row you tap to open. |
| **Change where categories go** | Opens the dialog for every linked category, to move any to another note or heading. Nothing is imported. |

## Photos and files

When jots have photos or files, Jot exports a `.zip`. Import the zip as it
is. The attachments are saved where Obsidian saves new attachments, and the
jots link to them in your link format. Zips import on desktop, Android, and
iPhone or iPad with iOS 16.4 or later. Elsewhere, unzip the export and import
the `.md` inside.

If an attachment can't come in (it's damaged, or no jot links to it), the
jots still do, and that jot keeps its link as Jot wrote it. The notice says
how many attachments weren't imported, and the zip is kept.

## Privacy

Everything stays on your device: the plugin makes no network requests,
collects no data and needs no account. It reads a file outside the vault only
when you pick one with **Choose a file**. In the vault it writes only to the
category notes and their properties, saves a zip's attachments, and trashes
the imported export when that setting is on.

## Install

Install **Jot Import** from Settings ▸ Community plugins ▸ Browse. Until it's
listed there, install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat):
add `yesokcool/jot-import`. To install by hand, copy `main.js`, `manifest.json` and `styles.css` from the latest
release into `<vault>/.obsidian/plugins/jot-import/`, then turn it on in
Settings ▸ Community plugins. Needs Obsidian 1.13 or later, on desktop or
mobile.

Jot Import is not affiliated with Obsidian. Obsidian is a trademark of
Dynalist Inc.

## License

MIT. See `LICENSE`.
