import { test } from "node:test";
import assert from "node:assert/strict";
import { insertIntoNote, isJotExport, noteNameFor, parseJotExport } from "../src/format.ts";

const SAMPLE = `<!-- jot:export v=1 date=2026-09-14T10:22:05Z -->
Stats: 3 jots across 2 categories

<!-- jot:category name="Ideas" id="0d4c2a1b-1111-4a2b-9c3d-000000000001" -->
- build the obsidian thing
- rename the workspaces screen
<!-- /jot:category -->


<!-- jot:category name="Say \\"hi\\" --\\u003e now" -->
* 9/14/26 call back
<!-- /jot:category -->
`;

test("parses header, names and bodies; ignores everything outside blocks", () => {
  const parsed = parseJotExport(SAMPLE);
  assert.ok(parsed);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.date, "2026-09-14T10:22:05Z");
  assert.equal(parsed.blocks.length, 2);
  assert.equal(parsed.blocks[0].name, "Ideas");
  assert.equal(parsed.blocks[0].id, "0D4C2A1B-1111-4A2B-9C3D-000000000001", "ids are upper-cased");
  assert.equal(parsed.blocks[0].body, "- build the obsidian thing\n- rename the workspaces screen");
  assert.equal(parsed.blocks[1].name, 'Say "hi" --> now');
  assert.equal(parsed.blocks[1].body, "* 9/14/26 call back");
  assert.equal(parsed.blocks[1].id, null, "a block without an id (Jot 1.5) still parses");
});

test("attributes in any order; unknown ones and malformed ids are ignored", () => {
  const text = [
    "<!-- jot:export v=1 -->",
    '<!-- jot:category id="9A1E0000-0000-4000-8000-00000000000B" color=red name="Work" -->',
    "- a",
    "<!-- /jot:category -->",
    '<!-- jot:category name="Odd" id="not-a-uuid" -->',
    "- b",
    "<!-- /jot:category -->",
    '<!-- jot:category id="9A1E0000-0000-4000-8000-00000000000C" -->',
    "- no name, skipped",
    "<!-- /jot:category -->",
  ].join("\n");
  const parsed = parseJotExport(text);
  assert.ok(parsed);
  assert.deepEqual(
    parsed.blocks.map((b) => [b.name, b.id, b.body]),
    [
      ["Work", "9A1E0000-0000-4000-8000-00000000000B", "- a"],
      ["Odd", null, "- b"],
    ],
  );
});

test("the exact text Jot 1.6 writes", () => {
  // Mirrors ExportBuilderObsidianTests: name first, then id, one space before -->.
  const text =
    "<!-- jot:export v=1 date=2026-10-25T17:00:00Z -->\n" +
    '<!-- jot:category name="Uncategorized" id="00000000-0000-0000-0000-00000000A11E" -->\n' +
    "- loose thought\n" +
    "<!-- /jot:category -->\n";
  const parsed = parseJotExport(text);
  assert.ok(parsed);
  assert.equal(parsed.blocks[0].id, "00000000-0000-0000-0000-00000000A11E");
  assert.equal(parsed.blocks[0].body, "- loose thought");
});

test("rejects non-exports and newer versions", () => {
  assert.equal(parseJotExport("# Just a note\n"), null);
  assert.equal(isJotExport("# Just a note\n"), false);
  assert.equal(parseJotExport("<!-- jot:export v=2 -->\n"), null);
  assert.ok(isJotExport(SAMPLE));
});

test("drops empty blocks", () => {
  const parsed = parseJotExport(`<!-- jot:export v=1 -->\n<!-- jot:category name="Empty" -->\n\n<!-- /jot:category -->\n`);
  assert.ok(parsed);
  assert.deepEqual(parsed.blocks, []);
});

test("note names avoid characters Obsidian refuses", () => {
  assert.equal(noteNameFor("Ideas"), "Ideas");
  assert.equal(noteNameFor("Work / Life"), "Work - Life");
  assert.equal(noteNameFor('Q: "why?" #1 [x]'), "Q- why 1 x");
  assert.equal(noteNameFor("   "), "Untitled");
  assert.equal(noteNameFor("Ending..."), "Ending");
});

