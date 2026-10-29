import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaRefs, rewriteMediaRefs, usefulAlt } from "../src/media.ts";

// As ExportBuilder.textWithAttachmentMarkers writes them with media bundled.
const JOT =
  "- 10/28/26, 12:30 PM Café Lisboa ![3F2A.png](media/3F2A.png) ![Map [old].png](media/9B1C.png)\n" +
  "- Packing list [file: media/5D4C.pdf] [video: media/A1B2.mov]\n" +
  "- A link to [media/notes](https://example.com) and ![a photo](https://example.com/x.png) stay";

test("the attachment links Jot writes, once each, in order", () => {
  assert.deepEqual(mediaRefs(JOT), ["media/3F2A.png", "media/9B1C.png", "media/5D4C.pdf", "media/A1B2.mov"]);
  assert.deepEqual(mediaRefs("![x](media/../evil.png) [file: media/a/b.pdf]"), [], "only a file directly in media/");
});

test("links are rewritten to where the files went; markers keep their words; others stay", () => {
  const out = rewriteMediaRefs(JOT, (ref, embed, alt) =>
    ref === "media/A1B2.mov" ? null : `[[${ref.replace("media/", "")}${embed && usefulAlt(alt, ref) ? `|${usefulAlt(alt, ref)}` : ""}]]`,
  );
  assert.equal(
    out,
    "- 10/28/26, 12:30 PM Café Lisboa ![[3F2A.png]] ![[9B1C.png]]\n" +
      "- Packing list [file: [[5D4C.pdf]]] [video: media/A1B2.mov]\n" +
      "- A link to [media/notes](https://example.com) and ![a photo](https://example.com/x.png) stay",
  );
});

test("an image's alt text becomes the link's text only when it says something", () => {
  assert.equal(usefulAlt("3F2A.png", "media/3F2A.png"), undefined, "Jot writes the file name for an unnamed photo");
  assert.equal(usefulAlt("Garden plan.png", "media/3F2A.png"), "Garden plan.png");
  assert.equal(usefulAlt("300", "media/3F2A.png"), undefined, "would be read as a width");
  assert.equal(usefulAlt("300x200", "media/3F2A.png"), undefined);
  assert.equal(usefulAlt("a|b", "media/3F2A.png"), undefined);
});
