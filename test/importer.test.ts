import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJotExport } from "../src/format.ts";
import {
  fingerprint,
  type ImportSettings,
  type LinkChoice,
  planImport,
  resolvePlan,
  runImport,
  type VaultPort,
} from "../src/importer.ts";
import { LINK_PROPERTY, linkedIdsFrom, type NoteInfo, withLinkedId } from "../src/routing.ts";

const DEV = "0D4C2A1B-1111-4A2B-9C3D-000000000001";
const JOT = "0D4C2A1B-1111-4A2B-9C3D-000000000002";
const NEWCAT = "0D4C2A1B-1111-4A2B-9C3D-000000000003";

/**
 * An in-memory vault. Frontmatter is kept as a tiny YAML subset (scalars
 * and `- item` lists), enough for `jot-category-id` and `aliases`.
 */
class FakeVault implements VaultPort {
  files = new Map<string, string>();
  failOn: string | null = null;

  constructor(files: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(files)) this.files.set(path, text);
  }

  notes(): NoteInfo[] {
    return [...this.files.keys()].map((path) => {
      const fm = readFrontmatter(this.files.get(path) ?? "");
      const basename = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
      const aliases = Array.isArray(fm.aliases) ? fm.aliases : [];
      return { path, basename, aliases, linkedIds: linkedIdsFrom(fm) };
    });
  }

  exists(path: string) {
    return this.files.has(path);
  }

  async create(path: string, content: string) {
    if (this.files.has(path)) throw new Error("File already exists.");
    this.files.set(path, content);
  }

  async process(path: string, fn: (data: string) => string) {
    if (path === this.failOn) throw new Error("disk full");
    const text = this.files.get(path);
    if (text === undefined) throw new Error("the note is missing");
    this.files.set(path, fn(text));
  }

  async link(path: string, id: string) {
    const text = this.files.get(path) ?? "";
    const fm = readFrontmatter(text);
    fm[LINK_PROPERTY] = withLinkedId(fm[LINK_PROPERTY], id);
    this.files.set(path, writeFrontmatter(fm) + stripFrontmatter(text));
  }
}

