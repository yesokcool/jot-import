import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS } from "../src/data.ts";
import { parseJotExport } from "../src/format.ts";
import { openZipExport, zipMedia } from "../src/zip-export.ts";
import { buildZip } from "./zip-builder.ts";
import {
  applyLinkMoves,
  changesLink,
  errorReason,
  exportToOffer,
  fingerprint,
  HISTORY_LIMIT,
  importExport,
  type ImportJob,
  type ImportRecord,
  looksLikeExportName,
  type ImportSettings,
  type LinkChoice,
  linkedCategories,
  linkMoves,
  type MediaSource,
  mergeHistories,
  OfferedExports,
  OfferNotice,
  type Plan,
  planImport,
  priorImport,
  recordImport,
  resolvePlan,
  runImport,
  saveDeduped,
  startingChoice,
  propertiesProblem,
  stoppedText,
  summaryText,
  type VaultPort,
} from "../src/importer.ts";
import { HEADING_PROPERTY, headingsFrom, LINK_PROPERTY, linkedIdsFrom, type NoteInfo, withHeading, withLinkedId, withoutLinkedId } from "../src/routing.ts";

const DEV = "0D4C2A1B-1111-4A2B-9C3D-000000000001";
const JOT = "0D4C2A1B-1111-4A2B-9C3D-000000000002";
const NEWCAT = "0D4C2A1B-1111-4A2B-9C3D-000000000003";

/**
 * An in-memory vault. Frontmatter is kept as a tiny YAML subset (scalars,
 * `- item` lists and one level of `key: value` maps), enough for
 * `jot-category-id`, `jot-category-heading` and `aliases`. Attachments go
 * where Obsidian's "In subfolder under current folder" setting puts them
 * (`<note folder>/attachments/`), deduped like Obsidian ("name 1.png"), and
 * links are wikilinks with the shortest path, Obsidian's defaults.
 */
class FakeVault implements VaultPort {
  files = new Map<string, string>();
  binaries = new Map<string, Uint8Array>();
  failOn: string | null = null;
  /** A write to this path never finishes. */
  hangOn: string | null = null;

  constructor(files: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(files)) this.files.set(path, text);
  }

  notes(): NoteInfo[] {
    return [...this.files.keys()].map((path) => {
      const fm = readFrontmatter(this.files.get(path) ?? "");
      const basename = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
      const aliases = Array.isArray(fm.aliases) ? fm.aliases : [];
      return { path, basename, aliases, linkedIds: linkedIdsFrom(fm), headings: headingsFrom(fm) };
    });
  }

  exists(path: string) {
    return this.files.has(path) || this.binaries.has(path);
  }

  saveAttachment(name: string, data: Uint8Array, notePath: string) {
    return saveDeduped(
      {
        availablePath: async (file, note) => {
          const folder = note.includes("/") ? `${note.slice(0, note.lastIndexOf("/"))}/attachments` : "attachments";
          const dot = file.lastIndexOf(".");
          let path = `${folder}/${file}`;
          for (let n = 1; this.exists(path); n++) path = `${folder}/${file.slice(0, dot)} ${n}${file.slice(dot)}`;
          return path;
        },
        size: (path) => this.binaries.get(path)?.length ?? null,
        read: async (path) => this.binaries.get(path) ?? new Uint8Array(),
        write: async (path, bytes) => {
          this.binaries.set(path, bytes);
        },
      },
      name,
      data,
      notePath,
    );
  }

  linkTo(path: string, _notePath: string, alias?: string) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const unique = [...this.binaries.keys()].filter((p) => p.endsWith(`/${name}`) || p === name).length === 1;
    return `[[${unique ? name : path}${alias ? `|${alias}` : ""}]]`;
  }

  async create(path: string, content: string) {
    // Like Obsidian on macOS and Windows: the disk ignores case, so a name
    // that differs only in case is "already there".
    if ([...this.files.keys()].some((p) => p.toLowerCase() === path.toLowerCase())) throw new Error("File already exists.");
    this.files.set(path, content);
  }

  hanging(path: string): this {
    this.hangOn = path;
    return this;
  }

  async process(path: string, fn: (data: string) => string) {
    if (path === this.failOn) throw new Error("disk full");
    if (path === this.hangOn) await new Promise(() => undefined);
    const text = this.files.get(path);
    if (text === undefined) throw new Error("the note is missing");
    this.files.set(path, fn(text));
  }

  async unlink(path: string, id: string) {
    const text = this.files.get(path);
    if (text === undefined) return;
    const fm = readFrontmatter(text);
    const ids = withoutLinkedId(fm[LINK_PROPERTY], id);
    if (ids) fm[LINK_PROPERTY] = ids;
    else delete fm[LINK_PROPERTY];
    const map = withHeading(fm[HEADING_PROPERTY], id, undefined);
    if (map) fm[HEADING_PROPERTY] = map;
    else delete fm[HEADING_PROPERTY];
    this.files.set(path, (Object.keys(fm).length > 0 ? writeFrontmatter(fm) : "") + stripFrontmatter(text));
  }

  async link(path: string, id: string, heading?: string) {
    const text = this.files.get(path) ?? "";
    const fm = readFrontmatter(text);
    fm[LINK_PROPERTY] = withLinkedId(fm[LINK_PROPERTY], id);
    if (heading !== undefined) {
      const map = withHeading(fm[HEADING_PROPERTY], id, heading);
      if (map) fm[HEADING_PROPERTY] = map;
    }
    this.files.set(path, writeFrontmatter(fm) + stripFrontmatter(text));
  }
}

type Yaml = string | string[] | Record<string, string>;

function readFrontmatter(text: string): Record<string, Yaml> {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const out: Record<string, Yaml> = {};
  if (!m) return out;
  let key = "";
  for (const line of m[1].split("\n")) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key) {
      const list = Array.isArray(out[key]) ? (out[key] as string[]) : [];
      out[key] = [...list, item[1]];
      continue;
    }
    const entry = /^\s+([^:]+):\s*(.*)$/.exec(line);
    if (entry && key) {
      const map = typeof out[key] === "object" && !Array.isArray(out[key]) ? (out[key] as Record<string, string>) : {};
      out[key] = { ...map, [entry[1]]: JSON.parse(entry[2]) as string };
      continue;
    }
    const pair = /^([^:]+):\s*(.*)$/.exec(line);
    if (pair) {
      key = pair[1];
      out[key] = pair[2];
    }
  }
  return out;
}

