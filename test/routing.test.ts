import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEADING_PROPERTY,
  headingsFrom,
  withHeading,
  cleanFolder,
  compact,
  linkedIdsFrom,
  linkedNotes,
  movedFolder,
  nameTarget,
  type NoteInfo,
  resolveFolder,
  suggestNote,
  withLinkedId,
  withoutLinkedId,
} from "../src/routing.ts";

const A = "0D4C2A1B-1111-4A2B-9C3D-000000000001";
const B = "0D4C2A1B-1111-4A2B-9C3D-000000000002";

function note(path: string, extra: Partial<NoteInfo> = {}): NoteInfo {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  return { path, basename: name, aliases: [], linkedIds: [], ...extra };
}

// The shape of a real vault: hub notes in a folder, project notes elsewhere,
// names that don't match the categories exactly.
const VAULT = [
  note("Areas/Dev.md"),
  note("Areas/Game Dev.md"),
  note("Areas/Art.md"),
  note("Projects/Project Jot.md"),
  note("Blog/Building the Jot app.md"),
  note("Boards/Project Jot Task Board.md"),
  note("Notes/Spanish 101.md"),
  note("Notes/Health.md", { aliases: ["Fitness"] }),
  note("Inbox/Old/dev.md"),
];

test("linked ids: a single value or a list, case-insensitive, deduplicated", () => {
  assert.deepEqual(linkedIdsFrom({ "jot-category-id": A.toLowerCase() }), [A]);
  assert.deepEqual(linkedIdsFrom({ "jot-category-id": [A, B, A, "nope", 7] }), [A, B]);
  assert.deepEqual(linkedIdsFrom({ other: A }), []);
  assert.deepEqual(linkedIdsFrom(null), []);
});

test("adding and removing a link keeps a list and the other ids", () => {
  assert.deepEqual(withLinkedId(undefined, A), [A]);
  assert.deepEqual(withLinkedId(A, B), [A, B], "a hand-written single value becomes a list");
  assert.deepEqual(withLinkedId([A, B], A.toLowerCase()), [A, B]);
  assert.deepEqual(withoutLinkedId([A, B], A), [B]);
  assert.equal(withoutLinkedId([A], A), null, "the last id removes the property");
});

test("name routing: exact path, then same name in a different case in that folder, else create", () => {
  assert.deepEqual(nameTarget(VAULT, "Areas", "Dev"), { path: "Areas/Dev.md", exists: true });
  assert.deepEqual(nameTarget(VAULT, "Areas", "DEV"), { path: "Areas/Dev.md", exists: true });
  assert.deepEqual(nameTarget(VAULT, "", "Dev"), { path: "Dev.md", exists: false }, "other folders don't count");
  assert.deepEqual(nameTarget(VAULT, "Inbox/", "Work / Life"), { path: "Inbox/Work - Life.md", exists: false });
});

test("name routing finds the note whatever the case or Unicode form of the name and folder", () => {
  const vault = [note("Areas/Caf\u00e9.md"), ...VAULT];
  assert.deepEqual(nameTarget(vault, "Areas", "Cafe\u0301"), { path: "Areas/Caf\u00e9.md", exists: true }, "e + accent");
  assert.deepEqual(nameTarget(vault, "Areas", "CAFE\u0301"), { path: "Areas/Caf\u00e9.md", exists: true });
  assert.deepEqual(nameTarget(vault, "areas", "dev"), { path: "Areas/Dev.md", exists: true }, "the folder's case too");
  // Two notes that differ only in case (a case-sensitive disk): always the same one.
  const both = [note("Jot/work.md"), note("Jot/Work.md")];
  assert.equal(nameTarget(both, "Jot", "WORK").path, nameTarget([...both].reverse(), "Jot", "WORK").path);
});

test("the folder setting is spelled the way the vault spells it", () => {
  const folders = ["Jot", "Jot/Inbox", "Areas", "Caf\u00e9"];
  assert.equal(resolveFolder(folders, "jot/inbox"), "Jot/Inbox");
  assert.equal(resolveFolder(folders, "JOT/New"), "Jot/New", "a missing level keeps its spelling, under the real parent");
  assert.equal(resolveFolder(folders, "Cafe\u0301"), "Caf\u00e9");
  assert.equal(resolveFolder(folders, ""), "");
  assert.equal(resolveFolder(folders, "Elsewhere"), "Elsewhere");
});

test("the folder setting follows its folder when it's renamed or moved", () => {
  assert.equal(movedFolder("Jot", "Jot", "Areas/Jot"), "Areas/Jot");
  assert.equal(movedFolder("Jot/Inbox", "Jot", "Notes"), "Notes/Inbox", "a parent moved");
  assert.equal(movedFolder("jot", "Jot", "jot"), "jot", "a case-only rename");
  assert.equal(movedFolder("Jot", "Jo", "X"), null, "a folder whose name only starts the same");
  assert.equal(movedFolder("", "Jot", "X"), null, "the vault root never moves");
});