const bottom = { position: "bottom" as const, heading: "" };
const top = { position: "top" as const, heading: "" };

test("bottom of an empty or existing note", () => {
  assert.equal(insertIntoNote("", "- a", bottom), "- a\n");
  assert.equal(insertIntoNote("# Ideas\n\n- old\n", "- a\n- b", bottom), "# Ideas\n\n- old\n\n- a\n- b\n");
  assert.equal(insertIntoNote("no trailing newline", "- a", bottom), "no trailing newline\n\n- a\n");
});

test("bottom of a note that is only frontmatter goes right under it", () => {
  assert.equal(insertIntoNote("---\nid: x\n---\n", "- a", bottom), "---\nid: x\n---\n- a\n");
  assert.equal(insertIntoNote("---\nid: x\n---\n\n", "- a", { position: "bottom", heading: "Inbox" }), "---\nid: x\n---\n## Inbox\n\n- a\n");
});

test("top goes after frontmatter", () => {
  assert.equal(insertIntoNote("# Ideas\n\n- old\n", "- a", top), "- a\n\n# Ideas\n\n- old\n");
  assert.equal(
    insertIntoNote("---\ntags: [x]\n---\n\n- old\n", "- a", top),
    "---\ntags: [x]\n---\n- a\n\n- old\n",
  );
  assert.equal(insertIntoNote("---\ntags: [x]\n---\n", "- a", top), "---\ntags: [x]\n---\n- a\n");
});

test("under a heading: end of that section, before the next heading", () => {
  const note = "# Ideas\n\n## Inbox\n\n- old\n\n## Done\n\n- done\n";
  assert.equal(
    insertIntoNote(note, "- a", { position: "bottom", heading: "Inbox" }),
    "# Ideas\n\n## Inbox\n\n- old\n\n- a\n\n## Done\n\n- done\n",
  );
  assert.equal(
    insertIntoNote(note, "- a", { position: "top", heading: "inbox" }),
    "# Ideas\n\n## Inbox\n\n- a\n\n- old\n\n## Done\n\n- done\n",
  );
});

test("under a heading: a deeper sub-heading stays inside the section", () => {
  const note = "## Inbox\n\n- old\n\n### Sub\n\n- sub\n\n## Next\n";
  assert.equal(
    insertIntoNote(note, "- a", { position: "bottom", heading: "Inbox" }),
    "## Inbox\n\n- old\n\n### Sub\n\n- sub\n\n- a\n\n## Next\n",
  );
});

test("missing heading is created at the end, honouring a typed level", () => {
  assert.equal(insertIntoNote("# Ideas\n\n- old\n", "- a", { position: "top", heading: "Inbox" }), "# Ideas\n\n- old\n\n## Inbox\n\n- a\n");
  assert.equal(insertIntoNote("", "- a", { position: "bottom", heading: "### Inbox" }), "### Inbox\n\n- a\n");
});

test("a heading with no blank line after it stays tight", () => {
  assert.equal(insertIntoNote("## Inbox\n- old\n", "- a", { position: "bottom", heading: "Inbox" }), "## Inbox\n- old\n\n- a\n");
  assert.equal(insertIntoNote("## Inbox\n- old\n", "- a", { position: "top", heading: "Inbox" }), "## Inbox\n- a\n\n- old\n");
});

test("headings inside code fences are not matched", () => {
  const note = "```\n## Inbox\n```\n\n- old\n";
  assert.equal(
    insertIntoNote(note, "- a", { position: "bottom", heading: "Inbox" }),
    "```\n## Inbox\n```\n\n- old\n\n## Inbox\n\n- a\n",
  );
});

test("empty section under the heading", () => {
  assert.equal(insertIntoNote("## Inbox\n\n## Next\n", "- a", { position: "bottom", heading: "Inbox" }), "## Inbox\n\n- a\n\n## Next\n");
  assert.equal(insertIntoNote("## Inbox\n## Next\n", "- a", { position: "bottom", heading: "Inbox" }), "## Inbox\n\n- a\n\n## Next\n");
});