function writeFrontmatter(fm: Record<string, Yaml>): string {
  const lines = Object.entries(fm).map(([k, v]) =>
    Array.isArray(v)
      ? `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}`
      : typeof v === "object"
        ? `${k}:\n${Object.entries(v).map(([id, h]) => `  ${id}: ${JSON.stringify(h)}`).join("\n")}`
        : `${k}: ${v}`,
  );
  return `---\n${lines.join("\n")}\n---\n`;
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function exportText(blocks: Array<{ name: string; id?: string; workspace?: string; body: string }>, date = "2026-10-25T17:00:00Z"): string {
  const parts = [`<!-- jot:export v=1 date=${date} -->`, "Stats: n jots", ""];
  for (const b of blocks) {
    const attributes = `name=${JSON.stringify(b.name)}${b.id ? ` id="${b.id}"` : ""}${b.workspace ? ` workspace=${JSON.stringify(b.workspace)}` : ""}`;
    parts.push(`<!-- jot:category ${attributes} -->`, b.body, "<!-- /jot:category -->", "");
  }
  return parts.join("\n");
}

const SETTINGS: ImportSettings = { folder: "Jot", position: "bottom", heading: "" };
const INSERT = { position: "bottom" as const, heading: "" };

async function importInto(
  vault: FakeVault,
  text: string,
  settings: ImportSettings,
  choices = new Map<string, LinkChoice>(),
  exclude = new Set<string>(),
) {
  const parsed = parseJotExport(text);
  assert.ok(parsed);
  const plan = planImport(parsed, vault.notes(), settings, exclude);
  const outcome = await runImport(resolvePlan(plan, choices), vault, INSERT);
  return { plan, ...outcome };
}

test("an export with no ids (an older Jot) goes to the same-named notes in the Folder, created if missing", async () => {
  const vault = new FakeVault({ "Jot/Dev.md": "# Dev\n\n- old\n", "Areas/Jot.md": "elsewhere\n" });
  const text = exportText([
    { name: "DEV", body: "- new dev" },
    { name: "Jot", body: "- new jot" },
  ]);
  const { plan, result, error } = await importInto(vault, text, SETTINGS);
  assert.equal(error, null);
  assert.equal(plan.toLink.length, 0, "nothing to link, so nothing to ask");
  assert.equal(plan.unlinkable, 2);
  assert.equal(vault.files.get("Jot/Dev.md"), "# Dev\n\n- old\n\n- new dev\n");
  assert.equal(vault.files.get("Jot/Jot.md"), "- new jot\n", "a note in another folder isn't used");
  assert.equal(vault.files.get("Areas/Jot.md"), "elsewhere\n");
  assert.deepEqual(result, { notes: ["Dev", "Jot"], created: ["Jot"], linked: [], attachments: 0, unreadable: 0 });
});

test("first import: asks once per category, with the same-named note picked", async () => {
  const vault = new FakeVault({ "Areas/Dev.md": "# Dev\n", "Projects/Project Jot.md": "# Jot\n" });
  const parsed = parseJotExport(
    exportText([
      { name: "DEV", id: DEV, body: "- a" },
      { name: "JOT", id: JOT, body: "- b" },
      { name: "Brand New", id: NEWCAT, body: "- c" },
    ]),
  );
  assert.ok(parsed);
  const plan = planImport(parsed, vault.notes(), SETTINGS);
  assert.deepEqual(
    plan.toLink.map((r) => [r.block.name, r.suggestion.pick?.path ?? null, r.suggestion.others.map((n) => n.path), r.newPath, r.newPathExists]),
    [
      ["DEV", "Areas/Dev.md", [], "Jot/DEV.md", false],
      ["JOT", null, ["Projects/Project Jot.md"], "Jot/JOT.md", false],
      ["Brand New", null, [], "Jot/Brand New.md", false],
    ],
  );
  assert.ok(plan.writes.every((w) => w.path === null), "nothing is written before the answers");
  assert.deepEqual(
    plan.toLink.map(startingChoice),
    [{ kind: "note", path: "Areas/Dev.md" }, null, { kind: "new" }],
    "a similar note is never picked for you, and nothing similar starts on a new note",
  );
});

test("the answers are stamped once, then later imports go straight there", async () => {
  const vault = new FakeVault({
    "Areas/Dev.md": "---\nstatus: active\n---\n# Dev\n",
    "Projects/Project Jot.md": "# Jot\n",
  });
  const first = exportText([
    { name: "DEV", id: DEV, body: "- a" },
    { name: "JOT", id: JOT, body: "- b" },
    { name: "Brand New", id: NEWCAT, body: "- c" },
  ]);
  const choices = new Map<string, LinkChoice>([
    [DEV, { kind: "note", path: "Areas/Dev.md" }],
    [JOT, { kind: "note", path: "Projects/Project Jot.md" }],
    [NEWCAT, { kind: "new" }],
  ]);
  const one = await importInto(vault, first, SETTINGS, choices);
  assert.equal(one.error, null);
  assert.deepEqual(one.result.linked, ["DEV", "JOT", "Brand New"]);
  assert.deepEqual(one.result.created, ["Brand New"]);
  assert.equal(
    vault.files.get("Areas/Dev.md"),
    `---\nstatus: active\n${LINK_PROPERTY}:\n  - ${DEV}\n---\n# Dev\n\n- a\n`,
    "other properties are kept",
  );
  assert.equal(vault.files.get("Jot/Brand New.md"), `---\n${LINK_PROPERTY}:\n  - ${NEWCAT}\n---\n- c\n`);

  // The user renames and moves the note, and renames the category in Jot.
  vault.files.set("Archive/Jot app.md", vault.files.get("Projects/Project Jot.md") ?? "");
  vault.files.delete("Projects/Project Jot.md");
  const second = await importInto(vault, exportText([{ name: "Jot (the app)", id: JOT, body: "- d" }], "2026-10-26T09:00:00Z"), SETTINGS);
  assert.equal(second.plan.toLink.length, 0, "no questions the second time");
  assert.equal(second.error, null);
  assert.ok(vault.files.get("Archive/Jot app.md")?.endsWith("# Jot\n\n- b\n\n- d\n"));
  assert.ok(!vault.files.has("Jot/Jot (the app).md"), "no stray note for the new name");
});

test("linking a note that starts with a byte-order mark adds no second properties block", async () => {
  // Obsidian's property editing doesn't see properties behind the mark (the fake vault's doesn't either).
  const vault = new FakeVault({ "Areas/Dev.md": "\uFEFF---\nstatus: active\n---\n# Dev\n" });
  const text = exportText([{ name: "Dev", id: DEV, body: "- a" }]);
  const { error } = await importInto(vault, text, { ...SETTINGS, position: "top" }, new Map([[DEV, { kind: "note", path: "Areas/Dev.md" }]]));
  assert.equal(error, null);
  assert.equal(vault.files.get("Areas/Dev.md"), `---\nstatus: active\n${LINK_PROPERTY}:\n  - ${DEV}\n---\n# Dev\n\n- a\n`);
});

test("a note whose link was synced in twice gets its jots and lists the link once", async () => {
  // Obsidian Sync merged a Mac's and a phone's link to the same note (2026-10-31); Obsidian then reads none of
  // its properties. Already linked: the import writes the jots and folds the repeat.
  const twice = `---\nstatus: active\n${LINK_PROPERTY}:\n  - ${DEV}\n${LINK_PROPERTY}:\n  - ${DEV}\n---\n# Dev\n`;
  const vault = new FakeVault({ "Areas/Dev.md": twice });
  const { error } = await importInto(vault, exportText([{ name: "Dev", id: DEV, body: "- a" }]), SETTINGS);
  assert.equal(error, null);
  assert.equal(vault.files.get("Areas/Dev.md"), `---\nstatus: active\n${LINK_PROPERTY}:\n  - ${DEV}\n---\n# Dev\n\n- a\n`);

  // Not seen as linked (Obsidian couldn't read it), so the dialog links it again: the repeat is folded first.
  const relink = new FakeVault({ "Areas/Dev.md": twice });
  const again = await importInto(relink, exportText([{ name: "Dev", id: NEWCAT, body: "- b" }]), SETTINGS, new Map([[NEWCAT, { kind: "note", path: "Areas/Dev.md" }]]));
  assert.equal(again.error, null);
  assert.equal(relink.files.get("Areas/Dev.md"), `---\nstatus: active\n${LINK_PROPERTY}:\n  - ${DEV}\n  - ${NEWCAT}\n---\n# Dev\n\n- b\n`);
});

test("two categories can share a note, and a note holds both ids", async () => {
  const vault = new FakeVault({ "Inbox.md": "" });
  const text = exportText([
    { name: "A", id: DEV, body: "- a" },
    { name: "B", id: JOT, body: "- b" },
  ]);
  const choices = new Map<string, LinkChoice>([
    [DEV, { kind: "note", path: "Inbox.md" }],
    [JOT, { kind: "note", path: "Inbox.md" }],
  ]);
  const { result } = await importInto(vault, text, SETTINGS, choices);
  assert.deepEqual(result.notes, ["Inbox"]);
  assert.deepEqual(vault.notes().find((n) => n.path === "Inbox.md")?.linkedIds, [DEV, JOT]);
  assert.ok(vault.files.get("Inbox.md")?.endsWith("- a\n\n- b\n"));
});

test("an export without ids (Jot 1.5) goes by name and says so", async () => {
  const vault = new FakeVault({ "Jot/Ideas.md": "" });
  const { plan, result } = await importInto(vault, exportText([{ name: "Ideas", body: "- x" }]), SETTINGS);
  assert.equal(plan.unlinkable, 1);
  assert.equal(plan.toLink.length, 0);
  assert.deepEqual(result.notes, ["Ideas"]);
});

test("the same id in two notes uses the first and reports it", async () => {
  const vault = new FakeVault({
    "B/Ideas.md": `---\n${LINK_PROPERTY}:\n  - ${DEV}\n---\n`,
    "A.md": `---\n${LINK_PROPERTY}: ${DEV}\n---\n`,
  });
  const { plan } = await importInto(vault, exportText([{ name: "Ideas", id: DEV, body: "- x" }]), SETTINGS);
  assert.deepEqual(plan.ambiguous, ["Ideas"]);
  assert.ok(vault.files.get("A.md")?.endsWith("- x\n"), "a hand-written single id counts too");
});

test("two new categories whose names make the same file name each get a note of their own", async () => {
  const vault = new FakeVault();
  const text = exportText([
    { name: "Work / Life", id: DEV, body: "- a" },
    { name: "Work - Life", id: JOT, body: "- b" },
  ]);
  const { plan, result, error } = await importInto(vault, text, SETTINGS);
  assert.equal(error, null);
  assert.deepEqual(plan.toLink.map((r) => [r.newPath, r.newPathExists]), [["Jot/Work - Life.md", false], ["Jot/Work - Life 1.md", false]]);
  assert.deepEqual(plan.toLink.map(startingChoice), [{ kind: "new" }, { kind: "new" }]);
  assert.deepEqual(result.created, ["Work - Life", "Work - Life 1"]);
  assert.deepEqual(vault.notes().map((n) => [n.path, n.linkedIds]), [["Jot/Work - Life.md", [DEV]], ["Jot/Work - Life 1.md", [JOT]]]);
});

test("C, C# and C++ are three categories with three notes", async () => {
  const C = "0D4C2A1B-1111-4A2B-9C3D-00000000000C";
  const vault = new FakeVault();
  const text = exportText([
    { name: "C", id: C, body: "- pointers" },
    { name: "C#", id: DEV, body: "- LINQ" },
    { name: "C++", id: JOT, body: "- templates" },
  ]);
  const { plan, error } = await importInto(vault, text, SETTINGS);
  assert.equal(error, null);
  assert.deepEqual(plan.toLink.map((r) => r.newPath), ["Jot/C.md", "Jot/C 1.md", "Jot/C++.md"]);
  assert.equal(vault.files.get("Jot/C.md"), `---\n${LINK_PROPERTY}:\n  - ${C}\n---\n- pointers\n`);
  assert.ok(vault.files.get("Jot/C 1.md")?.endsWith("- LINQ\n"));
  assert.ok(vault.files.get("Jot/C++.md")?.endsWith("- templates\n"));

  // C++'s same-named note is C++.md, never C's.
  const later = planImport(parseJotExport(exportText([{ name: "C++", id: NEWCAT, body: "- x" }]))!, [
    { path: "Jot/C.md", basename: "C", aliases: [], linkedIds: [] },
    { path: "Jot/C++.md", basename: "C++", aliases: [], linkedIds: [] },
  ], SETTINGS);
  assert.equal(later.toLink[0].suggestion.pick?.path, "Jot/C++.md");
});

test("with no ids, names that differ only in case share a note; with ids, each gets its own", async () => {
  const vault = new FakeVault();
  const text = exportText([
    { name: "Work", body: "- w1" },
    { name: "work", body: "- w2" },
  ]);
  const { result, error } = await importInto(vault, text, SETTINGS);
  assert.equal(error, null);
  assert.deepEqual([...vault.files.keys()], ["Jot/Work.md"]);
  assert.equal(vault.files.get("Jot/Work.md"), "- w1\n\n- w2\n");
  assert.deepEqual(result.created, ["Work"]);

  // With ids, both answered "New note".
  const linked = new FakeVault();
  const two = exportText([
    { name: "Ideas", id: DEV, body: "- a" },
    { name: "IDEAS", id: JOT, body: "- b" },
  ]);
  const outcome = await importInto(linked, two, SETTINGS);
  assert.equal(outcome.error, null);
  assert.deepEqual(outcome.plan.toLink.map((r) => r.newPath), ["Jot/Ideas.md", "Jot/IDEAS 1.md"]);
  assert.deepEqual(linked.notes().map((n) => [n.path, n.linkedIds]), [["Jot/Ideas.md", [DEV]], ["Jot/IDEAS 1.md", [JOT]]]);
});

test("a same-named note that holds another category is never the default: the row waits, New note is numbered", async () => {
  // Two workspaces with an Inbox each: the first is linked to Jot/Inbox.md already.
  const vault = new FakeVault({ "Jot/Inbox.md": `---\n${LINK_PROPERTY}:\n  - ${DEV}\n---\n- work inbox\n`, "Jot/Inbox 1.md": "mine\n" });
  const text = exportText([{ name: "Inbox", id: NEWCAT, body: "- home inbox" }]);
  const parsed = parseJotExport(text);
  assert.ok(parsed);
  const plan = planImport(parsed, vault.notes(), SETTINGS);
  const [request] = plan.toLink;
  assert.equal(request.linkedSameName, "Jot/Inbox.md");
  assert.deepEqual([request.newPath, request.newPathExists], ["Jot/Inbox 2.md", false], "a taken number is skipped");
  assert.equal(startingChoice(request), null, "the import waits for a choice");

  const { error, result } = await importInto(vault, text, SETTINGS, new Map([[NEWCAT, { kind: "new" }]]));
  assert.equal(error, null);
  assert.equal(vault.files.get("Jot/Inbox.md"), `---\n${LINK_PROPERTY}:\n  - ${DEV}\n---\n- work inbox\n`, "untouched");
  assert.equal(vault.files.get("Jot/Inbox 2.md"), `---\n${LINK_PROPERTY}:\n  - ${NEWCAT}\n---\n- home inbox\n`);
  assert.deepEqual(result.created, ["Inbox 2"]);

  // Chosen on purpose, the note holds both.
  const shared = new FakeVault({ "Jot/Inbox.md": `---\n${LINK_PROPERTY}:\n  - ${DEV}\n---\n` });
  await importInto(shared, text, SETTINGS, new Map([[NEWCAT, { kind: "note", path: "Jot/Inbox.md" }]]));
  assert.deepEqual(shared.notes()[0].linkedIds, [DEV, NEWCAT]);

  // An unlinked note with the name elsewhere is still where the row starts.
  const elsewhere = new FakeVault({ "Jot/Inbox.md": `---\n${LINK_PROPERTY}:\n  - ${DEV}\n---\n`, "Home/Inbox.md": "" });
  const again = planImport(parsed, elsewhere.notes(), SETTINGS);
  assert.deepEqual(startingChoice(again.toLink[0]), { kind: "note", path: "Home/Inbox.md" });
  assert.equal(again.toLink[0].newPath, "Jot/Inbox 1.md");
});

test("an export with no ids goes by name, even into a note linked to a category", async () => {
  const vault = new FakeVault({ "Jot/Inbox.md": `---\n${LINK_PROPERTY}:\n  - ${DEV}\n---\n` });
  const { error } = await importInto(vault, exportText([{ name: "Inbox", body: "- x" }]), SETTINGS);
  assert.equal(error, null);
  assert.ok(vault.files.get("Jot/Inbox.md")?.endsWith("- x\n"));
});

test("a failure stops the import and says what was already written", async () => {
  const vault = new FakeVault({ "Jot/A.md": "", "Jot/B.md": "" });
  vault.failOn = "Jot/B.md";
  const { result, error } = await importInto(
    vault,
    exportText([
      { name: "A", body: "- a" },
      { name: "B", body: "- b" },
      { name: "C", body: "- c" },
    ]),
    SETTINGS,
  );
  assert.deepEqual(error, { path: "Jot/B.md", message: "disk full" });
  assert.deepEqual(result.notes, ["A"]);
  assert.ok(!vault.files.has("Jot/C.md"), "nothing after the failure");
});

/** Imports the way the plugin does: each record it gets replaces the export's earlier one in `history`. */
async function importTracked(vault: FakeVault, text: string, history: { list: ImportRecord[] }, at = 1, media?: MediaSource) {
  const parsed = parseJotExport(text);
  assert.ok(parsed);
  const print = fingerprint(text);
  const outcome = await importExport({
    parsed,
    print,
    prior: priorImport(history.list, print),
    notes: vault.notes(),
    settings: SETTINGS,
    ask: async () => new Map(),
    port: vault,
    options: INSERT,
    media,
    progress: async (record) => {
      history.list = recordImport(history.list, record, HISTORY_LIMIT);
    },
    now: () => at,
  });
  assert.ok(outcome);
  if (outcome.record) history.list = recordImport(history.list, outcome.record, HISTORY_LIMIT);
  return outcome;
}

const ABC = exportText([
  { name: "A", body: "- a" },
  { name: "B", body: "- b" },
  { name: "C", body: "- c" },
]);

test("a stopped import picks up where it stopped, so a retry adds nothing twice", async () => {
  const vault = new FakeVault({ "Jot/A.md": "", "Jot/B.md": "" });
  vault.failOn = "Jot/B.md";
  const print = fingerprint(ABC);
  const history = { list: [] as ImportRecord[] };

  const first = await importTracked(vault, ABC, history, 1);
  assert.equal(first.result.notes.length, 1);
  assert.deepEqual(priorImport(history.list, print), { kind: "stopped", written: 1, unreadable: 0 }, "a stopped import isn't 'already imported'");

  vault.failOn = null; // the user fixes whatever stopped it
  const second = await importTracked(vault, ABC, history, 2);
  assert.equal(second.error, null);
  assert.equal(second.resumed, 1);
  assert.equal(vault.files.get("Jot/A.md"), "- a\n", "not added twice");
  assert.equal(vault.files.get("Jot/B.md"), "- b\n");
  assert.equal(vault.files.get("Jot/C.md"), "- c\n");
  assert.deepEqual(priorImport(history.list, print), { kind: "done", at: 2 });
  assert.equal(history.list.length, 1, "one record per export");
});

/** Lets the import run until it waits on a write that never finishes, as when Obsidian is killed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("an import cut off midway (Obsidian quit or killed) resumes after the blocks it wrote", async () => {
  const vault = new FakeVault({ "Jot/A.md": "", "Jot/B.md": "", "Jot/C.md": "" });
  const print = fingerprint(ABC);
  const history = { list: [] as ImportRecord[] };

  vault.hangOn = "Jot/C.md"; // killed while it writes C
  void importTracked(vault, ABC, history);
  await settle();
  assert.deepEqual(priorImport(history.list, print), { kind: "stopped", written: 2, unreadable: 0 });

  vault.hangOn = null;
  const retry = await importTracked(vault, ABC, history);
  assert.equal(retry.error, null);
  assert.equal(vault.files.get("Jot/A.md"), "- a\n", "not added twice");
  assert.equal(vault.files.get("Jot/B.md"), "- b\n", "not added twice");
  assert.equal(vault.files.get("Jot/C.md"), "- c\n");
});

test("an import cut off before its first block went in isn't 'stopped partway'", async () => {
  const vault = new FakeVault({ "Jot/A.md": "" });
  const print = fingerprint(ABC);
  const history = { list: [] as ImportRecord[] };
  vault.hangOn = "Jot/A.md";
  void importTracked(vault, ABC, history);
  await settle();
  assert.deepEqual(priorImport(history.list, print), { kind: "new" }, "nothing was saved");

  // An earlier finished import of the same file still counts as imported.
  const done = { list: [{ fingerprint: print, importedAt: 5, notes: 3 }] as ImportRecord[] };
  void importTracked(new FakeVault({ "Jot/A.md": "" }).hanging("Jot/A.md"), ABC, done);
  await settle();
  assert.deepEqual(priorImport(done.list, print), { kind: "done", at: 5 });

  // A record saved before any block went in, as earlier versions did, means nothing to resume.
  assert.deepEqual(priorImport([{ fingerprint: print, importedAt: 5, notes: 0, stoppedAfter: 0 }], print), { kind: "new" });
});

test("two devices' histories merge: every export once, its newest record, newest first", () => {
  const laptop: ImportRecord[] = [
    { fingerprint: "b", importedAt: 30, notes: 1, stoppedAfter: 1 },
    { fingerprint: "a", importedAt: 10, notes: 2 },
  ];
  const phone: ImportRecord[] = [
    { fingerprint: "c", importedAt: 40, notes: 1 },
    { fingerprint: "b", importedAt: 35, notes: 3 }, // the phone finished the import the laptop stopped
  ];
  const merged = mergeHistories(phone, laptop, 100);
  assert.deepEqual(merged, [phone[0], phone[1], laptop[1]]);
  assert.deepEqual(mergeHistories(laptop, phone, 100), merged, "either way round");
  assert.deepEqual(mergeHistories(phone, laptop, 2), [phone[0], phone[1]], "at most the limit, oldest out");
  // The repeat-import guard now knows what the other device imported.
  assert.deepEqual(priorImport(merged, "c"), { kind: "done", at: 40 });
  assert.deepEqual(priorImport(merged, "b"), { kind: "done", at: 35 });
});

test("the export file itself is never a target", async () => {
  const vault = new FakeVault({ "jot-export-ideas.md": "" });
  const parsed = parseJotExport(exportText([{ name: "jot-export-ideas", id: DEV, body: "- x" }]));
  assert.ok(parsed);
  const plan = planImport(parsed, vault.notes(), { ...SETTINGS, folder: "" }, new Set(["jot-export-ideas.md"]));
  assert.equal(plan.toLink[0].suggestion.pick, null);
});

test("an export pasted into a category's note is never written into: that category gets a new note", async () => {
  // "Import the active file" on Ideas.md, which holds the user's text and the pasted export.
  const text = exportText([
    { name: "Ideas", body: "- idea" },
    { name: "Work", body: "- work" },
  ]);
  const note = "# My ideas\n\n" + text;
  const vault = new FakeVault({ "Ideas.md": note, "Work.md": "" });
  const { plan, result, error } = await importInto(vault, text, { ...SETTINGS, folder: "" }, new Map(), new Set(["Ideas.md"]));
  assert.equal(error, null);
  assert.equal(vault.files.get("Ideas.md"), note, "the export's note is untouched");
  assert.equal(vault.files.get("Ideas 1.md"), "- idea\n");
  assert.equal(vault.files.get("Work.md"), "- work\n");
  assert.deepEqual(result.created, ["Ideas 1"]);
  assert.deepEqual(plan.besideExport, [{ name: "Ideas", path: "Ideas 1.md", exportPath: "Ideas.md" }]);
  assert.ok(summaryText(result, { besideExport: plan.besideExport }).includes("The Ideas jots went to Ideas 1 because the Jot export file is named Ideas."));

  // Another case or Unicode form is the same file on disk; a taken number is skipped.
  const loose = new FakeVault({ "ideas.md": text, "Ideas 1.md": "mine\n" });
  const two = await importInto(loose, text, { ...SETTINGS, folder: "" }, new Map(), new Set(["ideas.md"]));
  assert.equal(two.error, null);
  assert.equal(loose.files.get("ideas.md"), text);
  assert.equal(loose.files.get("Ideas 1.md"), "mine\n");
  assert.equal(loose.files.get("Ideas 2.md"), "- idea\n");

  // With ids, "New note" is never the export either.
  const linked = new FakeVault({ "Jot/Ideas.md": text });
  const withId = exportText([{ name: "Ideas", id: DEV, body: "- idea" }]);
  const three = await importInto(linked, withId, SETTINGS, new Map([[DEV, { kind: "new" }]]), new Set(["Jot/Ideas.md"]));
  assert.deepEqual(three.plan.toLink.map((r) => [r.newPath, r.newPathExists]), [["Jot/Ideas 1.md", false]]);
  assert.equal(three.error, null);
  assert.equal(linked.files.get("Jot/Ideas.md"), text);
  assert.equal(linked.files.get("Jot/Ideas 1.md"), `---\n${LINK_PROPERTY}:\n  - ${DEV}\n---\n- idea\n`);
  assert.deepEqual(three.plan.besideExport, [], "the dialog showed where it goes");
});

const NOW = Date.parse("2026-10-28T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

test("an export is offered once, and a new one at the same path once the old file is gone", () => {
  // Jot names exports by date, so the evening's export lands where the morning's was.
  const offered = new OfferedExports();
  assert.ok(offered.claim("jot-export-2026-10-28.md", NOW - 4 * 60 * 60 * 1000, NOW));
  assert.ok(!offered.claim("jot-export-2026-10-28.md", NOW - 4 * 60 * 60 * 1000, NOW), "not twice for the same file");
  offered.release("jot-export-2026-10-28.md"); // imported and trashed, or moved away
  assert.ok(offered.claim("jot-export-2026-10-28.md", NOW, NOW), "the next file at that path");
});

test("only recent exports are offered, and one notice at a time, for the newest", () => {
  const offered = new OfferedExports();
  // Exports kept on another device arrive by sync with their old dates.
  assert.ok(!offered.claim("jot-export-2026-10-01.md", NOW - 27 * DAY, NOW), "an old export isn't news");
  assert.ok(!offered.claim("jot-export-2026-10-24.md", NOW - 4 * DAY, NOW), "the same three days as at startup");
  assert.ok(offered.claim("jot-export-2026-10-26.md", NOW - 2 * DAY, NOW));
  assert.ok(!offered.claim("jot-export-2026-10-25.md", NOW - 3 * DAY + 1, NOW), "an older one doesn't stack a second notice");
  assert.ok(offered.claim("jot-export-2026-10-28.md", NOW - 60 * 1000, NOW), "a newer one takes the notice's place");
  assert.ok(!offered.claim("jot-export-2026-10-27.md", NOW - DAY, NOW));
});

test("at startup only recent exports are read, newest first, and reading stops at the one to offer", async () => {
  const file = (name: string, age: number, size = 8000, extension = name.slice(name.lastIndexOf(".") + 1)) => ({
    name,
    extension,
    stat: { mtime: NOW - age, size },
  });
  // Years of exports kept in the vault, every one of them a zip.
  const old = Array.from({ length: 200 }, (_, i) => file(`jot-export-2025-${i}.zip`, (4 + i) * DAY));
  const files = [
    ...old,
    file("jot-export-2026-10-26.zip", 2 * DAY),
    file("jot-export-2026-10-27.md", DAY),
    file("jot-export-2026-10-28.zip", 60 * 60 * 1000), // imported already
    file("jot-export-huge.zip", 60 * 1000, 2 * 1024 * 1024 * 1024), // too large to import
  ];
  const limits = { zipBytes: 1024 * 1024 * 1024, textBytes: 32 * 1024 * 1024 };
  const read: string[] = [];
  const reader = async (f: { name: string }) => {
    read.push(f.name);
    return `export ${f.name}`;
  };
  const imported = (text: string) => text.endsWith("2026-10-28.zip");
  const offered = await exportToOffer(files, NOW, limits, reader, imported);
  assert.equal(offered?.name, "jot-export-2026-10-27.md");
  assert.deepEqual(read, ["jot-export-2026-10-28.zip", "jot-export-2026-10-27.md"], "no old or too-large file is read");

  read.length = 0;
  assert.equal(await exportToOffer(old, NOW, limits, reader, () => false), null);
  assert.equal(read.length, 0, "a vault of old exports reads nothing");

  read.length = 0;
  const notExports = await exportToOffer(files, NOW, limits, async (f) => (read.push(f.name), null), () => false);
  assert.equal(notExports, null);
  assert.equal(read.length, 3, "files that turn out not to be exports: the recent ones are read, still no old one");
});

test("export names: Jot's own, and the copies Files and browsers number", () => {
  for (const name of ["jot-export-2026-10-29-0910", "jot-export-Work-2026-10-29-0910 2", "Work Jots", "Work Jots 2", "Work Jots (1)", "work jots(3)"]) {
    assert.ok(looksLikeExportName(name), name);
  }
  for (const name of ["Ideas", "Jots of ideas", "Work Jots copy", "Work Jots 2b"]) assert.ok(!looksLikeExportName(name), name);
});

test("an export is checked as offerable before it's read", () => {
  const offered = new OfferedExports();
  assert.ok(!offered.mayClaim("jot-export-2026-10-01.zip", NOW - 27 * DAY, NOW), "an old file isn't read for a notice");
  assert.ok(offered.mayClaim("jot-export-2026-10-28.zip", NOW - 60 * 1000, NOW));
  assert.ok(offered.mayClaim("jot-export-2026-10-28.zip", NOW - 60 * 1000, NOW), "asking claims nothing");
  assert.ok(offered.claim("jot-export-2026-10-28.zip", NOW - 60 * 1000, NOW));
  assert.ok(!offered.mayClaim("jot-export-2026-10-28.zip", NOW - 60 * 1000, NOW), "offered already");
  assert.ok(!offered.mayClaim("jot-export-2026-10-27.zip", NOW - DAY, NOW), "older than the one offered");
});

test("the new-export notice goes once its file is gone or its export was imported another way", () => {
  class FakeNotice {
    hidden = false;
    hide() {
      this.hidden = true;
    }
  }
  const notices = new OfferNotice<FakeNotice>();
  const file = { path: "jot-export-2026-10-28-1540.md" };
  const first = new FakeNotice();
  notices.set(first, file, "print-a");
  notices.fileGone("Ideas.md");
  notices.hideIfImported((print) => print === "print-b");
  assert.equal(first.hidden, false, "another file, another export: it stays");
  notices.hideIfImported((print) => print === "print-a");
  assert.equal(first.hidden, true, "imported by the command, the dialog, a picked file or another device");

  const second = new FakeNotice();
  notices.set(second, file, "print-b");
  file.path = "Inbox/jot-export-2026-10-28-1540.md"; // moved: Obsidian's file object follows
  notices.fileGone("jot-export-2026-10-28-1540.md");
  assert.equal(second.hidden, false, "a move keeps it, Import still finds the file");
  notices.fileGone("Inbox/jot-export-2026-10-28-1540.md");
  assert.equal(second.hidden, true, "trashed or deleted");

  // A newer export's notice takes the place of the one before; closing an old one leaves the new one.
  const older = new FakeNotice();
  const newer = new FakeNotice();
  notices.set(older, { path: "a.md" }, "a");
  notices.set(newer, { path: "b.md" }, "b");
  assert.ok(older.hidden && !newer.hidden);
  notices.hide(older);
  assert.equal(newer.hidden, false);
  notices.hide();
  assert.equal(newer.hidden, true, "unload");
});

test("notices: one period after Obsidian's own messages, and long lists cut short", () => {
  const stopped = stoppedText({ path: "Jot/work.md", message: "File already exists." }, { notes: ["Work"], created: [], linked: [], attachments: 0, unreadable: 0 });
  assert.equal(
    stopped,
    "Jot Import stopped at Jot/work.md.\nFile already exists.\nBefore stopping, Jot Import added jots to Work.\nThe Jot export file was kept.\nImport the file again to add the rest.",
  );
  assert.ok(!stopped.includes(".."), stopped);
  const first = stoppedText({ path: "Jot/work.md", message: "File already exists." }, { notes: [], created: [], linked: [], attachments: 0, unreadable: 0 });
  assert.ok(!first.includes("Before stopping"), "nothing was added yet");
  const missing = stoppedText({ path: "Jot/work.md", message: "the Obsidian note is missing" }, { notes: [], created: [], linked: [], attachments: 0, unreadable: 0 });
  assert.ok(missing.includes("\nThe Obsidian note is missing.\n"), missing);

  assert.equal(errorReason(new Error("File already exists. ")), "File already exists");
  assert.equal(errorReason("disk full"), "disk full");

  const many = Array.from({ length: 25 }, (_, i) => `Note ${i + 1}`);
  const summary = summaryText({ notes: many, created: many, linked: [], attachments: 0, unreadable: 0 });
  assert.ok(summary.startsWith("Jot Import added jots to 25 notes: Note 1, Note 2,"), summary);
  assert.ok(summary.includes("and 15 more"), summary);
  assert.ok(!summary.includes("Note 25"), summary);
  assert.equal(summaryText({ notes: ["Ideas"], created: [], linked: [], attachments: 0, unreadable: 0 }), "Jot Import added jots to 1 note: Ideas.");
});

test("fingerprints are stable, ignore line endings, and differ between exports", () => {
  const a = exportText([{ name: "A", body: "- a" }]);
  assert.equal(fingerprint(a), fingerprint(a.replace(/\n/g, "\r\n")));
  assert.notEqual(fingerprint(a), fingerprint(exportText([{ name: "A", body: "- a" }], "2026-10-26T00:00:00Z")));
});

// ---- 1.1: top by default, a heading per category, typed new notes, zipped exports

/** Plan, answer and write one export, the way the plugin does. */
async function importWith(
  vault: FakeVault,
  text: string,
  settings: ImportSettings,
  choices = new Map<string, LinkChoice>(),
  media?: Parameters<typeof runImport>[4],
) {
  const parsed = parseJotExport(text);
  assert.ok(parsed);
  const plan = planImport(parsed, vault.notes(), settings);
  const outcome = await runImport(resolvePlan(plan, choices), vault, { position: settings.position, heading: settings.heading }, undefined, media);
  return { plan, ...outcome };
}

test("top, the default, keeps a note newest first across imports (bottom zig-zags)", async () => {
  // Jot's default sort is newest first, within each export.
  const monday = exportText([{ name: "Ideas", body: "- 10/27 c\n\n- 10/26 b\n\n- 10/25 a" }], "2026-10-27T20:00:00Z");
  const friday = exportText([{ name: "Ideas", body: "- 10/31 f\n\n- 10/30 e\n\n- 10/29 d" }], "2026-10-31T20:00:00Z");
  const settings: ImportSettings = { ...DEFAULT_SETTINGS, folder: "" };
  assert.equal(settings.position, "top");

  const top = new FakeVault({ "Ideas.md": "---\ntags: ideas\n---\n" });
  await importWith(top, monday, settings);
  await importWith(top, friday, settings);
  assert.equal(top.files.get("Ideas.md"), "---\ntags: ideas\n---\n- 10/31 f\n\n- 10/30 e\n\n- 10/29 d\n\n- 10/27 c\n\n- 10/26 b\n\n- 10/25 a\n");

  const bottom = new FakeVault({ "Ideas.md": "" });
  await importWith(bottom, monday, { ...settings, position: "bottom" });
  await importWith(bottom, friday, { ...settings, position: "bottom" });
  assert.equal(bottom.files.get("Ideas.md"), "- 10/27 c\n\n- 10/26 b\n\n- 10/25 a\n\n- 10/31 f\n\n- 10/30 e\n\n- 10/29 d\n");

  // Under a heading too: right below it, newest first.
  const headed = new FakeVault({ "Ideas.md": "# Ideas\n\n## Inbox\n\n## Done\n\n- old\n" });
  await importWith(headed, monday, { ...settings, heading: "Inbox" });
  await importWith(headed, friday, { ...settings, heading: "Inbox" });
  assert.equal(
    headed.files.get("Ideas.md"),
    "# Ideas\n\n## Inbox\n\n- 10/31 f\n\n- 10/30 e\n\n- 10/29 d\n\n- 10/27 c\n\n- 10/26 b\n\n- 10/25 a\n\n## Done\n\n- old\n",
  );
});

test("top with jots that bring their own # headings: each day keeps its jots; a # Title is a heading to choose", async () => {
  // Jot's timestamp prefix "# " with group by date.
  const monday = exportText([{ name: "Ideas", body: "# Oct 27, 2026\n- lamp for the hall\n\n- scarf" }], "2026-10-27T20:00:00Z");
  const tuesday = exportText([{ name: "Ideas", body: "# Oct 28, 2026\n- noodle place on Elm" }], "2026-10-28T20:00:00Z");
  const settings: ImportSettings = { ...DEFAULT_SETTINGS, folder: "" };

  const created = new FakeVault();
  await importWith(created, monday, settings);
  await importWith(created, tuesday, settings);
  assert.equal(created.files.get("Ideas.md"), "# Oct 28, 2026\n- noodle place on Elm\n\n# Oct 27, 2026\n- lamp for the hall\n\n- scarf\n");

  // With no heading chosen, the very top, above the note's own # Title.
  const titled = new FakeVault({ "Ideas.md": "# Ideas\n" });
  await importWith(titled, monday, settings);
  assert.equal(titled.files.get("Ideas.md"), "# Oct 27, 2026\n- lamp for the hall\n\n- scarf\n\n# Ideas\n");

  // Chosen as the heading, the title keeps the jots under it.
  const underTitle = new FakeVault({ "Ideas.md": "# Ideas\n" });
  await importWith(underTitle, monday, { ...settings, heading: "# Ideas" });
  await importWith(underTitle, tuesday, { ...settings, heading: "# Ideas" });
  assert.equal(
    underTitle.files.get("Ideas.md"),
    "# Ideas\n\n# Oct 28, 2026\n- noodle place on Elm\n\n# Oct 27, 2026\n- lamp for the hall\n\n- scarf\n",
  );
});

test("a category's own heading: chosen once, kept in the note, used by every later import", async () => {
  const vault = new FakeVault({ "Areas/Dev.md": "# Dev\n\n## Inbox\n\n- old\n\n## Archive\n" });
  const settings: ImportSettings = { ...SETTINGS, position: "top", heading: "" };
  const first = exportText([
    { name: "DEV", id: DEV, body: "- a" },
    { name: "Garden", id: NEWCAT, body: "- seeds" },
  ]);
  const choices = new Map<string, LinkChoice>([
    [DEV, { kind: "note", path: "Areas/Dev.md", heading: "Inbox" }],
    // A new note the user named, in a folder, under a heading it doesn't have yet.
    [NEWCAT, { kind: "new", path: "Projects/Garden ideas.md", heading: "### Seeds" }],
  ]);
  const one = await importWith(vault, first, settings, choices);
  assert.equal(one.error, null);
  assert.equal(
    vault.files.get("Areas/Dev.md"),
    `---\n${LINK_PROPERTY}:\n  - ${DEV}\n${HEADING_PROPERTY}:\n  ${DEV}: "Inbox"\n---\n# Dev\n\n## Inbox\n\n- a\n\n- old\n\n## Archive\n`,
  );
  assert.equal(
    vault.files.get("Projects/Garden ideas.md"),
    `---\n${LINK_PROPERTY}:\n  - ${NEWCAT}\n${HEADING_PROPERTY}:\n  ${NEWCAT}: "### Seeds"\n---\n### Seeds\n\n- seeds\n`,
  );
  assert.deepEqual(one.result.created, ["Garden ideas"]);

  // Later: no questions, same headings, wherever the notes are now.
  const second = await importWith(vault, exportText([{ name: "DEV", id: DEV, body: "- b" }], "2026-10-30T09:00:00Z"), settings);
  assert.equal(second.plan.toLink.length, 0);
  assert.ok(vault.files.get("Areas/Dev.md")?.includes("## Inbox\n\n- b\n\n- a\n\n- old\n\n## Archive\n"));
});

test("a category's own heading whose text starts with # goes under that heading", async () => {
  // Picked in the dialog from "## #1 picks": saved with its level, so the # isn't a level marker.
  const vault = new FakeVault({
    "Books.md": `---\n${LINK_PROPERTY}:\n  - ${DEV}\n${HEADING_PROPERTY}:\n  ${DEV}: "## #1 picks"\n---\n## #1 picks\n- The Overstory\n\n## Later\n`,
  });
  const { error } = await importWith(vault, exportText([{ name: "Books", id: DEV, body: "- Piranesi" }]), { ...SETTINGS, position: "top" });
  assert.equal(error, null);
  assert.ok(vault.files.get("Books.md")?.endsWith("---\n## #1 picks\n\n- Piranesi\n\n- The Overstory\n\n## Later\n"), vault.files.get("Books.md"));
});

test("a category's heading overrides the Heading setting; no entry follows it", async () => {
  const vault = new FakeVault({ "Dev.md": "## Inbox\n", "Ideas.md": "## Inbox\n" });
  const settings: ImportSettings = { ...SETTINGS, folder: "", position: "top", heading: "Inbox" };
  const text = exportText([
    { name: "Dev", id: DEV, body: "- dev" },
    { name: "Ideas", id: JOT, body: "- idea" },
  ]);
  const choices = new Map<string, LinkChoice>([
    [DEV, { kind: "note", path: "Dev.md", heading: "" }], // the note itself, not the Inbox
    [JOT, { kind: "note", path: "Ideas.md" }], // the setting's Inbox
  ]);
  await importWith(vault, text, settings, choices);
  assert.equal(vault.files.get("Dev.md"), `---\n${LINK_PROPERTY}:\n  - ${DEV}\n${HEADING_PROPERTY}:\n  ${DEV}: ""\n---\n- dev\n\n## Inbox\n`);
  assert.equal(vault.files.get("Ideas.md"), `---\n${LINK_PROPERTY}:\n  - ${JOT}\n---\n## Inbox\n\n- idea\n`);
});

test("a typed new note spelled like another new note in this import shares it", async () => {
  const vault = new FakeVault();
  const text = exportText([
    { name: "Ideas", id: DEV, body: "- a" },
    { name: "Other", id: JOT, body: "- b" },
  ]);
  const choices = new Map<string, LinkChoice>([[JOT, { kind: "new", path: "Jot/ideas.md" }]]);
  const { error } = await importWith(vault, text, SETTINGS, choices);
  assert.equal(error, null);
  assert.deepEqual([...vault.files.keys()], ["Jot/Ideas.md"], "one note, not a second the disk would refuse");
});

test("a zipped export: attachments go beside each note, links point at them, a repeat import reuses them", async () => {
  const zip = await openZipExport(new Uint8Array(readFileSync(new URL("./fixtures/jot-export-2026-10-28-1540.zip", import.meta.url))));
  const media = {
    has: (ref: string) => zip.media.has(ref),
    read: (ref: string) => zip.read(zip.media.get(ref)!),
  };
  const vault = new FakeVault({ "Travel/Places.md": "# Places\n" });
  // A user who had same-named notes: each category starts on its note, and is linked to it.
  const settings: ImportSettings = { ...DEFAULT_SETTINGS, folder: "Travel" };
  const one = await importWith(vault, zip.text, settings, new Map(), media);
  assert.deepEqual(one.plan.toLink.map(startingChoice), [{ kind: "note", path: "Travel/Places.md" }, { kind: "new" }]);
  assert.equal(one.error, null);
  assert.equal(one.result.attachments, 4);
  assert.deepEqual([...vault.binaries.keys()].sort(), [
    "Travel/attachments/3F2A9C41-6B7D-4E8F-9A0B-1C2D3E4F5A6B.png",
    "Travel/attachments/5D4C3B2A-1908-4F7E-A6D5-C4B3A2918070.pdf",
    "Travel/attachments/8E7D6C5B-4A39-4281-B7C6-D5E4F3A2B1C0.png",
    "Travel/attachments/A1B2C3D4-E5F6-4789-8ABC-DEF012345678.mov",
  ]);
  const places = vault.files.get("Travel/Places.md") ?? "";
  assert.ok(places.includes("try the pastéis de nata ![[3F2A9C41-6B7D-4E8F-9A0B-1C2D3E4F5A6B.png]]"), places);
  assert.ok(!places.includes("media/"), "no link left pointing into the zip");
  assert.ok(
    vault.files.get("Travel/Gifts.md")?.includes(
      "gift basket [file: [[5D4C3B2A-1908-4F7E-A6D5-C4B3A2918070.pdf]]] [video: [[A1B2C3D4-E5F6-4789-8ABC-DEF012345678.mov]]]",
    ),
  );
  assert.equal(summaryText(one.result), "Jot Import added jots to 2 notes: Places, Gifts. Created 1 new note: Gifts. Saved 4 attachments. Linked 2 categories to Obsidian notes.");

  // "Import again": the same files are already there, so no copies.
  const two = await importWith(vault, zip.text, settings, new Map(), media);
  assert.equal(two.result.attachments, 0);
  assert.equal(vault.binaries.size, 4);

  // The same name with other bytes is a different file: saved beside it under a new name.
  vault.binaries.set("Travel/attachments/3F2A9C41-6B7D-4E8F-9A0B-1C2D3E4F5A6B.png", new Uint8Array([1]));
  const three = await importWith(vault, zip.text, settings, new Map(), media);
  assert.equal(three.result.attachments, 1);
  assert.ok(vault.binaries.has("Travel/attachments/3F2A9C41-6B7D-4E8F-9A0B-1C2D3E4F5A6B 1.png"));

  // Once more: that numbered copy is reused, not copied again as "… 2.png".
  const four = await importWith(vault, zip.text, settings, new Map(), media);
  assert.equal(four.result.attachments, 0);
  assert.ok(!vault.binaries.has("Travel/attachments/3F2A9C41-6B7D-4E8F-9A0B-1C2D3E4F5A6B 2.png"));
  assert.ok(vault.files.get("Travel/Places.md")?.includes("![[3F2A9C41-6B7D-4E8F-9A0B-1C2D3E4F5A6B 1.png]]"));
});

test("the .md alone (unzipped by hand, no media) still imports, links as Jot wrote them", async () => {
  const zip = await openZipExport(new Uint8Array(readFileSync(new URL("./fixtures/jot-export-2026-10-28-1540.zip", import.meta.url))));
  const vault = new FakeVault();
  const { error, result } = await importWith(vault, zip.text, { ...DEFAULT_SETTINGS, folder: "" });
  assert.equal(error, null);
  assert.equal(result.attachments, 0);
  assert.ok(vault.files.get("Places.md")?.includes("](media/3F2A9C41-6B7D-4E8F-9A0B-1C2D3E4F5A6B.png)"));
});

test("a damaged attachment doesn't stop the import: its jot keeps Jot's link, no note is left empty, the zip is kept", async () => {
  const text = exportText([
    { name: "Places", body: "- cafe ![AAAA.jpg](media/AAAA.jpg)" },
    { name: "Gifts", body: "- scarf ![BBBB.jpg](media/BBBB.jpg)" },
  ]);
  const zip = await openZipExport(
    buildZip([
      { name: "x/x.md", data: text },
      { name: "x/media/AAAA.jpg", data: new Uint8Array([1, 2, 3]) },
      { name: "x/media/BBBB.jpg", data: new Uint8Array([4, 5, 6]), crc: 1234 },
    ]),
  );
  const vault = new FakeVault();
  const { result, error } = await importWith(vault, zip.text, { ...SETTINGS, folder: "" }, new Map(), zipMedia(zip));
  assert.equal(error, null);
  assert.equal(result.attachments, 1);
  assert.equal(result.unreadable, 1);
  assert.equal(vault.files.get("Places.md"), "- cafe ![[AAAA.jpg]]\n");
  assert.equal(vault.files.get("Gifts.md"), "- scarf ![BBBB.jpg](media/BBBB.jpg)\n", "Jot's link, in a note that isn't empty");
  assert.deepEqual([...vault.binaries.keys()], ["attachments/AAAA.jpg"]);
  assert.equal(
    summaryText(result, { left: { count: zip.unlinked + result.unreadable, where: "Jots/x.zip" } }),
    "Jot Import added jots to 2 notes: Places, Gifts. Created 2 new notes: Places, Gifts. Saved 1 attachment. " +
      "1 attachment wasn't imported. It's still in the Jot export file (Jots/x.zip), which was kept.",
  );
  assert.ok(summaryText(result, { left: { count: 3, where: "x.zip" } }).includes("3 attachments weren't imported. They're still in the Jot export file (x.zip), which was kept."));
  assert.ok(!summaryText(result, { left: { count: 0, where: "x.zip" } }).includes("x.zip"));
});

test("attachments a stopped import couldn't read are still reported when it finishes", async () => {
  const text = exportText([
    { name: "A", body: "- a ![x](media/X.jpg)" },
    { name: "B", body: "- b" },
  ]);
  const media: MediaSource = {
    has: (ref) => ref === "media/X.jpg",
    read: async () => {
      throw new Error("can't be unpacked");
    },
  };
  const vault = new FakeVault({ "Jot/A.md": "", "Jot/B.md": "" });
  vault.failOn = "Jot/B.md";
  const history = { list: [] as ImportRecord[] };
  const first = await importTracked(vault, text, history, 1, media);
  assert.equal(first.unreadable, 1);
  assert.deepEqual(priorImport(history.list, fingerprint(text)), { kind: "stopped", written: 1, unreadable: 1 });

  vault.failOn = null;
  const second = await importTracked(vault, text, history, 2, media);
  assert.equal(second.error, null);
  assert.equal(second.unreadable, 1, "counted once the import finishes, so the zip is kept");
  assert.equal(vault.files.get("Jot/A.md"), "- a ![x](media/X.jpg)\n");
});

// ---- Already linked categories in the dialog, and "Change where categories go"

const devNote = (heading: string, body: string) =>
  `---\n${LINK_PROPERTY}:\n  - ${DEV}\n${HEADING_PROPERTY}:\n  ${DEV}: ${JSON.stringify(heading)}\n---\n${body}`;

test("the dialog lists the export's already linked categories after the new ones, starting where they go now", () => {
  const vault = new FakeVault({ "Areas/Dev.md": devNote("Inbox", "## Inbox\n") });
  const parsed = parseJotExport(exportText([{ name: "Dev", id: DEV, body: "- a" }, { name: "Garden", id: NEWCAT, body: "- b" }]));
  assert.ok(parsed);
  const plan = planImport(parsed, vault.notes(), SETTINGS);
  assert.deepEqual(plan.toLink.map((r) => r.block.name), ["Garden"]);
  assert.deepEqual(plan.linked.map((r) => [r.block.name, r.linked]), [["Dev", { paths: ["Areas/Dev.md"], heading: "Inbox" }]]);
  const start = startingChoice(plan.linked[0]);
  assert.deepEqual(start, { kind: "note", path: "Areas/Dev.md", heading: "Inbox" });
  assert.equal(changesLink(plan.linked[0], start ?? undefined), false);
  assert.equal(plan.linked[0].linkedSameName, null, "its own note isn't another category's");
  assert.equal(plan.linked[0].newPath, "Jot/Dev.md", "New note is a new one");
  // Left as it was, nothing about it changes.
  const writes = resolvePlan(plan, new Map(start ? [[DEV, start]] : []));
  assert.deepEqual(writes.map((w) => [w.path, w.link, w.unlinkFrom ?? []]), [["Areas/Dev.md", false, []], ["Jot/Garden.md", true, []]]);
});

test("moving an already linked category: the old note keeps its jots and loses the link, the new note gets it", async () => {
  const vault = new FakeVault({
    "Areas/Dev.md": devNote("Inbox", "## Inbox\n\n- old\n"),
    "Projects/Dev log.md": "## Inbox\n",
  });
  const text = exportText([{ name: "Dev", id: DEV, body: "- new" }, { name: "Garden", id: NEWCAT, body: "- seeds" }]);
  const choices = new Map<string, LinkChoice>([[DEV, { kind: "note", path: "Projects/Dev log.md", heading: "Inbox" }]]);
  const { error, result } = await importInto(vault, text, SETTINGS, choices);
  assert.equal(error, null);
  assert.equal(vault.files.get("Areas/Dev.md"), "## Inbox\n\n- old\n");
  assert.equal(vault.files.get("Projects/Dev log.md"), devNote("Inbox", "## Inbox\n\n- new\n"));
  assert.deepEqual(result.linked, ["Dev", "Garden"]);

  // The next import goes straight to the new note.
  const next = await importInto(vault, exportText([{ name: "Dev", id: DEV, body: "- later" }], "2026-10-30T09:00:00Z"), SETTINGS);
  assert.equal(next.plan.toLink.length, 0);
  assert.ok(vault.files.get("Projects/Dev log.md")?.includes("- new\n\n- later\n"));
});

test("an already linked category given another heading keeps its note", async () => {
  const vault = new FakeVault({ "Areas/Dev.md": devNote("Inbox", "## Inbox\n\n- old\n") });
  const text = exportText([{ name: "Dev", id: DEV, body: "- new" }, { name: "Garden", id: NEWCAT, body: "- seeds" }]);
  const choices = new Map<string, LinkChoice>([[DEV, { kind: "note", path: "Areas/Dev.md", heading: "" }]]);
  await importInto(vault, text, SETTINGS, choices);
  assert.equal(vault.files.get("Areas/Dev.md"), devNote("", "## Inbox\n\n- old\n\n- new\n"));
});

test("a category linked in two notes moves out of both", async () => {
  const vault = new FakeVault({
    "A.md": `---\n${LINK_PROPERTY}:\n  - ${DEV}\n---\n- a\n`,
    "B/A.md": `---\n${LINK_PROPERTY}:\n  - ${DEV}\n  - ${JOT}\n---\n- b\n`,
  });
  const text = exportText([{ name: "Dev", id: DEV, body: "- new" }, { name: "Garden", id: NEWCAT, body: "- seeds" }]);
  await importInto(vault, text, SETTINGS, new Map([[DEV, { kind: "new" }]]));
  assert.equal(vault.files.get("A.md"), "- a\n");
  assert.equal(vault.files.get("B/A.md"), `---\n${LINK_PROPERTY}:\n  - ${JOT}\n---\n- b\n`, "another category's link stays");
  assert.equal(vault.files.get("Jot/Dev.md"), `---\n${LINK_PROPERTY}:\n  - ${DEV}\n---\n- new\n`);
});

test("an import where every category is linked still asks, and a cancel writes nothing", async () => {
  const vault = new FakeVault({ "Areas/Dev.md": devNote("Inbox", "## Inbox\n") });
  const text = exportText([{ name: "Dev", id: DEV, body: "- a" }]);
  const parsed = parseJotExport(text);
  assert.ok(parsed);
  const job = (): ImportJob => ({
    parsed,
    print: fingerprint(text),
    prior: { kind: "new" },
    notes: vault.notes(),
    settings: SETTINGS,
    ask: async (plan) => {
      asked.push(plan);
      return asked.length === 1 ? null : new Map();
    },
    port: vault,
    options: INSERT,
    progress: async () => undefined,
  });
  const asked: Plan[] = [];
  assert.equal(await importExport(job()), null);
  assert.equal(asked[0].toLink.length, 0);
  assert.deepEqual(asked[0].linked.map((r) => r.block.name), ["Dev"]);
  assert.equal(vault.files.get("Areas/Dev.md"), devNote("Inbox", "## Inbox\n"));

  const outcome = await importExport(job());
  assert.equal(asked.length, 2);
  assert.equal(outcome?.error, null);
  assert.ok(vault.files.get("Areas/Dev.md")?.endsWith("## Inbox\n\n- a\n"));
});

test("an export from an older Jot is shown before it's written, and a cancel writes nothing", async () => {
  const vault = new FakeVault({});
  const text = exportText([{ name: "Ideas", body: "- a" }]);
  const parsed = parseJotExport(text);
  assert.ok(parsed);
  const asked: Plan[] = [];
  const outcome = await importExport({
    parsed,
    print: fingerprint(text),
    prior: { kind: "new" },
    notes: vault.notes(),
    settings: SETTINGS,
    ask: async (plan) => {
      asked.push(plan);
      return null;
    },
    port: vault,
    options: INSERT,
    progress: async () => undefined,
  });
  assert.equal(outcome, null);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].unlinkable, 1);
  assert.deepEqual(asked[0].writes.map((w) => w.path), ["Jot/Ideas.md"]);
  assert.equal(vault.files.size, 0);
});

