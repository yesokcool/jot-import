import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseJotExport } from "../src/format.ts";
import {
  isSafeEntryName,
  looksLikeZip,
  MOBILE_ZIP_LIMITS,
  readZipDirectory,
  readZipEntry,
  wholeBuffer,
  ZIP_LIMITS,
  ZipError,
} from "../src/zip.ts";
import { openZipExport } from "../src/zip-export.ts";
import { buildZip } from "./zip-builder.ts";

/**
 * Real zips, made the way Jot makes them: `make-exports.py` lays out the
 * folder like `ExportFile.materialize` (`<stem>/<stem>.md` and
 * `<stem>/media/<id>.<ext>`), and `zip-folder.swift` zips it with
 * NSFileCoordinator's `.forUploading`, as `ZipBuilder` does. Every entry is
 * deflated, with its sizes in the central directory only (a data
 * descriptor), and names are UTF-8 without the UTF-8 flag.
 */
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const ALL = fixture("jot-export-2026-10-28-1540.zip");
const SCOPED = fixture("jot-export-Idées-2026-10-29-0910.zip");
const PHOTO = "media/3F2A9C41-6B7D-4E8F-9A0B-1C2D3E4F5A6B.png";

test("a real Jot zip: the folder, the export inside it, and its media", async () => {
  assert.ok(looksLikeZip(ALL));
  const entries = readZipDirectory(ALL);
  assert.deepEqual(
    entries.map((e) => e.name).sort(),
    [
      "jot-export-2026-10-28-1540/jot-export-2026-10-28-1540.md",
      "jot-export-2026-10-28-1540/media/3F2A9C41-6B7D-4E8F-9A0B-1C2D3E4F5A6B.png",
      "jot-export-2026-10-28-1540/media/5D4C3B2A-1908-4F7E-A6D5-C4B3A2918070.pdf",
      "jot-export-2026-10-28-1540/media/8E7D6C5B-4A39-4281-B7C6-D5E4F3A2B1C0.png",
      "jot-export-2026-10-28-1540/media/A1B2C3D4-E5F6-4789-8ABC-DEF012345678.mov",
    ],
  );
  assert.ok(entries.every((e) => e.method === 8), "Apple deflates every entry");

  const zip = await openZipExport(ALL);
  assert.equal(zip.textPath, "jot-export-2026-10-28-1540/jot-export-2026-10-28-1540.md");
  const parsed = parseJotExport(zip.text);
  assert.deepEqual(parsed?.blocks.map((b) => b.name), ["Places", "Gifts"]);
  assert.equal(parsed?.problem, null);
  assert.deepEqual([...zip.media.keys()], [
    PHOTO,
    "media/8E7D6C5B-4A39-4281-B7C6-D5E4F3A2B1C0.png",
    "media/5D4C3B2A-1908-4F7E-A6D5-C4B3A2918070.pdf",
    "media/A1B2C3D4-E5F6-4789-8ABC-DEF012345678.mov",
  ]);
  assert.ok(zip.onlyExport);

  const photo = await zip.read(zip.media.get(PHOTO)!);
  assert.deepEqual([...photo.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "a PNG");
  assert.equal(photo.length, zip.media.get(PHOTO)!.size);
});

test("a scoped export's zip: a non-ASCII name, decomposed by macOS in the folder, still pairs with its media", async () => {
  const names = readZipDirectory(SCOPED).map((e) => e.name);
  assert.ok(names.every((n) => n.startsWith("jot-export-Idées-2026-10-29-0910/")), "read as UTF-8 and composed (NFC)");
  const zip = await openZipExport(SCOPED);
  assert.deepEqual(parseJotExport(zip.text)?.blocks.map((b) => b.name), ["Ideas"]);
  assert.deepEqual([...zip.media.keys()], ["media/0C1D2E3F-4A5B-4C6D-8E7F-901A2B3C4D5E.png"]);
});

// ---- Zips built here, for what Jot never writes.

const EXPORT = [
  "<!-- jot:export v=1 date=2026-10-28T19:40:12Z -->",
  "",
  '<!-- jot:category name="Gifts" id="C47E9A10-2F3B-4C5D-8E6F-7A8B9C0D1E2F" -->',
  "- A wool scarf ![scarf.png](media/AAAA.png)",
  "<!-- /jot:category -->",
].join("\n");

async function rejects(zip: Uint8Array, message: RegExp) {
  await assert.rejects(openZipExport(zip), (e: unknown) => e instanceof ZipError && message.test(e.message));
}

test("a zip without an Obsidian Format export says which kind of zip it is", async () => {
  await rejects(buildZip([{ name: "jot-data.json", data: "{}" }, { name: "media/AAAA.png", data: "png" }]), /All My Data export/);
  await rejects(buildZip([{ name: "Work Jots/Work Jots.txt", data: "Work\n- a\n" }]), /no Obsidian Format markers/);
  await rejects(buildZip([{ name: "jot-export-2026-10-30-2200/jot-export-2026-10-30-2200.md", data: "# Work\n- a\n" }]), /no Obsidian Format markers/);
  await rejects(buildZip([{ name: "photo.png", data: "png" }]), /no Jot export in the zip/);
});

test("stored entries, ZIP64 sizes and Finder's metadata files are read", async () => {
  const zip = buildZip([
    { name: "__MACOSX/export/._export.md", data: "mac metadata" },
    { name: "export/export.md", data: EXPORT, stored: true },
    { name: "export/media/AAAA.png", data: new Uint8Array([1, 2, 3, 4, 5]), zip64: true },
    { name: "export/notes.txt", data: "not part of the export" },
  ]);
  const opened = await openZipExport(zip);
  assert.equal(opened.text, EXPORT);
  assert.deepEqual([...(await opened.read(opened.media.get("media/AAAA.png")!))], [1, 2, 3, 4, 5]);
  assert.equal(opened.onlyExport, false, "another file in the zip: it's kept after importing");
});

test("files in the media folder that no jot links to are counted, so the zip is kept", async () => {
  const linked = await openZipExport(buildZip([{ name: "export/export.md", data: EXPORT }, { name: "export/media/AAAA.png", data: "png" }]));
  assert.equal(linked.unlinked, 0);
  const extra = await openZipExport(
    buildZip([
      { name: "export/export.md", data: EXPORT },
      { name: "export/media/AAAA.png", data: "png" },
      { name: "export/media/BBBB.png", data: "no jot links to me" },
      // A link the parser can't use: only files directly in media/ are attachments.
      { name: "export/media/sub/CCCC.png", data: "nested" },
      { name: "export/media/.DS_Store", data: "Finder's" },
    ]),
  );
  assert.equal(extra.onlyExport, true);
  assert.equal(extra.unlinked, 2);
  assert.deepEqual([...extra.media.keys()], ["media/AAAA.png"]);
});

test("a file name with spaces, brackets or an odd extension, as older Jot wrote them, still pairs with its file", async () => {
  const names = ["11111111-2222-4333-8444-555555555555.tar gz", "22222222-2222-4333-8444-555555555555.we)ird", "33333333-2222-4333-8444-555555555555.a]b"];
  const text = [
    "<!-- jot:export v=1 -->",
    '<!-- jot:category name="Files" -->',
    `- backup [file: media/${names[0]}] and ![shot](media/${names[1]}) and [video: media/${names[2]}]`,
    "<!-- /jot:category -->",
  ].join("\n");
  const zip = await openZipExport(buildZip([{ name: "export/export.md", data: text }, ...names.map((n) => ({ name: `export/media/${n}`, data: n }))]));
  assert.deepEqual([...zip.media.keys()], names.map((n) => `media/${n}`));
  assert.equal(zip.unlinked, 0);
});

test("zip slip: a path that climbs out of its folder refuses the whole zip", async () => {
  for (const name of ["../evil.md", "export/../../evil.png", "/etc/evil.md", "C:/evil.md", "export\\..\\evil.md"]) {
    assert.ok(!isSafeEntryName(name), name);
    await rejects(buildZip([{ name: "export/export.md", data: EXPORT }, { name, data: "x" }]), /points outside the zip/);
  }
  assert.ok(isSafeEntryName("export/media/AAAA.png"));
  assert.ok(isSafeEntryName("export/..notes/a.md"), "dots inside a name are fine");
});

test("huge files: a size over the limit is refused before anything is unpacked", async () => {
  await rejects(
    buildZip([{ name: "export/export.md", data: EXPORT }, { name: "export/media/AAAA.png", data: "x", size: ZIP_LIMITS.entryBytes + 1 }]),
    /too large/,
  );
  // A zip bomb: says 10 bytes, unpacks to a megabyte. Stopped at the 11th byte.
  const bomb = buildZip([
    { name: "export/export.md", data: EXPORT },
    { name: "export/media/AAAA.png", data: new Uint8Array(1024 * 1024), size: 10 },
  ]);
  const opened = await openZipExport(bomb);
  await assert.rejects(opened.read(opened.media.get("media/AAAA.png")!), /larger than the zip says/);
});

test("on a phone or tablet the limits are half as large, with the same notices", async () => {
  const MB = 1024 * 1024;
  assert.equal(MOBILE_ZIP_LIMITS.entryBytes, 256 * MB);
  assert.equal(MOBILE_ZIP_LIMITS.totalBytes, 512 * MB);
  assert.equal(MOBILE_ZIP_LIMITS.zipBytes, 512 * MB);
  assert.equal(MOBILE_ZIP_LIMITS.textBytes, ZIP_LIMITS.textBytes);
  // Sizes as the zip states them; nothing that large is unpacked to check.
  const video = buildZip([
    { name: "export/export.md", data: EXPORT },
    { name: "export/media/AAAA.png", data: "x", size: 300 * MB },
  ]);
  await openZipExport(video);
  await assert.rejects(openZipExport(video, MOBILE_ZIP_LIMITS), (e: unknown) => e instanceof ZipError && e.message === "A file in the zip is too large to import.");
  const three = [
    "<!-- jot:export v=1 -->",
    '<!-- jot:category name="Places" -->',
    "- ![a](media/A.png) ![b](media/B.png) ![c](media/C.png)",
    "<!-- /jot:category -->",
  ].join("\n");
  const many = buildZip([
    { name: "export/export.md", data: three },
    ...["A", "B", "C"].map((n) => ({ name: `export/media/${n}.png`, data: "x", size: 200 * MB })),
  ]);
  assert.equal((await openZipExport(many)).media.size, 3);
  await assert.rejects(
    openZipExport(many, MOBILE_ZIP_LIMITS),
    (e: unknown) => e instanceof ZipError && e.message === "The attachments in the Jot export are too large to import together.",
  );
  assert.throws(() => readZipDirectory({ length: 600 * MB } as Uint8Array, MOBILE_ZIP_LIMITS), /The zip is too large to import\./);
});

test("an unpacked file is saved from its own buffer, not a copy", async () => {
  const zip = await openZipExport(ALL);
  for (const entry of zip.media.values()) {
    const bytes = await zip.read(entry);
    assert.equal(wholeBuffer(bytes), bytes.buffer, entry.name);
  }
  const stored = await openZipExport(buildZip([{ name: "export/export.md", data: EXPORT }, { name: "export/media/AAAA.png", data: "png!", stored: true }]));
  const bytes = await stored.read(stored.media.get("media/AAAA.png")!);
  assert.equal(wholeBuffer(bytes), bytes.buffer, "a stored entry too");
  // A view into a larger buffer is copied, so nothing around it is saved.
  const view = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
  assert.deepEqual([...new Uint8Array(wholeBuffer(view))], [1, 2, 3]);
});

test("a large entry unpacks in slices of the zip's own bytes, which stay as they were", async () => {
  // Random bytes don't compress, so the packed entry is a few megabytes too.
  const big = new Uint8Array(randomBytes(3 * 1024 * 1024 + 17));
  const zip = buildZip([{ name: "export/export.md", data: EXPORT }, { name: "export/media/AAAA.png", data: big }]);
  const copy = zip.slice();
  const opened = await openZipExport(zip);
  const entry = opened.media.get("media/AAAA.png")!;
  assert.ok(entry.compressedSize > 2 * 1024 * 1024);
  assert.deepEqual(await opened.read(entry), big);
  assert.deepEqual(zip, copy, "nothing detached or changed");
  assert.deepEqual(await opened.read(entry), big, "and it reads again");
});

test("a ZIP64 field longer than the extra data it's in is refused, not read from what follows", async () => {
  // The field says 24 bytes but holds only the size; the packed size and offset that follow are in the comment.
  const extra = new DataView(new ArrayBuffer(12));
  extra.setUint16(0, 0x0001, true);
  extra.setUint16(2, 24, true);
  extra.setBigUint64(4, 1n, true);
  const comment = new DataView(new ArrayBuffer(16));
  comment.setBigUint64(0, 1n, true);
  comment.setBigUint64(8, BigInt(30 + "export/export.md".length + Buffer.byteLength(EXPORT)), true);
  const zip = buildZip([
    { name: "export/export.md", data: EXPORT, stored: true },
    { name: "export/media/AAAA.png", data: "x", stored: true, zip64: true, extra: new Uint8Array(extra.buffer), comment: new Uint8Array(comment.buffer) },
  ]);
  await rejects(zip, /damaged or isn't a zip/);
});

test("damaged and unsupported zips say why", async () => {
  const good = buildZip([{ name: "export/export.md", data: EXPORT }]);
  await rejects(good.subarray(0, good.length - 30), /damaged or isn't a zip/);
  await rejects(buildZip([{ name: "export/export.md", data: EXPORT, crc: 1234 }]), /checksum/);
  await rejects(buildZip([{ name: "export/export.md", data: EXPORT, flags: 0x0801 }]), /encrypted/);
  await rejects(buildZip([{ name: "export/notes.md", data: "# Not an export\n" }]), /no Jot export/);
  assert.ok(!looksLikeZip(new TextEncoder().encode(EXPORT)));
});

test("a device without DecompressionStream says so up front, before anything is written", async () => {
  const original = globalThis.DecompressionStream;
  try {
    // @ts-expect-error: older iOS (before 16.4) has none
    delete globalThis.DecompressionStream;
    await rejects(fixture("jot-export-2026-10-28-1540.zip"), /can't unzip files/);
  } finally {
    globalThis.DecompressionStream = original;
  }
});
