# Jot Import

Import a [Jot](https://jot.yesokcool.com) export into your notes. Each
category's jots go into that category's note, so a round of jotting on
your phone lands in the right places in your vault without any pasting.

## How it works

1. In Jot, open Export ▸ Format and turn on **Obsidian Format**. Export as
   usual. The file is Markdown now, or a `.zip` when the export has photos
   or files.
2. Get the file to Obsidian: save it into your vault (on iPhone, Share ▸
   Save to Files ▸ your vault folder), or keep it anywhere on disk.
3. In Obsidian, tap **Import** on the notice that shows up when a new
   export lands in the vault, or run **Import a Jot export…** from the
   command palette (or the ribbon) and pick the file.

Every category's jots are added to its note: at the top, so the newest are
first (Jot exports newest first), at the bottom, or under a heading. Export
files inside the vault go to the trash afterwards (there's a setting to keep
them).

## Two ways to route

**Note you choose** (the default). The first time a category comes in, Jot
Import asks which note it belongs to. A note with the same name (or alias)
anywhere in the vault is already picked, and if there's none, a new note
with the category's name is. Notes whose names contain the category's name
are one tap away (*Jot* offers *Project Jot*). **Change** picks any other
note, or a new one with a name of your own (type a folder and a slash in
front to choose where it goes), and a heading in it: one the note has, or a
new one. One tap on **Link all and import** and you're done.

![The "Choose Obsidian notes" dialog: five categories, each with the note it goes to, one with a heading and one with a new note named by hand, and more suggestions one tap away.](link-dialog.png)

The choice is saved in the note's properties as the category's id, and a
heading chosen for it beside the id:

```yaml
---
jot-category-id:
  - 0D4C2A1B-5E7F-4A2B-9C3D-8E1F2A3B4C5D
jot-category-heading:
  0D4C2A1B-5E7F-4A2B-9C3D-8E1F2A3B4C5D: Inbox
---
```

From then on that category's jots always go there, even after you rename
or move the note, or rename the category in Jot, on every device the note
syncs to. Link several categories to one note to collect them together,
each under its own heading if you like. Settings ▸ Jot Import lists every
link with its heading, changes the heading, and can undo a link; deleting
the properties by hand works too. A category with no heading of its own
uses the Heading setting.

**Same-named note.** Category *Ideas* goes into `Ideas.md` in the folder you
choose, created if it's missing. Nothing to set up, nothing asked.

The suggestions are plain name matching, the same every time: no AI, no
network, no guessing beyond names. Exports from Jot 1.5 carry no ids, so
they always go by name.

## Settings

| Setting | What it does |
|---|---|
| **Send jots to** | *Note you choose* (the default) or *Same-named note* (above). |
| **Folder** | Where new notes are created (note you choose) or where the category notes live (same-named). Empty means the vault root. |
| **Position** | Top (the default; after any properties, and below the note's title if it starts with a `# Title`) or bottom of the note, or of the heading's section. |
| **Heading** | Optional. Put the jots under this heading instead. Added at the end of the note if missing. Type `### Inbox` to choose the level; `Inbox` alone creates `## Inbox`. A linked category's own heading takes its place. |
| **Trash export files after importing** | Only for export files inside the vault. Files chosen from disk are never touched. |
| **Offer to import new exports** | Show a notice with an Import button when an export appears in the vault. |

The imported jots keep exactly the formatting Jot rendered (prefix,
timestamps, spacing, sort, tags), separated from what's around them by one
blank line. Existing notes are matched case-insensitively. Category names
with characters Obsidian can't use in file names are cleaned up (`Work /
Life` becomes `Work - Life`).

Importing the exact same file twice asks first, so an accidental second
import doesn't double your jots.

**Photos and files.** When an export has attachments, Jot shares a `.zip`:
the export and a `media/` folder its jots link into. Import the zip as it
is. Its attachments are saved where Obsidian saves attachments (Settings ▸
Files and links ▸ Default location for new attachments), next to any
file of the same name rather than over it, and the jots link to them in
your link format. Importing the same zip again reuses the attachments
already there. After a successful import the zip goes to the trash like a
`.md` export. Jot Import unzips with what your device already has: Obsidian
on desktop and Android, and on iPhone and iPad with iOS 16.4 or later.
Elsewhere, unzip the export and import the `.md` inside.

## Privacy

Everything happens on your device. The plugin makes no network requests,
collects no data, and needs no account. When you use **Choose a file**, it
reads the one file you pick, which may be outside the vault. That is the only
time it touches anything outside the vault. In the vault it writes only to
the category notes (and their `jot-category-id` and `jot-category-heading`
properties), saves a zipped export's attachments, and trashes the imported
export file if you leave that setting on.

## Install

Search for **Jot Import** in Settings ▸ Community plugins ▸ Browse. Until
it's listed there, install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat)
(add `yesokcool/jot-import`), or by hand: copy `main.js`, `manifest.json`
and `styles.css` from the latest release into
`<vault>/.obsidian/plugins/jot-import/`, then enable **Jot Import** under
Settings ▸ Community plugins. Works on desktop and mobile. Needs Obsidian
1.13 or later.

Jot Import is not affiliated with Obsidian. Obsidian is a trademark of
Dynalist Inc.

## License

MIT. See `LICENSE`.