test("Change where categories go: every linked category, moved without writing any jots", async () => {
  const vault = new FakeVault({
    "Areas/Dev.md": devNote("Inbox", "## Inbox\n\n- old\n"),
    "Ideas.md": `---\n${LINK_PROPERTY}:\n  - ${JOT}\n---\n- idea\n`,
  });
  const names: Record<string, string> = { [DEV]: "Dev", [JOT]: "Ideas" };
  const requests = linkedCategories(vault.notes(), (id) => ({ name: names[id], workspace: null }), SETTINGS);
  assert.deepEqual(requests.map((r) => [r.block.name, r.linked?.paths]), [["Dev", ["Areas/Dev.md"]], ["Ideas", ["Ideas.md"]]]);
  const choices = new Map(requests.map((r) => [r.block.id, startingChoice(r)!]));
  assert.deepEqual(linkMoves(requests, choices), [], "nothing changed, nothing to do");

  choices.set(DEV, { kind: "new", heading: "Inbox" });
  const moves = linkMoves(requests, choices);
  assert.deepEqual(moves, [{ id: DEV, name: "Dev", path: "Jot/Dev.md", heading: "Inbox", from: ["Areas/Dev.md"] }]);
  const { created } = await applyLinkMoves(moves, vault);
  assert.deepEqual(created, ["Dev"]);
  assert.equal(vault.files.get("Areas/Dev.md"), "## Inbox\n\n- old\n");
  assert.equal(vault.files.get("Jot/Dev.md"), devNote("Inbox", ""), "linked, with no jots in it");
  assert.equal(vault.files.get("Ideas.md"), `---\n${LINK_PROPERTY}:\n  - ${JOT}\n---\n- idea\n`);
});

