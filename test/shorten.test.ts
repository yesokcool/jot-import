import { test } from "node:test";
import assert from "node:assert/strict";
import { middleCut } from "../src/shorten.ts";

/** A ruler where every character is one unit wide. */
const within = (width: number) => (text: string) => Array.from(text).length <= width;

test("a path that fits is left alone", () => {
  assert.equal(middleCut("Brainstorm/Ideas.md", within(40)), "Brainstorm/Ideas.md");
});

test("the folders give way first, keeping the note's name", () => {
  assert.equal(middleCut("Work/2026/Clients/Weekly notes.md", within(23)), "Work/2…/Weekly notes.md");
  assert.equal(middleCut("Work/2026/Clients/Weekly notes.md", within(17)), "…/Weekly notes.md");
});

test("when even …/name doesn't fit, the name loses its middle", () => {
  assert.equal(middleCut("Work/2026/Weekly notes.md", within(9)), "Week…s.md");
  assert.equal(middleCut("Weekly notes.md", within(9)), "Week…s.md");
  assert.equal(middleCut("Weekly notes.md", within(0)), "…");
});

test("an emoji in a folder name is never split", () => {
  assert.equal(middleCut("🌱 Garden/Seeds.md", within(11)), "🌱…/Seeds.md");
});
