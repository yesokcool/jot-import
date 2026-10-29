import { test } from "node:test";
import assert from "node:assert/strict";
import { dataToSave, DEFAULT_SETTINGS, mergeState, readSaved } from "../src/data.ts";

test("saved data: defaults for what's missing, and nothing else is lost", () => {
  assert.deepEqual(readSaved(null), { settings: DEFAULT_SETTINGS, state: { history: [], categoryNames: {} }, chosen: [] });
  const record = { fingerprint: "abc", importedAt: 1, notes: 2 };
  const { settings, state, chosen } = readSaved({ mode: "name", history: [record], categoryNames: { A: "Ideas" } });
  assert.equal(settings.mode, "name");
  assert.equal(settings.position, "top");
  assert.deepEqual(state, { history: [record], categoryNames: { A: "Ideas" } });
  assert.deepEqual(chosen, ["mode"]);
});

test("a new install sends jots to a note you choose, at the top", () => {
  // Jot exports newest first, so "top" keeps a note newest first across imports.
  assert.equal(DEFAULT_SETTINGS.mode, "linked");
  assert.equal(DEFAULT_SETTINGS.position, "top");
  assert.equal(DEFAULT_SETTINGS.heading, "");
  const fresh = readSaved(null);
  assert.equal(fresh.settings.mode, "linked");
  assert.equal(fresh.settings.position, "top");
});

test("a 1.0 vault keeps the routing and position it saved", () => {
  // 1.0 saved every setting with its first import, chosen or not; its notes were filled that way.
  const saved = {
    mode: "name",
    folder: "Jot",
    position: "bottom",
    heading: "",
    trashAfterImport: true,
    offerNewExports: true,
    history: [{ fingerprint: "abc", importedAt: 1, notes: 2 }],
    categoryNames: {},
  };
  const { settings, chosen, state } = readSaved(saved);
  assert.equal(settings.mode, "name");
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
  assert.equal(again.settings.mode, "linked");
});

test("a folder saved with stray spaces or slashes (by 1.0.0) is cleaned when loaded", () => {
  // 1.0.0 saved the setting as typed; "Inbox " never matched the "Inbox" folder.
  assert.equal(readSaved({ folder: "Inbox " }).settings.folder, "Inbox");
  assert.equal(readSaved({ folder: " Jot//Inbox/ " }).settings.folder, "Jot/Inbox");
  assert.equal(readSaved({ folder: 42 }).settings.folder, "", "not a folder at all");
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