// ---- Workspaces: a category in one gets new notes in a folder named after it

const WORK_INBOX = "0D4C2A1B-1111-4A2B-9C3D-0000000000A1";
const HOME_INBOX = "0D4C2A1B-1111-4A2B-9C3D-0000000000A2";

/** As Jot 1.7 writes it: two workspaces with an Inbox each, and a category in no workspace. */
const WORKSPACES = [
  "<!-- jot:export v=1 date=2026-11-02T09:00:00Z -->",
  "Stats: 3 jots across 3 categories",
  "",
  "## Work",
  "",
  `<!-- jot:category name="Inbox" id="${WORK_INBOX}" workspace="Work" -->`,
  "- call back about the lease",
  "<!-- /jot:category -->",
  "",
  "## Home",
  "",
  `<!-- jot:category name="Inbox" id="${HOME_INBOX}" workspace="Home" -->`,
  "- seeds for the garden",
  "<!-- /jot:category -->",
  "",
  `<!-- jot:category name="Ideas" id="${NEWCAT}" -->`,
  "- a reading nook",
  "<!-- /jot:category -->",
  "",
].join("\n");

test("workspaces: each Inbox gets a new note in its workspace's folder", async () => {
  const vault = new FakeVault();
  const { plan, error, result } = await importInto(vault, WORKSPACES, SETTINGS);
  assert.deepEqual(plan.toLink.map((r) => [r.newPath, r.linkedSameName]), [
    ["Jot/Work/Inbox.md", null],
    ["Jot/Home/Inbox.md", null],
    ["Jot/Ideas.md", null],
  ]);
  assert.deepEqual(plan.toLink.map(startingChoice), [{ kind: "new" }, { kind: "new" }, { kind: "new" }]);
  assert.equal(error, null);
  assert.deepEqual(result.created, ["Jot/Work/Inbox", "Jot/Home/Inbox", "Ideas"], "named by path where two share a name");
  assert.ok(summaryText(result).startsWith("Jot Import added jots to 3 notes: Jot/Work/Inbox, Jot/Home/Inbox, Ideas."));
  assert.ok(vault.files.get("Jot/Work/Inbox.md")?.endsWith("- call back about the lease\n"));
  assert.ok(vault.files.get("Jot/Home/Inbox.md")?.endsWith("- seeds for the garden\n"));
});

