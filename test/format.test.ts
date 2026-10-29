import { test } from "node:test";
import assert from "node:assert/strict";
import {
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

test("top goes below the note's title, a # Title that comes first", () => {
  // Frontmatter and a title: under both.
  assert.equal(
    insertIntoNote("---\ntags: [x]\n---\n# Ideas\n\n- old\n", "- a", top),
    "---\ntags: [x]\n---\n# Ideas\n\n- a\n\n- old\n",
  );
  // A title only, with blank lines around it or none.
  assert.equal(insertIntoNote("# Ideas\n\n- old\n", "- a", top), "# Ideas\n\n- a\n\n- old\n");
  assert.equal(insertIntoNote("\n\n# Ideas\n- old\n", "- a", top), "# Ideas\n\n- a\n\n- old\n");
  assert.equal(insertIntoNote("# Ideas\n", "- a", top), "# Ideas\n\n- a\n");
  assert.equal(insertIntoNote("# Ideas", "- a", top), "# Ideas\n\n- a\n");
  // No title: the very top, above a first heading that isn't one.
  assert.equal(insertIntoNote("## Inbox\n\n- old\n", "- a", top), "- a\n\n## Inbox\n\n- old\n");
  assert.equal(insertIntoNote("#tag\n- old\n", "- a", top), "- a\n\n#tag\n- old\n", "a tag, not a heading");
  assert.equal(insertIntoNote("```\n# not a title\n```\n", "- a", top), "- a\n\n```\n# not a title\n```\n");
  // A title that isn't the first thing in the note: the very top.
  assert.equal(insertIntoNote("Some intro\n\n# Ideas\n\n- old\n", "- a", top), "- a\n\nSome intro\n\n# Ideas\n\n- old\n");
  assert.equal(
    insertIntoNote("---\ntags: [x]\n---\n- old\n\n# Ideas\n", "- a", top),
    "---\ntags: [x]\n---\n- a\n\n- old\n\n# Ideas\n",
  );
  // Under a chosen heading, nothing changes: right under that heading.
  assert.equal(
    insertIntoNote("# Ideas\n\n## Inbox\n\n- old\n", "- a", { position: "top", heading: "Inbox" }),
    "# Ideas\n\n## Inbox\n\n- a\n\n- old\n",
  );
  assert.equal(insertIntoNote("# Ideas\n\n- old\n", "- a", { position: "top", heading: "Ideas" }), "# Ideas\n\n- a\n\n- old\n");
});

test("top never puts earlier jots under a heading the jots wrote", () => {
  // Jot's timestamp prefix "# " with group by date: each day's jots start with a # heading.
  const day1 = "# Oct 28, 2026\n- gift for the neighbours\n\n- lamp for the hall";
  const day2 = "# Oct 29, 2026\n- noodle place on Elm";
  const day3 = "# Oct 30, 2026\n- book: The Overstory";
  let note = insertIntoNote("", day1, top, "Ideas");
  note = insertIntoNote(note, day2, top, "Ideas");
  assert.equal(note, `${day2}\n\n${day1}\n`, "day 2 above day 1, each day with its own jots");
  note = insertIntoNote(note, day3, top, "Ideas");
  assert.equal(note, `${day3}\n\n${day2}\n\n${day1}\n`);
  // Without the note's name, the same.
  assert.equal(insertIntoNote(insertIntoNote("", day1, top), day2, top), `${day2}\n\n${day1}\n`);
  // Under properties, the same.
  assert.equal(insertIntoNote(`---\nid: x\n---\n${day1}\n`, day2, top, "Ideas"), `---\nid: x\n---\n${day2}\n\n${day1}\n`);
  // A note an import with headings filled, then an import without them (the export settings changed).
  assert.equal(
    insertIntoNote(`${day2}\n\n${day1}\n`, "- loose idea", top, "Ideas"),
    `- loose idea\n\n${day2}\n\n${day1}\n`,
    "two # headings: neither is a title",
  );
  // A jot's own text with a # heading, and no prefix: the next import goes above it, not into it.
  assert.equal(insertIntoNote("", "# Trip\nLisbon, Porto", top), "# Trip\nLisbon, Porto\n");
  assert.equal(insertIntoNote("# Trip\nLisbon, Porto\n", "# Gifts\nscarf", top), "# Gifts\nscarf\n\n# Trip\nLisbon, Porto\n");
});

test("top keeps a # Title with the note's name first, even when the jots have # headings", () => {
  const day = "# Oct 29, 2026\n- noodle place on Elm";
  assert.equal(
    insertIntoNote("# Ideas\n\n# Oct 28, 2026\n- lamp\n", day, top, "Ideas"),
    `# Ideas\n\n${day}\n\n# Oct 28, 2026\n- lamp\n`,
  );
  assert.equal(insertIntoNote("# ideas\n", day, top, "Ideas"), `# ideas\n\n${day}\n`, "in any case");
  assert.equal(insertIntoNote("# Work / Life\n- old\n", day, top, "Work - Life"), `# Work / Life\n\n${day}\n\n- old\n`, "or as its note name");
  // A title with another text is kept only while it's the only # heading around.
  assert.equal(insertIntoNote("# Gift list\n\n- scarf\n", "- lamp", top, "Gifts"), "# Gift list\n\n- lamp\n\n- scarf\n");
  assert.equal(insertIntoNote("# Gift list\n\n- scarf\n", day, top, "Gifts"), `${day}\n\n# Gift list\n\n- scarf\n`);
  // A # heading inside code doesn't count.
  assert.equal(insertIntoNote("# Ideas\n\n```\n# not a heading\n```\n", "- a", top), "# Ideas\n\n- a\n\n```\n# not a heading\n```\n");
  assert.equal(insertIntoNote("# Ideas\n", "- a\n```\n# not a heading\n```", top), "# Ideas\n\n- a\n```\n# not a heading\n```\n");
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

test("a heading-like line in the properties is not the heading", () => {
  // A YAML comment that reads like the heading must not pull jots into the properties.
  const note = "---\n# Inbox\ntags: x\n---\n# Inbox\n- old\n";
  assert.equal(insertIntoNote(note, "- a", { position: "top", heading: "Inbox" }), "---\n# Inbox\ntags: x\n---\n# Inbox\n- a\n\n- old\n");
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

test("a note starting with a byte-order mark keeps its properties on top", () => {
  // Some editors start a file with U+FEFF, and Obsidian hands it over as is.
  const note = "\uFEFF---\ntags: x\n---\n- old\n";
  assert.equal(insertIntoNote(note, "- a", top), "---\ntags: x\n---\n- a\n\n- old\n");
  assert.equal(insertIntoNote(note, "- a", bottom), "---\ntags: x\n---\n- old\n\n- a\n");
  assert.equal(insertIntoNote("\uFEFF---\ntags: x\n---\n", "- a", bottom), "---\ntags: x\n---\n- a\n", "only properties");
  assert.equal(
    insertIntoNote("\uFEFF---\n# Inbox\n---\n# Inbox\n- old\n", "- a", { position: "top", heading: "Inbox" }),
    "---\n# Inbox\n---\n# Inbox\n- a\n\n- old\n",
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
    "# Books\n\n## #1 picks\n- Piranesi\n\n- The Overstory\n\n## Later\n- x\n",
  );
  assert.equal(
    insertIntoNote(note, "- Piranesi", { position: "bottom", heading: picked.setting }),
    "# Books\n\n## #1 picks\n- The Overstory\n\n- Piranesi\n\n## Later\n- x\n",
  );
  // A tag-like heading, in any case, at any level.
  const tag = headingSettingFor("#Gifts", [{ heading: "#gifts", level: 3 }]);
  assert.deepEqual(tag, { setting: "### #gifts", name: "#gifts", existing: true });
  assert.equal(insertIntoNote("### #gifts\n- scarf\n", "- lamp", { position: "top", heading: tag.setting }), "### #gifts\n- lamp\n\n- scarf\n");
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
    "---\ntags: x\n---\nInbox\n===\n- new\n\n- old\n",
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
