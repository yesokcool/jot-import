# Developing and releasing Jot Import

Developer notes. Users only need `README.md`.

## Build

```
npm install
npm run lint      # Obsidian's own ESLint rules (eslint-plugin-obsidianmd)
npm test          # the format, routing, zip and whole-import tests (Node, no Obsidian)
npm run build     # type-check + bundle → main.js
npm run dev       # rebuild on change
```

To try a build in a vault: copy `main.js`, `manifest.json` and `styles.css`
into `<vault>/.obsidian/plugins/jot-import/` and reload Obsidian.

### How the code is split

- `src/format.ts`: the export format (parse) and where text goes inside a
  note (insert). Pure.
- `src/routing.ts`: which note a category goes to: same-named note, the
  `jot-category-id` links, and the deterministic suggestions. Pure.
- `src/importer.ts`: plan → ask → write, over a small `VaultPort`
  interface, plus the import history (repeat and stopped imports), the
  notices' text and which exports were offered. Pure; `test/importer.test.ts`
  runs whole imports against an in-memory vault that ignores case like
  macOS does.
- `src/data.ts`: what `data.json` holds (the settings, the import history,
  the category names) and how it's read. Pure.
- `src/zip.ts`, `src/zip-export.ts`, `src/media.ts`: zipped exports (below).
  Pure.
- `src/main.ts`: the plugin: commands, ribbon, the new-export notice, the
  repeat-import guard, and `ObsidianVault` (the real `VaultPort`).
- `src/link-modal.ts`, `src/settings.ts`: the "choose notes" dialog with its
  "Change" dialog, and the declarative settings tab.

### Defaults, and which settings are saved

Since 1.1.0 a new install sends jots to a **note you choose** (the first
import asks, with same-named notes already picked) and puts them at the
**top**, below the note's `# Title` (1.0 put them above it; `isTitle` in
`format.ts` says what counts as one, and why a `# ` heading an earlier
import wrote doesn't). Each import lands above the last, so the latest
import comes first. Inside an import the order is Jot's, not strictly
newest first: its default sort is newest first, but jots with attachments
are pinned first (on by default) and a category's tags group their jots
after the untagged ones, so the note is newest first import by import,
not jot by jot. At the bottom, each import follows the last one's (a
zig-zag with the default sort).

`data.json` holds only the settings the user set (`readSaved` /
`dataToSave`), so a later change of default reaches everyone who never chose.
1.0 saved every setting with its first import, so a 1.0 vault keeps all of
its values, `mode: "name"` and `position: "bottom"` included: its notes were
filled that way, and switching under it would change where the next jots go
without asking. To try the new defaults in such a vault, set them in the
settings tab.

### Headings per category: in the note, beside the link

A linked category's own heading is saved in the note's properties, next to
its id, as a map from id to heading (`""` is the note itself, no heading; no
entry uses the Heading setting):

```yaml
jot-category-id:
  - 0D4C2A1B-5E7F-4A2B-9C3D-8E1F2A3B4C5D
jot-category-heading:
  0D4C2A1B-5E7F-4A2B-9C3D-8E1F2A3B4C5D: Inbox
```

Not in `data.json`, keyed by id, though that would survive renames too:
the heading is half of where the category goes, and the link it belongs to
lives in the note. The note travels with every sync (Obsidian Sync, iCloud,
Git), while `data.json` only syncs when the user syncs plugin settings, so a
second device would know the note but not the heading and quietly put the
jots elsewhere. In the note, the link and its heading can't disagree, unlink
removes both, a note copied or restored from backup keeps both, and no merge
of two devices' maps (with deletions to carry) is needed. The cost: Obsidian's
properties panel shows a map as raw text rather than a list; it's edited in
the dialog or the settings tab, not by hand. `routing.ts` reads and writes
it (`headingsFrom`, `withHeading`).

### Zipped exports

When an export has attachments, Jot (`ExportFile.materialize`) zips a folder
with NSFileCoordinator's `.forUploading` and shares `<stem>.zip`:

