import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fillMarker,
  headingInputValue,
  headingName,
  headingSettingFor,
  insertIntoNote,
  isJotExport,
  isWholeExport,
  noteNameFor,
  parseJotExport,
} from "../src/format.ts";

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
    '<!-- jot:category name="Later" colorHex="#FF0000" sort_order=2 v2=x -->',
    "- c",
    "<!-- /jot:category -->",
  ].join("\n");
  const parsed = parseJotExport(text);
  assert.ok(parsed);
  assert.equal(parsed.problem, null);
  assert.deepEqual(
    parsed.blocks.map((b) => [b.name, b.id, b.body]),
    [
      ["Work", "9A1E0000-0000-4000-8000-00000000000B", "- a"],
      ["Odd", null, "- b"],
      ["Later", null, "- c"],
    ],
    "an attribute a later Jot adds, in any spelling, doesn't hide its category",
  );
});

test("a category's workspace, escaped like its name, and none when the marker doesn't say", () => {
  const text = [
    "<!-- jot:export v=1 date=2026-11-02T09:00:00Z -->",
    '<!-- jot:category name="Inbox" id="0D4C2A1B-1111-4A2B-9C3D-000000000001" workspace="Work" -->',
    "- call back about the lease",
    "<!-- /jot:category -->",
    '<!-- jot:category name="Inbox" id="0D4C2A1B-1111-4A2B-9C3D-000000000002" workspace="June \\"&\\" Me \\u003e Home" -->',
    "- seeds for the garden",
    "<!-- /jot:category -->",
    '<!-- jot:category name="Ideas" id="0D4C2A1B-1111-4A2B-9C3D-000000000003" -->',
    "- a reading nook",
    "<!-- /jot:category -->",
    '<!-- jot:category name="Gifts" workspace="" -->',
    "- a good umbrella",
    "<!-- /jot:category -->",
  ].join("\n");
  const parsed = parseJotExport(text);
  assert.equal(parsed?.problem, null);
  assert.deepEqual(parsed?.blocks.map((b) => [b.name, b.workspace]), [
    ["Inbox", "Work"],
    ["Inbox", 'June "&" Me > Home'],
    ["Ideas", null],
    ["Gifts", null],
  ]);
});

test("the header reads attributes in any order and ignores unknown ones", () => {
  const block = '<!-- jot:category name="A" -->\n- a\n<!-- /jot:category -->\n';
  for (const header of [
    "<!-- jot:export v=1 date=2026-10-27T10:00:00Z count=3 -->",
    "<!-- jot:export date=2026-10-27T10:00:00Z v=1 -->",
    '<!-- jot:export app="Jot 1.7" v=1 -->',
  ]) {
    assert.ok(isJotExport(header + "\n" + block), header);
    assert.equal(parseJotExport(header + "\n" + block)?.blocks[0].body, "- a", header);
  }
  assert.equal(parseJotExport("<!-- jot:export date=2026-10-27T10:00:00Z v=1 -->\n" + block)?.date, "2026-10-27T10:00:00Z");
  assert.equal(isJotExport("<!-- jot:export date=2026-10-27T10:00:00Z -->\n" + block), false, "no version, no export");
});