test("a folder setting with stray spaces or slashes still finds the notes in that folder", () => {
  assert.equal(cleanFolder(" Inbox/Old/ "), "Inbox/Old");
  assert.equal(cleanFolder("/Areas//Sub\\Deep/"), "Areas/Sub/Deep");
  assert.equal(cleanFolder("Inbox\u00A0Two"), "Inbox Two");
  assert.equal(cleanFolder("  "), "");
  assert.deepEqual(nameTarget(VAULT, "Areas ", "Dev"), { path: "Areas/Dev.md", exists: true });
  assert.deepEqual(nameTarget(VAULT, "Inbox//Old", "dev"), { path: "Inbox/Old/dev.md", exists: true });
  assert.equal(suggestNote(VAULT, "DEV", " Inbox/Old ").pick?.path, "Inbox/Old/dev.md", "the chosen folder still wins");
});

test("compact names ignore case, spaces and punctuation", () => {
  assert.equal(compact("Game Dev"), compact("GAMEDEV"));
  assert.equal(compact("SPANISH101"), compact("Spanish 101"));
  assert.equal(compact("Café"), "cafe");
});

test("suggestions: the same-named note anywhere in the vault, preferring the folder", () => {
  assert.equal(suggestNote(VAULT, "DEV", "").pick?.path, "Areas/Dev.md", "shallower path wins a tie");
  assert.equal(suggestNote(VAULT, "DEV", "Inbox/Old").pick?.path, "Inbox/Old/dev.md", "the chosen folder wins first");
  assert.equal(suggestNote(VAULT, "GAME DEV", "").pick?.path, "Areas/Game Dev.md");
  assert.equal(suggestNote(VAULT, "SPANISH101", "").pick?.path, "Notes/Spanish 101.md");
  assert.equal(suggestNote(VAULT, "Fitness", "").pick?.path, "Notes/Health.md", "aliases count as names");
});

test("suggestions: no pick without a same-named note, but notes containing the name are offered", () => {
  const s = suggestNote(VAULT, "JOT", "");
  assert.equal(s.pick, null);
  assert.deepEqual(
    s.others.map((n) => n.basename),
    ["Project Jot", "Building the Jot app", "Project Jot Task Board"],
    "shortest names first, at most three",
  );
  assert.deepEqual(suggestNote(VAULT, "Dev", "").others.map((n) => n.path), ["Inbox/Old/dev.md", "Areas/Game Dev.md"]);
});

test("suggestions skip a same-named note that already belongs to another category, and excluded paths", () => {
  const vault = [note("Ideas.md", { linkedIds: [B] }), note("Notes/Ideas.md")];
  assert.equal(suggestNote(vault, "Ideas", "").pick?.path, "Notes/Ideas.md");
  assert.deepEqual(suggestNote(vault, "Ideas", "").others, [], "a linked note isn't a one-tap choice either");
  assert.equal(suggestNote([note("Ideas.md", { linkedIds: [B] })], "Ideas", "").pick, null);
  assert.equal(suggestNote([note("jot-export-ideas.md")], "jot-export-ideas", "", { exclude: new Set(["jot-export-ideas.md"]) }).pick, null);
});

test("suggestions are deterministic", () => {
  const shuffled = [...VAULT].reverse();
  assert.deepEqual(suggestNote(shuffled, "JOT", ""), suggestNote(VAULT, "JOT", ""));
  assert.deepEqual(suggestNote(shuffled, "DEV", "").pick, suggestNote(VAULT, "DEV", "").pick);
});

test("linked notes: in a stable order, so the first is always the same", () => {
  const vault = [note("z/Deep/Ideas.md", { linkedIds: [A] }), note("Ideas.md", { linkedIds: [A, B] }), note("Other.md")];
  assert.deepEqual(linkedNotes(vault, A).map((n) => n.path), ["Ideas.md", "z/Deep/Ideas.md"]);
  assert.deepEqual(linkedNotes(vault, B.toLowerCase()).map((n) => n.path), ["Ideas.md"]);
});

test("a note's per-category headings: read by id, set, cleared", () => {
  const ID = "0D4C2A1B-1111-4A2B-9C3D-000000000001";
  const OTHER = "0D4C2A1B-1111-4A2B-9C3D-000000000002";
  assert.deepEqual(headingsFrom({ [HEADING_PROPERTY]: { [ID.toLowerCase()]: " Inbox ", [OTHER]: null, junk: "x", n: 3 } }), {
    [ID]: "Inbox",
    [OTHER]: "",
  });
  assert.deepEqual(headingsFrom({ [HEADING_PROPERTY]: ["Inbox"] }), {}, "not a map");
  assert.deepEqual(withHeading(undefined, ID, "### Ideas"), { [ID]: "### Ideas" });
  assert.deepEqual(withHeading({ [ID]: "Inbox", [OTHER]: "Later" }, ID, undefined), { [OTHER]: "Later" });
  assert.equal(withHeading({ [ID]: "Inbox" }, ID, undefined), null, "the last one removes the property");
  assert.deepEqual(withHeading({}, ID, ""), { [ID]: "" }, "the note itself, even when the Heading setting names one");
});