function readFrontmatter(text: string): Record<string, string | string[]> {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const out: Record<string, string | string[]> = {};
  if (!m) return out;
  let key = "";
  for (const line of m[1].split("\n")) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key) {
      const list = Array.isArray(out[key]) ? (out[key] as string[]) : [];
      out[key] = [...list, item[1]];
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

function writeFrontmatter(fm: Record<string, string | string[]>): string {
  const lines = Object.entries(fm).map(([k, v]) => (Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}` : `${k}: ${v}`));
  return `---\n${lines.join("\n")}\n---\n`;
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function exportText(blocks: Array<{ name: string; id?: string; body: string }>, date = "2026-10-25T17:00:00Z"): string {
  const parts = [`<!-- jot:export v=1 date=${date} -->`, "Stats: n jots", ""];
  for (const b of blocks) {
    parts.push(`<!-- jot:category name=${JSON.stringify(b.name)}${b.id ? ` id="${b.id}"` : ""} -->`, b.body, "<!-- /jot:category -->", "");
  }
  return parts.join("\n");
}

const NAME: ImportSettings = { mode: "name", folder: "Jot", position: "bottom", heading: "" };
const LINKED: ImportSettings = { ...NAME, mode: "linked" };
const INSERT = { position: "bottom" as const, heading: "" };

async function importInto(vault: FakeVault, text: string, settings: ImportSettings, choices = new Map<string, LinkChoice>()) {
  const parsed = parseJotExport(text);
  assert.ok(parsed);
  const plan = planImport(parsed, vault.notes(), settings);
  const outcome = await runImport(resolvePlan(plan, choices), vault, INSERT);
  return { plan, ...outcome };
}

test("name mode: appends to the same-named note in the folder and creates the rest", async () => {
  const vault = new FakeVault({ "Jot/Dev.md": "# Dev\n\n- old\n", "Areas/Jot.md": "elsewhere\n" });
  const text = exportText([
    { name: "DEV", id: DEV, body: "- new dev" },
    { name: "Jot", id: JOT, body: "- new jot" },
  ]);
  const { plan, result, error } = await importInto(vault, text, NAME);
  assert.equal(error, null);
  assert.equal(plan.toLink.length, 0, "name mode never asks");
  assert.equal(vault.files.get("Jot/Dev.md"), "# Dev\n\n- old\n\n- new dev\n");
  assert.equal(vault.files.get("Jot/Jot.md"), "- new jot\n", "a note in another folder isn't used");
  assert.equal(vault.files.get("Areas/Jot.md"), "elsewhere\n");
  assert.deepEqual(result, { notes: ["Dev", "Jot"], created: ["Jot"], linked: [] });
});

test("linked mode, first import: asks once per category, with the same-named note picked", async () => {
  const vault = new FakeVault({ "Areas/Dev.md": "# Dev\n", "Projects/Project Jot.md": "# Jot\n" });
  const parsed = parseJotExport(
    exportText([
      { name: "DEV", id: DEV, body: "- a" },
      { name: "JOT", id: JOT, body: "- b" },
      { name: "Brand New", id: NEWCAT, body: "- c" },
    ]),
  );
  assert.ok(parsed);
  const plan = planImport(parsed, vault.notes(), LINKED);
  assert.deepEqual(
    plan.toLink.map((r) => [r.block.name, r.suggestion.pick?.path ?? null, r.suggestion.others.map((n) => n.path), r.newPath, r.newPathExists]),
    [
      ["DEV", "Areas/Dev.md", [], "Jot/DEV.md", false],
      ["JOT", null, ["Projects/Project Jot.md"], "Jot/JOT.md", false],
      ["Brand New", null, [], "Jot/Brand New.md", false],
    ],
  );
  assert.ok(plan.writes.every((w) => w.path === null), "nothing is written before the answers");
});

test("linked mode: the answers are stamped once, then later imports go straight there", async () => {
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
  const one = await importInto(vault, first, LINKED, choices);
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
  const second = await importInto(vault, exportText([{ name: "Jot (the app)", id: JOT, body: "- d" }], "2026-10-26T09:00:00Z"), LINKED);
  assert.equal(second.plan.toLink.length, 0, "no questions the second time");
  assert.equal(second.error, null);
  assert.ok(vault.files.get("Archive/Jot app.md")?.endsWith("# Jot\n\n- b\n\n- d\n"));
  assert.ok(!vault.files.has("Jot/Jot (the app).md"), "no stray note for the new name");
});

test("linked mode: two categories can share a note, and a note holds both ids", async () => {
  const vault = new FakeVault({ "Inbox.md": "" });
  const text = exportText([
    { name: "A", id: DEV, body: "- a" },
    { name: "B", id: JOT, body: "- b" },
  ]);
  const choices = new Map<string, LinkChoice>([
    [DEV, { kind: "note", path: "Inbox.md" }],
    [JOT, { kind: "note", path: "Inbox.md" }],
  ]);
  const { result } = await importInto(vault, text, LINKED, choices);
  assert.deepEqual(result.notes, ["Inbox"]);
  assert.deepEqual(vault.notes().find((n) => n.path === "Inbox.md")?.linkedIds, [DEV, JOT]);
  assert.ok(vault.files.get("Inbox.md")?.endsWith("- a\n\n- b\n"));
});

test("linked mode: an export without ids (Jot 1.5) goes by name and says so", async () => {
  const vault = new FakeVault({ "Jot/Ideas.md": "" });
  const { plan, result } = await importInto(vault, exportText([{ name: "Ideas", body: "- x" }]), LINKED);
  assert.equal(plan.unlinkable, 1);
  assert.equal(plan.toLink.length, 0);
  assert.deepEqual(result.notes, ["Ideas"]);
});

test("linked mode: the same id in two notes uses the first and reports it", async () => {
  const vault = new FakeVault({
    "B/Ideas.md": `---\n${LINK_PROPERTY}:\n  - ${DEV}\n---\n`,
    "A.md": `---\n${LINK_PROPERTY}: ${DEV}\n---\n`,
  });
  const { plan } = await importInto(vault, exportText([{ name: "Ideas", id: DEV, body: "- x" }]), LINKED);
  assert.deepEqual(plan.ambiguous, ["Ideas"]);
  assert.ok(vault.files.get("A.md")?.endsWith("- x\n"), "a hand-written single id counts too");
});

test("two new categories answered with 'new note' and the same file name share one note", async () => {
  const vault = new FakeVault();
  const text = exportText([
    { name: "Work / Life", id: DEV, body: "- a" },
    { name: "Work - Life", id: JOT, body: "- b" },
  ]);
  const { result, error } = await importInto(vault, text, LINKED);
  assert.equal(error, null);
  assert.deepEqual(result.created, ["Work - Life"]);
  assert.deepEqual(vault.notes()[0].linkedIds, [DEV, JOT]);
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
    NAME,
  );
  assert.deepEqual(error, { path: "Jot/B.md", message: "disk full" });
  assert.deepEqual(result.notes, ["A"]);
  assert.ok(!vault.files.has("Jot/C.md"), "nothing after the failure");
});

test("the export file itself is never a target", async () => {
  const vault = new FakeVault({ "jot-export-ideas.md": "" });
  const parsed = parseJotExport(exportText([{ name: "jot-export-ideas", id: DEV, body: "- x" }]));
  assert.ok(parsed);
  const plan = planImport(parsed, vault.notes(), { ...LINKED, folder: "" }, new Set(["jot-export-ideas.md"]));
  assert.equal(plan.toLink[0].suggestion.pick, null);
});

test("fingerprints are stable, ignore line endings, and differ between exports", () => {
  const a = exportText([{ name: "A", body: "- a" }]);
  assert.equal(fingerprint(a), fingerprint(a.replace(/\n/g, "\r\n")));
  assert.notEqual(fingerprint(a), fingerprint(exportText([{ name: "A", body: "- a" }], "2026-10-26T00:00:00Z")));
});