```
jot-export-2026-10-28-1540/
  jot-export-2026-10-28-1540.md
  media/3F2A9C41-….png        (<attachment id>.<ext>)
```

The jots point into `media/`: `![name](media/<file>)` for photos and
drawings, `[video: media/<file>]` / `[file: media/<file>]` for the rest
(`ExportBuilder.textWithAttachmentMarkers`). Apple's zips deflate every
entry, put sizes in the central directory only (data descriptors), and write
UTF-8 names without the UTF-8 flag, some decomposed (NFD).

- `zip.ts` reads the central directory and inflates one entry at a time with
  the platform's `DecompressionStream("deflate-raw")`: Electron's Chromium on
  desktop, the system WebView on Android, WebKit on iOS from 16.4. No
  third-party code. Where it's missing, the import says so before writing
  anything. Refused: encrypted or split zips, a path with `..` or a leading
  `/` (zip slip; nothing is ever written by its zip path anyway), a zip over
  1 GB, an entry over 512 MB, more than 1 GB unpacked in all (on a phone or
  tablet, `Platform.isMobile`, half of each: `MOBILE_ZIP_LIMITS`), an entry
  that unpacks past its stated size, a CRC mismatch. Each unpacked file is
  its own exact-length buffer, handed to `createBinary` without a copy.
