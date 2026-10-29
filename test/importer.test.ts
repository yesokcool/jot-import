import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS } from "../src/data.ts";
import { parseJotExport } from "../src/format.ts";
import { openZipExport } from "../src/zip-export.ts";
import {
  exportToOffer,
  fingerprint,
  type ImportRecord,
  type ImportSettings,
  type LinkChoice,
  mergeHistories,
  OfferedExports,
  OfferNotice,
  planImport,
  priorImport,
  recordImport,
  resolvePlan,
  runImport,
  stoppedText,
  summaryText,
  type VaultPort,
} from "../src/importer.ts";
import { HEADING_PROPERTY, headingsFrom, LINK_PROPERTY, linkedIdsFrom, type NoteInfo, withHeading, withLinkedId } from "../src/routing.ts";

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

  async saveAttachment(name: string, data: Uint8Array, notePath: string) {
    const folder = notePath.includes("/") ? `${notePath.slice(0, notePath.lastIndexOf("/"))}/attachments` : "attachments";
    const dot = name.lastIndexOf(".");
    let path = `${folder}/${name}`;
    for (let n = 1; this.exists(path); n++) path = `${folder}/${name.slice(0, dot)} ${n}${name.slice(dot)}`;
    const plain = `${folder}/${name}`;
    const existing = this.binaries.get(plain);
    if (path !== plain && existing && existing.length === data.length && existing.every((b, i) => b === data[i])) {
      return { path: plain, created: false };
    }
    this.binaries.set(path, data);
    return { path, created: true };
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

  async process(path: string, fn: (data: string) => string) {
    if (path === this.failOn) throw new Error("disk full");
    const text = this.files.get(path);
    if (text === undefined) throw new Error("the note is missing");
    this.files.set(path, fn(text));
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
  assert.deepEqual(result, { notes: ["Dev", "Jot"], created: ["Jot"], linked: [], attachments: 0 });
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

test("linked mode: linking a note that starts with a byte-order mark adds no second properties block", async () => {
  // Obsidian's property editing doesn't see properties behind the mark (the fake vault's doesn't either).
  const vault = new FakeVault({ "Areas/Dev.md": "\uFEFF---\nstatus: active\n---\n# Dev\n" });
  const text = exportText([{ name: "Dev", id: DEV, body: "- a" }]);
  const { error } = await importInto(vault, text, { ...LINKED, position: "top" }, new Map([[DEV, { kind: "note", path: "Areas/Dev.md" }]]));
  assert.equal(error, null);
  assert.equal(vault.files.get("Areas/Dev.md"), `---\nstatus: active\n${LINK_PROPERTY}:\n  - ${DEV}\n---\n# Dev\n\n- a\n`);
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

test("categories whose names differ only in case share one note instead of colliding", async () => {
  const vault = new FakeVault();
  const text = exportText([
    { name: "Work", body: "- w1" },
    { name: "work", body: "- w2" },
  ]);
  const { result, error } = await importInto(vault, text, NAME);
  assert.equal(error, null);
  assert.deepEqual([...vault.files.keys()], ["Jot/Work.md"]);
  assert.equal(vault.files.get("Jot/Work.md"), "- w1\n\n- w2\n");
  assert.deepEqual(result.created, ["Work"]);

  // Linked mode, both answered "New note".
  const linked = new FakeVault();
  const two = exportText([
    { name: "Ideas", id: DEV, body: "- a" },
    { name: "IDEAS", id: JOT, body: "- b" },
  ]);
  const outcome = await importInto(linked, two, LINKED);
  assert.equal(outcome.error, null);
  assert.deepEqual(outcome.plan.toLink.map((r) => r.newPath), ["Jot/Ideas.md", "Jot/Ideas.md"]);
  assert.deepEqual(linked.notes().map((n) => [n.path, n.linkedIds]), [["Jot/Ideas.md", [DEV, JOT]]]);
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

test("a stopped import picks up where it stopped, so a retry adds nothing twice", async () => {
  const vault = new FakeVault({ "Jot/A.md": "", "Jot/B.md": "" });
  vault.failOn = "Jot/B.md";
  const text = exportText([
    { name: "A", body: "- a" },
    { name: "B", body: "- b" },
    { name: "C", body: "- c" },
  ]);
  const print = fingerprint(text);
  const parsed = parseJotExport(text);
  assert.ok(parsed);

  // What the plugin does with each attempt: skip what an earlier one wrote, then record this one.
  let history: ImportRecord[] = [];
  const attempt = async (at: number) => {
    const prior = priorImport(history, print);
    const skip = prior.kind === "stopped" ? prior.written : 0;
    const plan = planImport({ ...parsed, blocks: parsed.blocks.slice(skip) }, vault.notes(), NAME);
    const outcome = await runImport(resolvePlan(plan, new Map()), vault, INSERT);
    const record = { fingerprint: print, importedAt: at, notes: outcome.result.notes.length };
    history = recordImport(history, outcome.error ? { ...record, stoppedAfter: skip + outcome.written } : record, 100);
    return outcome;
  };

  const first = await attempt(1);
  assert.equal(first.written, 1);
  assert.deepEqual(priorImport(history, print), { kind: "stopped", written: 1 }, "a stopped import isn't 'already imported'");

  vault.failOn = null; // the user fixes whatever stopped it
  const second = await attempt(2);
  assert.equal(second.error, null);
  assert.equal(vault.files.get("Jot/A.md"), "- a\n", "not added twice");
  assert.equal(vault.files.get("Jot/B.md"), "- b\n");
  assert.equal(vault.files.get("Jot/C.md"), "- c\n");
  assert.deepEqual(priorImport(history, print), { kind: "done", at: 2 });
  assert.equal(history.length, 1, "one record per export");
});

test("an import cut off midway (Obsidian quit or killed) resumes after the blocks it wrote", async () => {
  const vault = new FakeVault({ "Jot/A.md": "", "Jot/B.md": "", "Jot/C.md": "" });
  const text = exportText([
    { name: "A", body: "- a" },
    { name: "B", body: "- b" },
    { name: "C", body: "- c" },
  ]);
  const print = fingerprint(text);
  const parsed = parseJotExport(text);
  assert.ok(parsed);

  // What the plugin saves: a record before the first write, then the
  // progress after each block. Nothing after the loop runs when the app dies.
  let history: ImportRecord[] = [];
  const save = (stoppedAfter: number) => {
    history = recordImport(history, { fingerprint: print, importedAt: 1, notes: 0, stoppedAfter }, 100);
  };
  const attempt = async () => {
    const prior = priorImport(history, print);
    const skip = prior.kind === "stopped" ? prior.written : 0;
    const plan = planImport({ ...parsed, blocks: parsed.blocks.slice(skip) }, vault.notes(), NAME);
    save(skip);
    return runImport(resolvePlan(plan, new Map()), vault, INSERT, async (written) => save(skip + written));
  };

  vault.failOn = "Jot/C.md"; // the app is killed while it writes C
  await attempt();
  assert.deepEqual(priorImport(history, print), { kind: "stopped", written: 2 });

  vault.failOn = null;
  const retry = await attempt();
  assert.equal(retry.error, null);
  assert.equal(vault.files.get("Jot/A.md"), "- a\n", "not added twice");
  assert.equal(vault.files.get("Jot/B.md"), "- b\n", "not added twice");
  assert.equal(vault.files.get("Jot/C.md"), "- c\n");
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
  const plan = planImport(parsed, vault.notes(), { ...LINKED, folder: "" }, new Set(["jot-export-ideas.md"]));
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
  const { plan, result, error } = await importInto(vault, text, { ...NAME, folder: "" }, new Map(), new Set(["Ideas.md"]));
  assert.equal(error, null);
  assert.equal(vault.files.get("Ideas.md"), note, "the export's note is untouched");
  assert.equal(vault.files.get("Ideas 1.md"), "- idea\n");
  assert.equal(vault.files.get("Work.md"), "- work\n");
  assert.deepEqual(result.created, ["Ideas 1"]);
  assert.deepEqual(plan.besideExport, [{ name: "Ideas", path: "Ideas 1.md", exportPath: "Ideas.md" }]);
  assert.ok(summaryText(result, 0, [], 0, plan.besideExport).includes("The Ideas jots went to Ideas 1 because this export is in Ideas."));

  // Another case or Unicode form is the same file on disk; a taken number is skipped.
  const loose = new FakeVault({ "ideas.md": text, "Ideas 1.md": "mine\n" });
  const two = await importInto(loose, text, { ...NAME, folder: "" }, new Map(), new Set(["ideas.md"]));
  assert.equal(two.error, null);
  assert.equal(loose.files.get("ideas.md"), text);
  assert.equal(loose.files.get("Ideas 1.md"), "mine\n");
  assert.equal(loose.files.get("Ideas 2.md"), "- idea\n");

  // Linked mode: "New note" is never the export either.
  const linked = new FakeVault({ "Jot/Ideas.md": text });
  const withId = exportText([{ name: "Ideas", id: DEV, body: "- idea" }]);
  const three = await importInto(linked, withId, LINKED, new Map([[DEV, { kind: "new" }]]), new Set(["Jot/Ideas.md"]));
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
  assert.deepEqual(read, [], "a vault of old exports reads nothing");

  read.length = 0;
  const notExports = await exportToOffer(files, NOW, limits, async (f) => (read.push(f.name), null), () => false);
  assert.equal(notExports, null);
  assert.equal(read.length, 3, "files that turn out not to be exports: the recent ones are read, still no old one");
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
  const stopped = stoppedText({ path: "Jot/work.md", message: "File already exists." }, { notes: ["Work"], created: [], linked: [], attachments: 0 });
  assert.ok(stopped.startsWith("Jot Import stopped at Jot/work.md: File already exists. Already added to: Work."), stopped);
  assert.ok(!stopped.includes(".."), stopped);

  const many = Array.from({ length: 25 }, (_, i) => `Note ${i + 1}`);
  const summary = summaryText({ notes: many, created: many, linked: [], attachments: 0 }, 0, [], 0);
  assert.ok(summary.startsWith("Jot: added to 25 notes: Note 1, Note 2,"), summary);
  assert.ok(summary.includes("and 15 more"), summary);
  assert.ok(!summary.includes("Note 25"), summary);
  assert.equal(summaryText({ notes: ["Ideas"], created: [], linked: [], attachments: 0 }, 0, [], 0), "Jot: added to 1 note: Ideas.");
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
  const settings: ImportSettings = { ...DEFAULT_SETTINGS, mode: "name" };
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

test("top with jots that bring their own # headings: each day keeps its jots, a # Title stays first", async () => {
  // Jot's timestamp prefix "# " with group by date.
  const monday = exportText([{ name: "Ideas", body: "# Oct 27, 2026\n- lamp for the hall\n\n- scarf" }], "2026-10-27T20:00:00Z");
  const tuesday = exportText([{ name: "Ideas", body: "# Oct 28, 2026\n- noodle place on Elm" }], "2026-10-28T20:00:00Z");
  const settings: ImportSettings = { ...DEFAULT_SETTINGS, mode: "name" };

  const created = new FakeVault();
  await importWith(created, monday, settings);
  await importWith(created, tuesday, settings);
  assert.equal(created.files.get("Ideas.md"), "# Oct 28, 2026\n- noodle place on Elm\n\n# Oct 27, 2026\n- lamp for the hall\n\n- scarf\n");

  // The note's own title, by its name, stays first.
  const titled = new FakeVault({ "Ideas.md": "# Ideas\n" });
  await importWith(titled, monday, settings);
  await importWith(titled, tuesday, settings);
  assert.equal(
    titled.files.get("Ideas.md"),
    "# Ideas\n\n# Oct 28, 2026\n- noodle place on Elm\n\n# Oct 27, 2026\n- lamp for the hall\n\n- scarf\n",
  );
});

test("a category's own heading: chosen once, kept in the note, used by every later import", async () => {
  const vault = new FakeVault({ "Areas/Dev.md": "# Dev\n\n## Inbox\n\n- old\n\n## Archive\n" });
  const settings: ImportSettings = { ...LINKED, position: "top", heading: "" };
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
  const { error } = await importWith(vault, exportText([{ name: "Books", id: DEV, body: "- Piranesi" }]), { ...LINKED, position: "top" });
  assert.equal(error, null);
  assert.ok(vault.files.get("Books.md")?.endsWith("---\n## #1 picks\n- Piranesi\n\n- The Overstory\n\n## Later\n"), vault.files.get("Books.md"));
});

test("a category's heading overrides the Heading setting; no entry follows it", async () => {
  const vault = new FakeVault({ "Dev.md": "## Inbox\n", "Ideas.md": "## Inbox\n" });
  const settings: ImportSettings = { ...LINKED, folder: "", position: "top", heading: "Inbox" };
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
  const { error } = await importWith(vault, text, LINKED, choices);
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
  const settings: ImportSettings = { ...DEFAULT_SETTINGS, mode: "name", folder: "Travel" };
  const one = await importWith(vault, zip.text, settings, new Map(), media);
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
  assert.equal(summaryText(one.result, 0, [], 0), "Jot: added to 2 notes: Places, Gifts. Created Gifts. Saved 4 attachments.");

  // "Import again": the same files are already there, so no copies.
  const two = await importWith(vault, zip.text, settings, new Map(), media);
  assert.equal(two.result.attachments, 0);
  assert.equal(vault.binaries.size, 4);

  // The same name with other bytes is a different file: saved beside it under a new name.
  vault.binaries.set("Travel/attachments/3F2A9C41-6B7D-4E8F-9A0B-1C2D3E4F5A6B.png", new Uint8Array([1]));
  const three = await importWith(vault, zip.text, settings, new Map(), media);
  assert.equal(three.result.attachments, 1);
  assert.ok(vault.binaries.has("Travel/attachments/3F2A9C41-6B7D-4E8F-9A0B-1C2D3E4F5A6B 1.png"));
});

test("the .md alone (unzipped by hand, no media) still imports, links as Jot wrote them", async () => {
  const zip = await openZipExport(new Uint8Array(readFileSync(new URL("./fixtures/jot-export-2026-10-28-1540.zip", import.meta.url))));
  const vault = new FakeVault();
  const { error, result } = await importWith(vault, zip.text, { ...DEFAULT_SETTINGS, mode: "name" });
  assert.equal(error, null);
  assert.equal(result.attachments, 0);
  assert.ok(vault.files.get("Places.md")?.includes("](media/3F2A9C41-6B7D-4E8F-9A0B-1C2D3E4F5A6B.png)"));
});
