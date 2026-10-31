import { test } from "node:test";
import assert from "node:assert/strict";
import { dataToSave, DEFAULT_SETTINGS, isSettingKey, mergeState, readSaved, setSetting } from "../src/data.ts";

test("saved data: defaults for what's missing, and nothing else is lost", () => {
  assert.deepEqual(readSaved(null), { settings: DEFAULT_SETTINGS, state: { history: [], categoryNames: {} }, chosen: [] });
  const record = { fingerprint: "abc", importedAt: 1, notes: 2 };
  const { settings, state, chosen } = readSaved({ position: "bottom", history: [record], categoryNames: { A: "Ideas" } });
  assert.equal(settings.position, "bottom");
  assert.equal(settings.heading, "");
  assert.deepEqual(state, { history: [record], categoryNames: { A: "Ideas" } });
  assert.deepEqual(chosen, ["position"]);
});

test("a new install puts jots at the top", () => {
  // Jot exports newest first, so "top" keeps a note newest first across imports.
  assert.equal(DEFAULT_SETTINGS.position, "top");
  assert.equal(DEFAULT_SETTINGS.heading, "");
  assert.equal(readSaved(null).settings.position, "top");
});

test("a new heading goes at the bottom; each import gets a dated start line and a divider", () => {
  const { settings } = readSaved(null);
  assert.equal(settings.newHeadingPosition, "bottom");
  assert.equal(settings.startMarker, "*Jots imported {{date}}*");
  assert.equal(settings.endMarker, "---");
  assert.equal(settings.blankLinesBefore, 1);
  assert.equal(settings.blankLinesAfter, 1);
  assert.equal(readSaved({ startMarker: "", endMarker: "" }).settings.startMarker, "", "cleared stays cleared");
  assert.equal(readSaved({ blankLinesBefore: "2", blankLinesAfter: 9 }).settings.blankLinesBefore, 2);
  assert.equal(readSaved({ blankLinesAfter: 9 }).settings.blankLinesAfter, 3, "at most 3");
  assert.equal(readSaved({ blankLinesAfter: "x" }).settings.blankLinesAfter, 1);
  assert.equal(settings.collapseLinked, false, "already linked categories show in the dialog");
});

test("new notes go in a Jots folder", () => {
  assert.equal(DEFAULT_SETTINGS.folder, "Jots");
  assert.equal(readSaved(null).settings.folder, "Jots");
  assert.equal(readSaved({ folder: "Notes" }).settings.folder, "Notes");
  assert.equal(readSaved({ folder: "" }).settings.folder, "", "the vault root, when chosen");
});

test("a saved routing mode from an earlier version is ignored, and not saved back", () => {
  // Same-named notes are gone: the next import asks, each category starting on its same-named note.
  const { settings, chosen, state } = readSaved({ mode: "name", folder: "", history: [], categoryNames: {} });
  assert.equal("mode" in settings, false);
  assert.deepEqual(chosen, ["folder"]);
  assert.deepEqual(dataToSave(settings, chosen, state), { folder: "", history: [], categoryNames: {} });
});

test("new exports are watched for in the Jots folder only, and only once that's turned on", () => {
  assert.equal(DEFAULT_SETTINGS.offerNewExports, false, "reads only the file you pick until turned on");
  assert.equal(DEFAULT_SETTINGS.exportsFolder, "Jots");
  assert.equal(readSaved({ exportsFolder: " Jot//Exports/ " }).settings.exportsFolder, "Jot/Exports");
  assert.equal(readSaved({ exportsFolder: "" }).settings.exportsFolder, "", "the whole vault, when chosen");
});

test("a 1.0 vault keeps the position it saved", () => {
  // 1.0 saved every setting with its first import, chosen or not; its notes were filled that way.
  const saved = {
    folder: "Jot",
    position: "bottom",
    heading: "",
    trashAfterImport: true,
    offerNewExports: true,
    history: [{ fingerprint: "abc", importedAt: 1, notes: 2 }],
    categoryNames: {},
  };
  const { settings, chosen, state } = readSaved(saved);
  assert.equal(settings.position, "bottom");
  assert.deepEqual(dataToSave(settings, chosen, state), saved, "saved back as it was");
});

test("only settings the user chose are saved, so the others follow the defaults", () => {
  const state = { history: [{ fingerprint: "abc", importedAt: 1, notes: 2 }], categoryNames: { A: "Ideas" } };
  // A new install imports without opening the settings: no setting is pinned to today's default.
  const first = readSaved(null);
  assert.deepEqual(dataToSave(first.settings, first.chosen, state), state);
  // Then the user picks a heading: that one is saved, the rest still aren't.
  const settings = { ...first.settings, heading: "Inbox" };
  const saved = dataToSave(settings, ["heading"], state);
  assert.deepEqual(saved, { heading: "Inbox", ...state });
  const again = readSaved(saved);
  assert.deepEqual(again.chosen, ["heading"]);
  assert.equal(again.settings.heading, "Inbox");
  assert.equal(again.settings.position, "top");
});