test("markers that don't pair up are a problem, never a silent loss", () => {
  const head = "<!-- jot:export v=1 -->\n";
  const cases: Array<[string, string]> = [
    // A jot that mentions the end marker would end its category early.
    ['<!-- jot:category name="Dev" -->\n- the end marker is <!-- /jot:category --> ok\n- second\n<!-- /jot:category -->\n', "pair up"],
    // A jot that mentions an opening marker.
    ['<!-- jot:category name="Dev" -->\n- write <!-- jot:category name="X" --> here\n<!-- /jot:category -->\n', "pair up"],
    // A file cut short: the last category never ends.
    ['<!-- jot:category name="A" -->\n- a\n<!-- /jot:category -->\n<!-- jot:category name="B" -->\n- b\n', "cut short"],
    // A marker this plugin can't read at all.
    ["<!-- jot:category -->\n- a\n<!-- /jot:category -->\n", "pair up"],
    // A category with jots but no name.
    ['<!-- jot:category id="9A1E0000-0000-4000-8000-00000000000C" -->\n- no name\n<!-- /jot:category -->\n', "no name"],
    ['<!-- jot:category name="Bad \\q escape" -->\n- bad name\n<!-- /jot:category -->\n', "no name"],
  ];
  for (const [body, words] of cases) {
    const parsed = parseJotExport(head + body);
    assert.ok(parsed);
    assert.ok(parsed.problem?.includes(words), `${JSON.stringify(body)} → ${parsed.problem}`);
  }
  assert.equal(parseJotExport(SAMPLE)?.problem, null);
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

test("only a file that is the export alone counts as one to trash", () => {
  assert.ok(isWholeExport(SAMPLE), "header, stats, blocks");
  assert.ok(isWholeExport("\n\n" + SAMPLE + "\n\n"), "blank lines around it");
  // Jot's Copy pasted at the top of a note that already had text.
  assert.equal(isWholeExport(SAMPLE + "\n## My own notes\n\n- keep me\n"), false);
  // ... or pasted below it.
  assert.equal(isWholeExport("# Daily note\n\n" + SAMPLE), false);
  assert.equal(isWholeExport("<!-- jot:export v=1 -->\n"), false, "no categories at all");
});

test("text typed between blocks keeps the file; what Jot writes there doesn't", () => {
  const block = (name: string) => `<!-- jot:category name="${name}" -->\n- ${name.toLowerCase()} jot\n<!-- /jot:category -->`;
  const head = "<!-- jot:export v=1 date=2026-10-29T09:00:00Z -->\nStats: 3 jots across 3 categories\n\n";
  // "Separate workspaces": each workspace's name above its blocks, as a heading or in capitals.
  assert.ok(isWholeExport(`${head}## Work\n\n${block("Dev")}\n\n\n## Home\n\n${block("Garden")}\n\n\n${block("Uncategorized")}\n`));
  assert.ok(isWholeExport(`${head}WORK\n\n${block("Dev")}\n\n\nHOME\n\n${block("Garden")}\n`));
  assert.ok(isWholeExport(`${head}${block("Dev")}\r\n\r\n${block("Garden")}\r\n`), "CRLF");
  assert.equal(isWholeExport(`${head}${block("Dev")}\n\nmy own notes on the garden\n\n${block("Garden")}\n`), false);
  assert.equal(isWholeExport(`${head}${block("Dev")}\n\n## Work\nmy notes\n\n${block("Garden")}\n`), false, "a heading and more");
  assert.equal(isWholeExport(`${head}${block("Dev")}\n\nStats: 1 jot\n\n${block("Garden")}\n`), false, "Stats only at the top");
});

test("only spaces and tabs are space inside a marker", () => {
  const head = "<!-- jot:export v=1 -->\n";
  // Jot escapes "<!--" before whitespace and "jot:", but not before U+FEFF, which JavaScript's \s matches.
  const bom = parseJotExport(`${head}<!-- jot:category name="Dev" -->\n- see <!--\uFEFFjot:category name="X" --> here\n<!-- /jot:category -->\n`);
  assert.equal(bom?.problem, null);
  assert.equal(bom?.blocks[0].body, '- see <!--\uFEFFjot:category name="X" --> here');
  const tabs = parseJotExport(`<!--\tjot:export\tv=1\t-->\n<!--\tjot:category\tname="Dev"\t-->\n- a\n<!--\t/jot:category\t-->\n`);
  assert.deepEqual(tabs?.blocks.map((b) => b.name), ["Dev"]);
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
  assert.equal(noteNameFor("   "), "Unnamed category");
  assert.equal(noteNameFor("Ending..."), "Ending");
});

test("note names are never hidden, reserved, too long or in a second Unicode form", () => {
  // Obsidian never shows or indexes a file whose name starts with a dot.
  assert.equal(noteNameFor(".NET"), "NET");
  assert.equal(noteNameFor("... later"), "later");
  assert.equal(noteNameFor(".."), "Dot dot");
  // Windows refuses these names, with or without an extension.
  assert.equal(noteNameFor("Con"), "Con_");
  assert.equal(noteNameFor("aux.notes"), "aux_.notes");
  assert.equal(noteNameFor("Console"), "Console");
  // File names stop at 255 bytes; keep well clear, by bytes, not characters.
  const long = noteNameFor("é".repeat(300));
  assert.ok(new TextEncoder().encode(long).length <= 200, `${long.length} chars`);
  assert.ok(!noteNameFor("word ".repeat(60)).endsWith(" "));
  // "é" typed as e + accent names the same note as "é".
  assert.equal(noteNameFor("Cafe\u0301"), "Caf\u00e9");
  // Control characters are dropped; tabs and line breaks become spaces.
  assert.equal(noteNameFor("Ideas\u0007\u0000 for\tJune\n"), "Ideas for June");
  assert.equal(noteNameFor("\u0001\u001f"), "Unnamed category");
});

test("a name of symbols only gets its own readable note, never Untitled", () => {
  // Each would clean to nothing; all of them used to share Obsidian's own "Untitled.md".
  const names = ["?", "*", "#", "**", "...", "<>", "|", "[^]", '"'];
  const notes = names.map(noteNameFor);
  assert.deepEqual(notes, [
    "Question mark",
    "Asterisk",
    "Hash",
    "Asterisk asterisk",
    "Dot dot dot",
    "Less than greater than",
    "Vertical bar",
    "Left bracket caret right bracket",
    "Quote",
  ]);
  assert.equal(new Set(notes.map((n) => n.toLowerCase())).size, names.length, "one note each");
  assert.deepEqual(names.map(noteNameFor), notes, "the same every time");
  assert.ok(!notes.includes("Untitled"));
  assert.equal(noteNameFor("? ?"), "Question mark question mark", "spaces between symbols are dropped");
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
  assert.equal(insertIntoNote("- old\n", "- a", top), "- a\n\n- old\n");
  assert.equal(
    insertIntoNote("---\ntags: [x]\n---\n\n- old\n", "- a", top),
    "---\ntags: [x]\n---\n- a\n\n- old\n",
  );
  assert.equal(insertIntoNote("---\ntags: [x]\n---\n", "- a", top), "---\ntags: [x]\n---\n- a\n");
});

test("top with no heading is the very top of the note, # Title or not", () => {
  // Pick the title as the heading to put jots under it.
  assert.equal(insertIntoNote("---\ntags: [x]\n---\n# Ideas\n\n- old\n", "- a", top), "---\ntags: [x]\n---\n- a\n\n# Ideas\n\n- old\n");
  assert.equal(insertIntoNote("# Ideas\n\n- old\n", "- a", top), "- a\n\n# Ideas\n\n- old\n");
  assert.equal(insertIntoNote("\n\n# Ideas\n- old\n", "- a", top), "- a\n\n# Ideas\n- old\n");
  assert.equal(insertIntoNote("# Ideas", "- a", top), "- a\n\n# Ideas\n");
  assert.equal(insertIntoNote("## Inbox\n\n- old\n", "- a", top), "- a\n\n## Inbox\n\n- old\n");
  assert.equal(insertIntoNote("#tag\n- old\n", "- a", top), "- a\n\n#tag\n- old\n");
  assert.equal(insertIntoNote("```\n# not a title\n```\n", "- a", top), "- a\n\n```\n# not a title\n```\n");
  // Under a chosen heading: right under that heading, a # Title too.
  assert.equal(
    insertIntoNote("# Ideas\n\n## Inbox\n\n- old\n", "- a", { position: "top", heading: "Inbox" }),
    "# Ideas\n\n## Inbox\n\n- a\n\n- old\n",
  );
  assert.equal(insertIntoNote("# Ideas\n\n- old\n", "- a", { position: "top", heading: "Ideas" }), "# Ideas\n\n- a\n\n- old\n");
});

test("top never splits a jot from the text under its # heading", () => {
  const off = { ...top, startMarker: "", endMarker: "" };
  assert.equal(
    insertIntoNote("# Lisbon\nPastéis at Manteigaria\n", "Book the train", off),
    "Book the train\n\n# Lisbon\nPastéis at Manteigaria\n",
  );
  // Jot's timestamp prefix "# " with group by date: each day's jots start with a # heading.
  const day1 = "# Oct 28, 2026\n- gift for the neighbours\n\n- lamp for the hall";
  const day2 = "# Oct 29, 2026\n- noodle place on Elm";
  let note = insertIntoNote("", day1, top);
  note = insertIntoNote(note, day2, top);
  assert.equal(note, `${day2}\n\n${day1}\n`, "day 2 above day 1, each day with its own jots");
  assert.equal(insertIntoNote(note, "- loose idea", top), `- loose idea\n\n${day2}\n\n${day1}\n`);
  assert.equal(insertIntoNote(`---\nid: x\n---\n${day1}\n`, day2, top), `---\nid: x\n---\n${day2}\n\n${day1}\n`, "under properties");
  // With start and end lines, each import stays whole too.
  const day1Marked = { ...top, startMarker: "*Jots imported October 28, 2026*", endMarker: "---" };
  const props = "---\njot-category-id:\n  - 0D4C2A1B-1111-4A2B-9C3D-000000000001\n---\n";
  let marked = insertIntoNote(props, "# Trip\nLisbon, Porto", day1Marked);
  marked = insertIntoNote(marked, "- lamp", { ...day1Marked, startMarker: "*Jots imported October 29, 2026*" });
  assert.equal(
    marked,
    `${props}*Jots imported October 29, 2026*\n\n- lamp\n\n---\n\n*Jots imported October 28, 2026*\n\n# Trip\nLisbon, Porto\n\n---\n`,
  );
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

test("under a heading with no blank line after it, the jots still get the blank lines asked for", () => {
  assert.equal(insertIntoNote("## Inbox\n- old\n", "- a", { position: "bottom", heading: "Inbox" }), "## Inbox\n- old\n\n- a\n");
  assert.equal(insertIntoNote("## Inbox\n- old\n", "- a", { position: "top", heading: "Inbox" }), "## Inbox\n\n- a\n\n- old\n");
  assert.equal(insertIntoNote("## Inbox\n- old\n", "- a", { position: "top", heading: "Inbox", blankLinesBefore: 0 }), "## Inbox\n- a\n\n- old\n");
});

test("headings inside code fences are not matched", () => {
  const note = "```\n## Inbox\n```\n\n- old\n";
  assert.equal(
    insertIntoNote(note, "- a", { position: "bottom", heading: "Inbox" }),
    "```\n## Inbox\n```\n\n- old\n\n## Inbox\n\n- a\n",
  );
});

test("a heading-like line in the properties is not the heading", () => {
  // A YAML comment that reads like the heading must not pull jots into the properties.
  const note = "---\n# Inbox\ntags: x\n---\n# Inbox\n- old\n";
  assert.equal(insertIntoNote(note, "- a", { position: "top", heading: "Inbox" }), "---\n# Inbox\ntags: x\n---\n# Inbox\n\n- a\n\n- old\n");
  assert.equal(
    insertIntoNote("---\n# Inbox\n---\nbody\n", "- a", { position: "bottom", heading: "Inbox" }),
    "---\n# Inbox\n---\nbody\n\n## Inbox\n\n- a\n",
    "only there: the heading is added",
  );
});

test("a code fence closes only on its own kind of fence", () => {
  // ~~~ inside a ``` block is code, so the "heading" after it is too.
  const note = "## Inbox\n- old\n```\ncode\n~~~\n## Not a heading\n```\n## Next\n";
  assert.equal(
    insertIntoNote(note, "- a", { position: "bottom", heading: "Inbox" }),
    "## Inbox\n- old\n```\ncode\n~~~\n## Not a heading\n```\n\n- a\n\n## Next\n",
  );
  assert.equal(
    insertIntoNote("````\n```\n## Inbox\n````\n", "- a", { position: "bottom", heading: "Inbox" }),
    "````\n```\n## Inbox\n````\n\n## Inbox\n\n- a\n",
    "a shorter fence doesn't close a longer one",
  );
});

test("a jot that leaves a code fence open gets it closed", () => {
  const note = "## Inbox\n- old\n\n## Next\n- next\n";
  const under = { position: "bottom" as const, heading: "Inbox" };
  const once = insertIntoNote(note, "- look:\n```\ncode", under);
  assert.equal(once, "## Inbox\n- old\n\n- look:\n```\ncode\n```\n\n## Next\n- next\n", "the rest of the note isn't code");
  // The next import still finds where the section ends.
  assert.equal(insertIntoNote(once, "- b", under), "## Inbox\n- old\n\n- look:\n```\ncode\n```\n\n- b\n\n## Next\n- next\n");
  // Closed with what opened it: the same characters, at least as many, and the same indent (inside a list item).
  assert.equal(insertIntoNote("", "- a\n  ~~~~\n  x", bottom), "- a\n  ~~~~\n  x\n  ~~~~\n");
  assert.equal(insertIntoNote("", "````\n```\nx", bottom), "````\n```\nx\n````\n");
  assert.equal(insertIntoNote("", "```\nx\n```", bottom), "```\nx\n```\n", "a closed fence is left alone");
  assert.equal(insertIntoNote("", "```inline` code", bottom), "```inline` code\n", "inline code isn't a fence");
});

test("properties are what Obsidian reads as properties", () => {
  // Obsidian closes properties only on a line that is exactly ---; "..." or "--- " don't.
  assert.equal(insertIntoNote("---\nnot properties\n...\nmore\n", "- a", top), "- a\n\n---\nnot properties\n...\nmore\n");
  assert.equal(insertIntoNote("---\nnot: this\n---  \nmore\n", "- a", top), "- a\n\n---\nnot: this\n---  \nmore\n");
  assert.equal(insertIntoNote("---\n---\nbody\n", "- a", top), "---\n---\n- a\n\nbody\n", "empty properties");
});

test("a note with Windows line endings keeps them", () => {
  assert.equal(insertIntoNote("# Ideas\r\n\r\n- old\r\n", "- a\n- b", top), "- a\r\n- b\r\n\r\n# Ideas\r\n\r\n- old\r\n");
  assert.equal(
    insertIntoNote("---\r\ntags: x\r\n---\r\n## Inbox\r\n- old\r\n", "- a", { position: "bottom", heading: "Inbox" }),
    "---\r\ntags: x\r\n---\r\n## Inbox\r\n- old\r\n\r\n- a\r\n",
  );
  assert.equal(insertIntoNote("- old\n", "- a\r\n- b", top), "- a\n- b\n\n- old\n", "jots take the note's endings");
});

test("a note starting with a byte-order mark keeps its properties on top", () => {
  // Some editors start a file with U+FEFF, and Obsidian hands it over as is.
  const note = "\uFEFF---\ntags: x\n---\n- old\n";
  assert.equal(insertIntoNote(note, "- a", top), "---\ntags: x\n---\n- a\n\n- old\n");
  assert.equal(insertIntoNote(note, "- a", bottom), "---\ntags: x\n---\n- old\n\n- a\n");
  assert.equal(insertIntoNote("\uFEFF---\ntags: x\n---\n", "- a", bottom), "---\ntags: x\n---\n- a\n", "only properties");
  assert.equal(
    insertIntoNote("\uFEFF---\n# Inbox\n---\n# Inbox\n- old\n", "- a", { position: "top", heading: "Inbox" }),
    "---\n# Inbox\n---\n# Inbox\n\n- a\n\n- old\n",
    "the heading is looked for below the properties",
  );
});

test("empty section under the heading", () => {
  assert.equal(insertIntoNote("## Inbox\n\n## Next\n", "- a", { position: "bottom", heading: "Inbox" }), "## Inbox\n\n- a\n\n## Next\n");
  assert.equal(insertIntoNote("## Inbox\n## Next\n", "- a", { position: "bottom", heading: "Inbox" }), "## Inbox\n\n- a\n\n## Next\n");
});

test("a picked heading whose text starts with # is that heading, not a level marker", () => {
  // Obsidian's heading text for "## #1 picks" is "#1 picks"; the dialog's suggester offers it as is.
  const note = "# Books\n\n## #1 picks\n- The Overstory\n\n## Later\n- x\n";
  const headings = [
    { heading: "Books", level: 1 },
    { heading: "#1 picks", level: 2 },
    { heading: "Later", level: 2 },
  ];
  const picked = headingSettingFor("#1 picks", headings);
  assert.deepEqual(picked, { setting: "## #1 picks", name: "#1 picks", existing: true });
  assert.equal(headingName(picked.setting), "#1 picks");
  assert.equal(
    insertIntoNote(note, "- Piranesi", { position: "top", heading: picked.setting }),
    "# Books\n\n## #1 picks\n\n- Piranesi\n\n- The Overstory\n\n## Later\n- x\n",
  );
  assert.equal(
    insertIntoNote(note, "- Piranesi", { position: "bottom", heading: picked.setting }),
    "# Books\n\n## #1 picks\n- The Overstory\n\n- Piranesi\n\n## Later\n- x\n",
  );
  // A tag-like heading, in any case, at any level.
  const tag = headingSettingFor("#Gifts", [{ heading: "#gifts", level: 3 }]);
  assert.deepEqual(tag, { setting: "### #gifts", name: "#gifts", existing: true });
  assert.equal(insertIntoNote("### #gifts\n- scarf\n", "- lamp", { position: "top", heading: tag.setting }), "### #gifts\n\n- lamp\n\n- scarf\n");
  // The saved setting shows in the dialog as it is, so opening it again picks the same heading.
  assert.equal(headingInputValue(picked.setting), "## #1 picks");
  assert.deepEqual(headingSettingFor(headingInputValue(picked.setting), headings), { setting: "## #1 picks", name: "#1 picks", existing: true });
});

test("a typed heading: an existing one by its text, a new one with the level typed in front", () => {
  const headings = [{ heading: "Inbox", level: 2 }];
  assert.deepEqual(headingSettingFor("inbox", headings), { setting: "inbox", name: "inbox", existing: true });
  assert.deepEqual(headingSettingFor("### Inbox", headings), { setting: "### Inbox", name: "Inbox", existing: true });
  assert.deepEqual(headingSettingFor("### Places", headings), { setting: "### Places", name: "Places", existing: false });
  assert.deepEqual(headingSettingFor("  ", headings), { setting: "", name: "", existing: false });
  // Not a heading the note has: a leading # still sets the level, as before.
  assert.deepEqual(headingSettingFor("#1 picks", []), { setting: "#1 picks", name: "1 picks", existing: false });
  assert.equal(headingInputValue("### Inbox"), "Inbox");
  assert.equal(headingInputValue("Inbox"), "Inbox");
  assert.equal(headingInputValue(""), "");
});

test("setext headings, which Obsidian indexes, are found and end a section", () => {
  const note = "Inbox\n=====\n\n- old\n\nOther\n=====\n- y\n";
  assert.equal(
    insertIntoNote(note, "- new", { position: "top", heading: "Inbox" }),
    "Inbox\n=====\n\n- new\n\n- old\n\nOther\n=====\n- y\n",
    "under the heading's underline, not a second ## Inbox at the end",
  );
  assert.equal(
    insertIntoNote(note, "- new", { position: "bottom", heading: "Inbox" }),
    "Inbox\n=====\n\n- old\n\n- new\n\nOther\n=====\n- y\n",
    "the next setext heading of its level ends the section",
  );
  assert.equal(
    insertIntoNote("Inbox\n-----\n- old\n\nOther\n-----\n- y\n", "- new", { position: "bottom", heading: "Inbox" }),
    "Inbox\n-----\n- old\n\n- new\n\nOther\n-----\n- y\n",
    "level 2, with dashes",
  );
  assert.equal(
    insertIntoNote("## Inbox\n- old\n\nDone\n----\n- y\n", "- new", { position: "bottom", heading: "Inbox" }),
    "## Inbox\n- old\n\n- new\n\nDone\n----\n- y\n",
    "an ATX section ends at a setext heading of its level",
  );
  assert.equal(
    insertIntoNote("# Ideas\n\nGifts\n---\n- scarf\n\n# Places\n", "- new", { position: "bottom", heading: "Ideas" }),
    "# Ideas\n\nGifts\n---\n- scarf\n\n- new\n\n# Places\n",
    "a deeper setext heading stays inside",
  );
  assert.equal(
    insertIntoNote("---\ntags: x\n---\nInbox\n===\n- old\n", "- new", { position: "top", heading: "Inbox" }),
    "---\ntags: x\n---\nInbox\n===\n\n- new\n\n- old\n",
    "right below the properties",
  );
});

test("lines that only look like setext headings are left alone", () => {
  const under = { position: "bottom" as const, heading: "Inbox" };
  // A list item over --- is a list and a rule; a line in a list item, a quote or a table isn't a heading of the note.
  assert.equal(insertIntoNote("## Inbox\n- old\n\n- item\n---\n- y\n", "- new", under), "## Inbox\n- old\n\n- item\n---\n- y\n\n- new\n");
  assert.equal(insertIntoNote("## Inbox\n- old\nlazy line\n---\n", "- new", under), "## Inbox\n- old\nlazy line\n---\n\n- new\n");
  assert.equal(insertIntoNote("- a\n\n  Inbox\n  =====\n", "- new", under), "- a\n\n  Inbox\n  =====\n\n## Inbox\n\n- new\n");
  assert.equal(insertIntoNote("> Inbox\n> ===\n", "- new", under), "> Inbox\n> ===\n\n## Inbox\n\n- new\n");
  assert.equal(insertIntoNote("a | b\n---\n", "- new", { position: "bottom", heading: "a | b" }), "a | b\n---\n\n## a | b\n\n- new\n");
  assert.equal(insertIntoNote("```\nInbox\n=====\n```\n", "- new", under), "```\nInbox\n=====\n```\n\n## Inbox\n\n- new\n");
  assert.equal(insertIntoNote("---\nInbox: x\n---\nbody\n", "- new", under), "---\nInbox: x\n---\nbody\n\n## Inbox\n\n- new\n", "the properties' closing line");
  // Obsidian's parser wants the underline alone on its line: indented or with trailing spaces, it's no heading.
  assert.equal(insertIntoNote("Inbox\n  =====\n", "- new", under), "Inbox\n  =====\n\n## Inbox\n\n- new\n");
  assert.equal(insertIntoNote("Inbox\n-----  \n- old\n", "- new", under), "Inbox\n-----  \n- old\n\n## Inbox\n\n- new\n");
});

test("a missing heading goes at the top of the note when asked, right after the properties", () => {
  const opts = { position: "top" as const, heading: "Inbox", newHeading: "top" as const };
  assert.equal(insertIntoNote("# Ideas\n\n- old\n", "- a", opts), "## Inbox\n\n- a\n\n# Ideas\n\n- old\n");
  assert.equal(insertIntoNote("- old\n", "- a", opts), "## Inbox\n\n- a\n\n- old\n");
  assert.equal(insertIntoNote("---\ntags: x\n---\n- old\n", "- a", opts), "---\ntags: x\n---\n## Inbox\n\n- a\n\n- old\n");
  assert.equal(insertIntoNote("- old\n", "- a", { ...opts, newHeading: "bottom" }), "- old\n\n## Inbox\n\n- a\n", "bottom, the default");
});

test("the blank lines before and after the jots are the ones asked for", () => {
  const spaced = { blankLinesBefore: 2, blankLinesAfter: 0 };
  assert.equal(insertIntoNote("- old\n", "- a", { ...top, ...spaced }), "- a\n- old\n", "at the top, nothing is above");
  assert.equal(insertIntoNote("- old\n", "- a", { ...bottom, ...spaced }), "- old\n\n\n- a\n");
  assert.equal(insertIntoNote("", "- a", { ...top, ...spaced }), "- a\n", "nothing above or below: no blank lines");
  const inbox = "## Inbox\n\n- old\n\n## Later\n";
  assert.equal(insertIntoNote(inbox, "- a", { position: "top", heading: "Inbox", ...spaced }), "## Inbox\n\n\n- a\n- old\n\n## Later\n");
  assert.equal(
    insertIntoNote(inbox, "- a", { position: "bottom", heading: "Inbox", blankLinesBefore: 0, blankLinesAfter: 3 }),
    "## Inbox\n\n- old\n- a\n\n\n\n## Later\n",
  );
});

test("start and end lines go around the jots, a blank line away from them", () => {
  const marked = { ...top, startMarker: "*Jots imported October 29, 2026*", endMarker: "---" };
  assert.equal(
    insertIntoNote("# Ideas\n\n- old\n", "- a", marked),
    "*Jots imported October 29, 2026*\n\n- a\n\n---\n\n# Ideas\n\n- old\n",
  );
  assert.equal(insertIntoNote("", "plain text", { ...bottom, endMarker: "---" }), "plain text\n\n---\n", "a --- right under text would make it a heading");
  assert.equal(insertIntoNote("", "- a", { ...bottom, startMarker: "  ", endMarker: "" }), "- a\n", "blank lines mean none");
  assert.equal(insertIntoNote("", "", marked), "", "no jots, no lines");
});

test("a start line of --- never turns the note's top into properties", () => {
  const ruled = { ...top, startMarker: "---", endMarker: "---" };
  assert.equal(insertIntoNote("- old\n", "- a", ruled), "\n---\n\n- a\n\n---\n\n- old\n");
  assert.equal(insertIntoNote("---\ntags: x\n---\n", "- a", ruled), "---\ntags: x\n---\n---\n\n- a\n\n---\n", "under real properties it's a rule");
});

test("start and end lines fill in the import's date and time", () => {
  const format = (kind: "date" | "time", pattern: string | null) => `${kind}(${pattern ?? "default"})`;
  assert.equal(fillMarker("*Jots imported {{date}}*", format), "*Jots imported date(default)*");
  assert.equal(fillMarker("{{ DATE:YYYY-MM-DD }} at {{time}}", format), "date(YYYY-MM-DD) at time(default)");
  assert.equal(fillMarker("one\ntwo ", format), "one two");
  assert.equal(fillMarker("---", format), "---");
});
