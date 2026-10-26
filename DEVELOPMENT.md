# Developing and releasing Jot Import

Developer notes. Users only need `README.md`.

## Build

```
npm install
npm run lint      # Obsidian's own ESLint rules (eslint-plugin-obsidianmd)
npm test          # the format, routing and whole-import tests (Node, no Obsidian)
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
  interface. Pure; `test/importer.test.ts` runs whole imports against an
  in-memory vault.
- `src/main.ts`: the plugin: commands, ribbon, the new-export notice, the
  repeat-import guard, and `ObsidianVault` (the real `VaultPort`).
- `src/link-modal.ts`, `src/settings.ts`: the "choose notes" dialog and the
  declarative settings tab.

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
  for edits, `getFileByPath` / `getFolderByPath`, `normalizePath` on every
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
optional and reads attributes in any order, ignoring unknown ones. That is
what lets the format grow without bumping `v`. The "Uncategorized" block
(jots with no category) always has id `00000000-0000-0000-0000-00000000A11E`,
so it can be linked like any category. Everything outside a category block
is ignored: stats lines, workspace headers, separators. A `v` newer than
the plugin knows is refused. Empty blocks are skipped.