- `zip-export.ts` finds the export's `.md` and the files its jots use.
- `media.ts` finds and rewrites the links.
- `runImport` saves each file for the note its jot goes to, with
  `FileManager.getAvailablePathForAttachment` (the user's attachment
  setting, never over an existing file), reuses one with the same name and
  bytes (a repeat import), and rewrites the link with
  `FileManager.generateMarkdownLink` (the user's link format). Nothing is
  saved before the "choose notes" dialog is answered.
- A zip is trashed after importing only if it is unchanged and holds just
  the export and its `media/` folder.

`test/fixtures/` holds real zips made Jot's way: `make-exports.py` lays out
the folders, `zip-folder.swift` zips them with NSFileCoordinator (macOS).

### Testing in real Obsidian without touching the screen

Obsidian 1.12+ ships a CLI (`obsidian`, enable it in Settings ▸ General)
that talks to the running app, so a build can be tested end to end while
you keep working (2026-10-25):

```
obsidian plugin:reload id=jot-import
obsidian eval code='app.plugins.plugins["jot-import"].importText("<export text>")'
obsidian dev:errors
```

Work in a throwaway folder (e.g. `_Jot Import Test/`), use category names
no real note has (so suggestions never point at real notes), and delete
the folder and the plugin's `data.json` afterwards. Drive modals through the
DOM (`document.querySelector(".jot-import-link-modal button.mod-cta").click()`).
`obsidian dev:screenshot` only returns the last painted frame, so a hidden
or locked-screen window shows nothing new; instead write `document.body`
plus every stylesheet's rules to an HTML file with `window.require("fs")`
and render it with a headless Chromium. Settings open in their own window
since 1.14: read `app.setting.win.document`, not `document`. `obsidian
dev:mobile on|off` switches the UI to the mobile layout.

## Guidelines this plugin follows

From [docs.obsidian.md](https://docs.obsidian.md) (plugin guidelines,
submission requirements, developer policies, manifest reference), checked by
`npm run lint` where a rule exists:

- **Manifest.** `id` is lowercase-with-hyphens, has no "obsidian", doesn't
  end in "plugin". `name` has no "Obsidian" or "Plugin". `description` starts
  with an action verb, is under 250 characters, ends with a period, no emoji.
  `minAppVersion` is the lowest version every API we call exists in
  (the declarative settings API needs 1.13.0; `npm run lint` checks every
  call against it). No `fundingUrl` because we don't take
  donations. `isDesktopOnly: false` and no Node/Electron APIs.
- **Settings tab.** No heading above the general settings, no word "settings"
  in headings, sentence case everywhere ("Jot", "Obsidian" and "Markdown" are
  brand names, configured in `eslint.config.mts`).
- **Code.** `this.app`, never the global. No `innerHTML`; `createEl` and
  `empty()`. No inline styles (`hidden`, not `style.display`). `Vault.process`
  for edits, `getFileByPath` / `getAbstractFileByPath`, `normalizePath` on every
  built path, `FileManager.trashFile` so the user's trash setting is
  respected. `addCommand` with `callback` / `checkCallback`, no default
  hotkeys, no "command" or the plugin name in command names. No regex
  lookbehind (older iOS). No console logging.
- **Policies.** No network, no telemetry, no ads, no self-update. The README
  discloses the one thing that touches files outside the vault (the file
  picker). MIT `LICENSE` at the root. "Obsidian" is only used descriptively.
- **Settings** use the declarative API (`getSettingDefinitions`, Obsidian
  1.13), so they show up in Obsidian's settings search. Adopted 2026-10-25
  with 1.14.5 current. `setControlValue` is overridden because the default
  saves `settings` alone and would wipe the import history and category
  names saved beside them (found in a real-vault test).
- **Styles** live in `styles.css` (Obsidian's CSS variables only), which
  ships beside `main.js`.

## Releasing

Obsidian reads releases from GitHub, so **this folder must be the root of its
own public repository** (e.g. `yesokcool/jot-import`). The workflows in
`.github/workflows/` assume that.

1. `npm version 1.0.1` — runs `version-bump.mjs` (updates `manifest.json`
   and `versions.json`), commits, and tags `1.0.1` (no "v": `.npmrc`).
2. `git push && git push --tags` — `release.yml` lints, tests, builds, and
   opens a **draft** release with `main.js`, `manifest.json` and
   `styles.css` attached.
3. Publish the draft on GitHub. The tag, the release title and
   `manifest.json`'s `version` must all be the same `x.y.z`.

Bump `minAppVersion` in `manifest.json` *before* `npm version` when a release
starts using a newer API; `versions.json` records which plugin version needs
which app version.

## Submitting to the community directory (once)

1. Push the repo to GitHub and publish release `1.0.0` as above.
2. Sign in at [community.obsidian.md](https://community.obsidian.md) with an
   Obsidian account, link GitHub, and add the plugin.
3. Fix whatever the automated review flags, bump the version, release again.
4. After approval, later releases are picked up automatically. Announce in
   the forum's Share & Showcase if you like.

## The export format (v1)

Written by Jot's `ExportBuilder.ObsidianEnvelope`
(`jot/Utility/ExportBuilder.swift`); parsed by `src/format.ts`. Change both
together; both sides have tests (`ExportBuilderObsidianTests`,
`test/format.test.ts`).

```markdown
<!-- jot:export v=1 date=2026-09-14T10:22:05Z -->
Stats: 3 jots across 2 categories

<!-- jot:category name="Ideas" id="0D4C2A1B-5E7F-4A2B-9C3D-8E1F2A3B4C5D" -->
- build the obsidian thing
- rename the workspaces screen
<!-- /jot:category -->

<!-- jot:category name="Work" id="9A1E…" -->
- 9/14/26 call back
<!-- /jot:category -->
```

`name` is a JSON string literal (`>` is written `\u003e` so a name can
never close the comment). `id` is the category's UUID, added in Jot 1.6
(2026-10-25); Jot 1.5 wrote `name` only, so the parser treats `id` as
optional and reads attributes in any order, ignoring unknown ones, in the
header too (keys are letters, digits, `_` and `-`; values are JSON strings
or bare words). That is what lets the format grow without bumping `v`. The
"Uncategorized" block (jots with no category) always has id
`00000000-0000-0000-0000-00000000A11E`, so it can be linked like any
category. Everything outside a category block is ignored: stats lines,
workspace headers, separators. A `v` newer than the plugin knows is
refused. Empty blocks are skipped.

Jot doesn't escape jot text, so a jot can contain marker text. The plugin
refuses (and keeps the file) when the opening and closing markers don't
pair up with the blocks it read, when the last block never ends (a file cut
short), or when a block with jots has no readable `name`: importing the rest
would silently lose the jots those markers cut off.