test("workspaces: only a same-named note in the workspace's own folder held by another category makes the row wait", () => {
  const OTHER = "0D4C2A1B-1111-4A2B-9C3D-0000000000FF";
  const held = `---\n${LINK_PROPERTY}:\n  - ${OTHER}\n---\n`;
  const vault = new FakeVault({ "Jot/Inbox.md": held, "Jot/Work/Inbox.md": held, "Areas/Inbox.md": "" });
  const parsed = parseJotExport(WORKSPACES);
  assert.ok(parsed);
  const [work, home] = planImport(parsed, vault.notes(), SETTINGS).toLink;
  assert.equal(work.linkedSameName, "Jot/Work/Inbox.md");
  assert.equal(work.newPath, "Jot/Work/Inbox 1.md");
  assert.equal(home.linkedSameName, null, "Jot/Inbox.md isn't in Home's folder");
  assert.equal(home.newPath, "Jot/Home/Inbox.md");
  // Both still start on the unlinked same-named note elsewhere.
  assert.deepEqual([work, home].map(startingChoice), [
    { kind: "note", path: "Areas/Inbox.md" },
    { kind: "note", path: "Areas/Inbox.md" },
  ]);
});

test("workspaces: suggestions prefer the workspace's folder", () => {
  const vault = new FakeVault({ "Areas/Inbox.md": "", "Jot/Inbox.md": "", "Jot/Home/Inbox.md": "" });
  const parsed = parseJotExport(WORKSPACES);
  assert.ok(parsed);
  const [work, home] = planImport(parsed, vault.notes(), SETTINGS).toLink;
  assert.equal(home.suggestion.pick?.path, "Jot/Home/Inbox.md");
  assert.equal(work.suggestion.pick?.path, "Jot/Inbox.md", "no Inbox in Jot/Work: the shallowest, then the shortest");
});

