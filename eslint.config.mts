import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores, defineConfig } from "eslint/config";

// Obsidian's own rule set (eslint-plugin-obsidianmd) encodes the plugin
// guidelines: sentence case, no inline styles, no sample names, vault API
// use, mobile-safe regexes, settings-tab conventions. `npm run lint`.
// package.json is linted too, as the review bot does: its
// depend/ban-dependencies rule rejects packages Node or the web already
// provide (builtin-modules was one).
export default defineConfig(
  globalIgnores([
    "node_modules",
    "dist",
    "esbuild.config.mjs",
    "version-bump.mjs",
    "versions.json",
    "main.js",
    "package-lock.json",
    "tsconfig.json",
    "eslint.config.mts",
    "test",
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mts", "manifest.json"],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".json"],
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    rules: {
      // "Jot" is the app this plugin imports from — a product name, not a word.
      "obsidianmd/ui/sentence-case": ["warn", { brands: ["Jot", "Obsidian", "Markdown"] }],
    },
  },
);