test("a folder saved with stray spaces or slashes (by 1.0.0) is cleaned when loaded", () => {
  // 1.0.0 saved the setting as typed; "Inbox " never matched the "Inbox" folder.
  assert.equal(readSaved({ folder: "Inbox " }).settings.folder, "Inbox");
  assert.equal(readSaved({ folder: " Jot//Inbox/ " }).settings.folder, "Jot/Inbox");
  assert.equal(readSaved({ folder: 42 }).settings.folder, DEFAULT_SETTINGS.folder, "not a folder at all");
});

test("another device's saved data merges with this one's instead of replacing it", () => {
  const theirs = {
    history: [{ fingerprint: "phone", importedAt: 20, notes: 1 }],
    categoryNames: { A: "Ideas (renamed)", B: "Work" },
  };
  const ours = {
    history: [{ fingerprint: "laptop", importedAt: 10, notes: 2 }],
    categoryNames: { A: "Ideas", C: "Home" },
  };
  const merged = mergeState(theirs, ours);
  assert.deepEqual(merged.state.history.map((r) => r.fingerprint), ["phone", "laptop"]);
  assert.deepEqual(merged.state.categoryNames, { A: "Ideas (renamed)", B: "Work", C: "Home" }, "theirs is newer");
  assert.equal(merged.news, true, "this device adds to theirs, so it saves back for the other one");

  // The other device gets the merged data: nothing new for it, so it doesn't save back (no ping-pong).
  assert.equal(mergeState(merged.state, theirs).news, false);
  assert.equal(mergeState(merged.state, merged.state).news, false, "its own save, read back");
  assert.equal(mergeState(theirs, { history: [], categoryNames: {} }).news, false);
});

test("a saved value of the wrong type or not an option is the default, and isn't saved back", () => {
  const { settings, chosen, state } = readSaved({
    heading: null,
    position: 3,
    trashAfterImport: "yes",
    shortenPaths: "left",
    startMarker: ["*Jots*"],
    endMarker: "",
    blankLinesBefore: "",
    history: [{ fingerprint: "ok", importedAt: 1, notes: 2 }, null, { fingerprint: 7 }, { fingerprint: "x", importedAt: "now", notes: 1 }],
    categoryNames: { A: "Ideas", B: 42 },
  });
  assert.equal(settings.heading, "", "a null heading made every import throw");
  assert.equal(settings.position, "top");
  assert.equal(settings.trashAfterImport, true);
  assert.equal(settings.shortenPaths, "middle");
  assert.equal(settings.startMarker, DEFAULT_SETTINGS.startMarker);
  assert.equal(settings.endMarker, "", "an empty line is a valid choice");
  assert.equal(settings.blankLinesBefore, 1);
  assert.deepEqual(chosen, ["endMarker"]);
  assert.deepEqual(state.history, [{ fingerprint: "ok", importedAt: 1, notes: 2 }]);
  assert.deepEqual(state.categoryNames, { A: "Ideas" });
  assert.deepEqual(readSaved([1, 2]).settings, DEFAULT_SETTINGS);
});

test("a setting changed in the settings tab is checked and cleaned the same way", () => {
  const settings = { ...DEFAULT_SETTINGS };
  assert.ok(setSetting(settings, "blankLinesAfter", "2"));
  assert.equal(settings.blankLinesAfter, 2, "the dropdown's option is a string");
  assert.ok(setSetting(settings, "folder", " Notes//Jot/ "));
  assert.equal(settings.folder, "Notes/Jot");
  assert.ok(!setSetting(settings, "position", "middle"));
  assert.equal(settings.position, "top", "left as it was");
  assert.ok(isSettingKey("heading"));
  assert.ok(!isSettingKey("history"));
  assert.ok(!isSettingKey("mode"), "no longer a setting");
});

test("each category's workspace is kept beside its name, and only once a category has one", () => {
  assert.equal("categoryWorkspaces" in readSaved({ categoryNames: { A: "Inbox" } }).state, false);
  const { state } = readSaved({ categoryNames: { A: "Inbox" }, categoryWorkspaces: { A: "Work", B: 7 } });
  assert.deepEqual(state.categoryWorkspaces, { A: "Work" });
  assert.deepEqual(dataToSave(DEFAULT_SETTINGS, [], state), { history: [], categoryNames: { A: "Inbox" }, categoryWorkspaces: { A: "Work" } });
  const merged = mergeState({ history: [], categoryNames: {}, categoryWorkspaces: { B: "Home" } }, state);
  assert.deepEqual(merged.state.categoryWorkspaces, { A: "Work", B: "Home" });
  assert.equal(merged.news, true, "this device knows a workspace the other doesn't");
  assert.equal(mergeState(merged.state, merged.state).news, false);
});