test("workspaces: a workspace's folder is spelled as the vault spells it", async () => {
  const vault = new FakeVault({ "Jot/Inbox.md": "mine\n", "Jot/work/Inbox.md": "work notes\n" });
  const { plan, error } = await importInto(vault, WORKSPACES, { ...SETTINGS, folders: ["Jot", "Jot/work"] });
  assert.deepEqual(plan.toLink.map((r) => r.newPath), ["Jot/work/Inbox.md", "Jot/Home/Inbox.md", "Jot/Ideas.md"]);
  assert.equal(plan.toLink[0].suggestion.pick?.path, "Jot/work/Inbox.md");
  assert.equal(error, null);
  assert.equal(vault.files.get("Jot/Inbox.md"), "mine\n", "the Folder's own Inbox isn't a workspace's");
  assert.ok(vault.files.get("Jot/work/Inbox.md")?.endsWith("work notes\n\n- call back about the lease\n"));
  assert.ok(vault.files.get("Jot/Home/Inbox.md")?.endsWith("- seeds for the garden\n"));
});

test("workspaces: an export without them goes where it always did", async () => {
  const older = WORKSPACES.replace(/ workspace="[^"]*"/g, "");
  const vault = new FakeVault();
  const { plan } = await importInto(vault, older, SETTINGS);
  assert.deepEqual(plan.toLink.map((r) => r.newPath), ["Jot/Inbox.md", "Jot/Inbox 1.md", "Jot/Ideas.md"]);
});

