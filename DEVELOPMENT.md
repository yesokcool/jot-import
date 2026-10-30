# Developing Jot Import

For contributors. Users only need `README.md`.

## Commands

```
npm install
npm run dev     # rebuild main.js on every change
npm run build   # type-check src/ and test/, then bundle main.js
npm test        # unit tests in Node, no Obsidian needed
npm run lint    # Obsidian's ESLint rules (eslint-plugin-obsidianmd)
```

The tests run TypeScript directly, so they need Node 22.6 or later. GitHub
runs lint, tests and build on every push and pull request
(`.github/workflows/lint.yml`).

To try a build, copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/jot-import/` and reload Obsidian.

## Code layout

Only `main.ts`, `settings.ts` and `link-modal.ts` import Obsidian. The rest is
plain TypeScript, so the tests run it in Node.

- `src/main.ts`: the plugin. Commands, ribbon, the new-export notice, the
  repeat-import check, and `ObsidianVault`, the real `VaultPort`.
- `src/importer.ts`: an import from start to end: plan, ask, write, and pick
  up a stopped one where it stopped (`importExport`). The dialog's answers
  become `linkMoves`, which also move an already linked category. Works over
  `VaultPort`, so tests run whole imports against an in-memory vault.
- `src/format.ts`: parses the export, and inserts jots into a note's text.
- `src/routing.ts`: which note a category goes to (by `jot-category-id`, or
  by name for an export with no ids), the note suggestions, and the note
  typed in the dialog.
- `src/data.ts`: the settings, their defaults, what `data.json` holds, and
  the check that a saved or chosen value fits its setting.
- `src/settings.ts`: the settings tab, built with Obsidian's declarative
  settings API.
- `src/link-modal.ts`: the "choose notes" dialog (also the settings'
  "Change where categories go") and the note-and-heading dialog.
- `src/shorten.ts`: cuts a long path in the middle for the dialog.
- `src/zip.ts`: reads a zip with the platform's `DecompressionStream`. Size
  limits are `ZIP_LIMITS` and `MOBILE_ZIP_LIMITS`.
- `src/zip-export.ts`: finds the export and its attachments in a zip.
- `src/media.ts`: finds and rewrites the attachment links in jots.
- `styles.css`: styles for the dialogs and the notice, using Obsidian's CSS
  variables.
- `test/`: one test file per module. `test/fixtures/` holds zips made the way
  Jot makes them; `make-exports.py` and `zip-folder.swift` rebuild them on
  macOS. `test/zip-builder.ts` builds zips Jot never would (damaged, hostile).

Two things to know:

- `data.json` saves only the settings the user changed, so a new default
  reaches everyone who never changed that setting.
- A category's link and its own heading live in the note's properties
  (`jot-category-id`, `jot-category-heading`), not in `data.json`, so they
  sync with the note.

## Code rules

`npm run lint` checks most of these.

- No network requests, telemetry or Node and Electron APIs. The plugin runs on
  mobile.
- Use `this.app`, `Vault.process` for edits, `normalizePath` on every built
  path, and `FileManager.trashFile` to delete.
- No `innerHTML` and no inline styles. Styles go in `styles.css`.
- No regex lookbehind (older iOS) and no console logging.
- UI text in sentence case.

## Testing in real Obsidian

Obsidian's CLI (`obsidian`, turned on in Settings ▸ General) talks to the
running app, so a build can be tested without touching the screen:

```
obsidian plugin:reload id=jot-import
obsidian eval code='app.plugins.plugins["jot-import"].importText("<export text>")'
obsidian dev:errors
```

Use a throwaway folder and category names no real note has. Afterwards,
delete the folder and the plugin's `data.json`.

## The export format

The Jot app writes this format (`ExportBuilder.ObsidianEnvelope`) and
`src/format.ts` reads it. They change together, and both have tests.

```markdown
<!-- jot:export v=1 date=2026-09-14T10:22:05Z -->
Stats: 3 jots across 2 categories

<!-- jot:category name="Ideas" id="0D4C2A1B-5E7F-4A2B-9C3D-8E1F2A3B4C5D" -->
- a podcast about old maps
- a tea shop with a reading room
<!-- /jot:category -->

<!-- jot:category name="Gifts" id="9A1E…" workspace="Home" -->
- June: a good umbrella
<!-- /jot:category -->
```

- `name` is a JSON string. `>` is written `>`, so a name can't close the
  comment.
- `id` is the category's UUID. Older exports have none, so it's optional.
- `workspace` is the category's workspace in Jot, a JSON string escaped like
  `name`. It's left out for a category in no workspace, and older exports
  have none. Such a category's notes go in `<Folder>/<workspace>/`, the
  workspace cleaned like a note name.
- Attributes can come in any order, and unknown ones are ignored, in the
  header too. That lets the format grow without a new `v`. A `v` newer than
  the plugin knows is refused.
- Jots with no category are in an "Uncategorized" block with the fixed id
  `00000000-0000-0000-0000-00000000A11E`.
- Text outside the category blocks is ignored. Empty blocks are skipped. An
  export file is trashed after import only if all it holds outside its blocks
  is what Jot writes there: the header, the `Stats:` line, blank lines and a
  workspace's name (a heading, or in capitals) between blocks.
- Inside a marker, only spaces and tabs separate its parts.
- Jot escapes marker text inside a jot as `&lt;!--`. If the markers still
  don't pair up, the last block never closes, or a block with jots has no
  readable name, the plugin refuses the export and keeps the file.

When the jots have attachments, Jot shares a zip of one folder:

```
jot-export-…/
  jot-export-….md
  media/<attachment id>.<ext>
```

Jots link into `media/`: `![name](media/<file>)` for photos and drawings,
`[video: media/<file>]` and `[file: media/<file>]` for the rest. A file keeps
the extension it was added with, which can hold spaces, `)` or `]`, so
`media.ts` ends each link where it names a file in the zip. Apple's zips put
sizes only in the central directory and write UTF-8 names without the UTF-8
flag, some in decomposed form (NFD).

An attachment that can't be read, or a file in `media/` no jot links to,
doesn't stop the import: the jot keeps Jot's link, the notice counts it, and
the zip is kept.

## Releasing

Obsidian reads releases from GitHub, so this folder is the root of its own
repository.

1. If the release needs a newer Obsidian API, raise `minAppVersion` in
   `manifest.json` first.
2. Run `npm version x.y.z`. It runs `version-bump.mjs`, which copies the
   version into `manifest.json` and adds it to `versions.json`, then commits
   and tags `x.y.z`. The tag has no `v` (`.npmrc`), because Obsidian needs it
   to equal the manifest version.
3. Run `git push && git push --tags`. The tag starts
   `.github/workflows/release.yml`, which stops if the tag isn't the manifest
   version, then lints, tests, builds, attests the build, and opens a draft
   release with `main.js`, `manifest.json` and `styles.css`.
4. Check the draft and publish it.

`npm test` also checks that `package.json`, `package-lock.json`,
`manifest.json` and `versions.json` agree on the version.

**1.0.0 until the first listing.** The plugin was renumbered 1.1.1 → 1.0.0
on 2026-10-30, before its first listing in Community plugins, and the
earlier public releases (1.0.0, 1.1.0, 1.1.1) were deleted; their code is
still in the public history. Fixes before the listing go into 1.0.0 without
a version bump: skip step 2, and delete the draft or published 1.0.0 release
and its tag before tagging again. Numbering moves on from the first listed
release.
