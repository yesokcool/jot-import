# Jot Import

Import a [Jot](https://jot.yesokcool.com) export into your notes. Each
category's jots go into that category's note, so a round of jotting on
your phone lands in the right places in your vault without any pasting.

## How it works

1. In Jot, open Export ▸ Format and turn on **Obsidian Format**. Export as
   usual. The file is Markdown now.
2. Get the file to Obsidian: save it into your vault (on iPhone, Share ▸
   Save to Files ▸ your vault folder), or keep it anywhere on disk.
3. In Obsidian, tap **Import** on the notice that shows up when a new
   export lands in the vault, or run **Import a Jot export…** from the
   command palette (or the ribbon) and pick the file.

Every category's jots are added to its note, at the top, at the bottom, or
under a heading. Export files inside the vault go to the trash afterwards
(there's a setting to keep them).

## Two ways to route

**Same-named note** (the default). Category *Ideas* goes into `Ideas.md` in
the folder you choose, created if it's missing. Nothing to set up.

**Note you choose.** The first time a category comes in, Jot Import asks
which note it belongs to. A note with the same name (or alias) anywhere in
the vault is already picked, notes whose names contain the category's
name are one tap away (*Jot* offers *Project Jot*), and you can search
for any other note. One tap on **Link all and import** and you're done.

![The "choose notes" dialog: three categories already matched to same-named notes, and "Jot" with "Project Jot" one tap away.](link-dialog.png)

The choice is saved in the note's properties as the category's id:

```yaml
---
jot-category-id:
  - 0D4C2A1B-5E7F-4A2B-9C3D-8E1F2A3B4C5D
---
```

From then on that category's jots always go there, even after you rename
or move the note, or rename the category in Jot. Link several categories
to one note to collect them together. Settings ▸ Jot Import lists every
link and can undo one; deleting the property by hand works too.

The suggestions are plain name matching, the same every time: no AI, no
network, no guessing beyond names. Exports from Jot 1.5 carry no ids, so
they always go by name.

## Settings

| Setting | What it does |
|---|---|
| **Send jots to** | *Same-named note* or *Note you choose* (above). |
| **Folder** | Where the category notes live (same-named) or where new ones are created (note you choose). Empty means the vault root. |
| **Position** | Top (after any properties) or bottom of the note, or of the heading's section. |
| **Heading** | Optional. Put the jots under this heading instead. Added at the end of the note if missing. Type `### Inbox` to choose the level; `Inbox` alone creates `## Inbox`. |
| **Trash export files after importing** | Only for export files inside the vault. Files chosen from disk are never touched. |
| **Offer to import new exports** | Show a notice with an Import button when an export appears in the vault. |

The imported jots keep exactly the formatting Jot rendered (prefix,
timestamps, spacing, sort, tags), separated from what's around them by one
blank line. Existing notes are matched case-insensitively. Category names
with characters Obsidian can't use in file names are cleaned up (`Work /
Life` becomes `Work - Life`).

Importing the exact same file twice asks first, so an accidental second
import doesn't double your jots.

Attachments: Jot's export with attachments is a zip with a `media/` folder
beside the file, and the jot lines link into it. Unzip it into your vault if
you want those links to resolve. The plugin only reads the `.md`.

## Privacy

Everything happens on your device. The plugin makes no network requests,
collects no data, and needs no account. When you use **Choose a file**, it
reads the one file you pick, which may be outside the vault. That is the only
time it touches anything outside the vault. In the vault it writes only to
the category notes (and their `jot-category-id` property) and trashes the
imported export file if you leave that setting on.

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