test("workspaces: Change where categories go offers a new note in the category's workspace folder", () => {
  const vault = new FakeVault({ "Areas/Inbox.md": `---\n${LINK_PROPERTY}:\n  - ${HOME_INBOX}\n---\n` });
  const [request] = linkedCategories(vault.notes(), () => ({ name: "Inbox", workspace: "Home" }), SETTINGS);
  assert.equal(request.newPath, "Jot/Home/Inbox.md");
});

test("notices: properties Obsidian can't read are named in plain words, with the note's own line", () => {
  // Obsidian's message from the yaml parser, as a phone showed it (2026-10-31).
  const yaml = new Error("Map keys must be unique at line 6, column 1:\n\n  - 0D4C2A1B-1111-4A2B-9C3D-000000000001\njot-category-id:\n^\n");
  yaml.name = "YAMLParseError";
  const twice = "status: active\ntags:\n  - trips\ntags:\n  - trips";
  assert.equal(
    propertiesProblem(yaml, twice),
    'This Obsidian note has two properties named "tags", and Obsidian doesn\'t allow that. Open the note and delete the second "tags" and anything listed under it',
  );
  assert.equal(
    propertiesProblem(yaml),
    "Obsidian can't read the properties at the top of this Obsidian note because line 7 has a mistake. Open the note and fix that line",
    "no repeat found: the line",
  );
  assert.ok(!propertiesProblem(yaml).includes("^"));
  assert.equal(propertiesProblem(new Error("File already exists.")), "File already exists.", "other errors as they are");
});
