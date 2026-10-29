import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { parseJotExport } from "../src/format.ts";
import {
  crc32,
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

interface Entry {
  name: string;
  data: Uint8Array | string;
  stored?: boolean;
  /** Overrides, to build a broken or hostile zip. */
  size?: number;
  crc?: number;
  flags?: number;
  zip64?: boolean;
}

/** A zip with a central directory, like any zip tool writes. */
function buildZip(entries: Entry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const bytes = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : Buffer.from(e.data);
    const packed = e.stored ? bytes : deflateRawSync(bytes);
    const name = Buffer.from(e.name, "utf8");
    const crc = e.crc ?? crc32(bytes);
    const size = e.size ?? bytes.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0x0800, 6);
    local.writeUInt16LE(e.stored ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);

    const extra = e.zip64 ? Buffer.alloc(4 + 24) : Buffer.alloc(0);
    if (e.zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(packed.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.flags ?? 0x0800, 8);
    central.writeUInt16LE(e.stored ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.zip64 ? 0xffffffff : packed.length, 20);
    central.writeUInt32LE(e.zip64 ? 0xffffffff : size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(e.zip64 ? 0xffffffff : offset, 42);
    centrals.push(central, name, extra);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

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

test("zip slip: a path that climbs out of its folder refuses the whole zip", async () => {
  for (const name of ["../evil.md", "export/../../evil.png", "/etc/evil.md", "C:/evil.md", "export\\..\\evil.md"]) {
    assert.ok(!isSafeEntryName(name), name);
    await rejects(buildZip([{ name: "export/export.md", data: EXPORT }, { name, data: "x" }]), /outside its folder/);
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
  await assert.rejects(opened.read(opened.media.get("media/AAAA.png")!), /larger than it says/);
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
    (e: unknown) => e instanceof ZipError && e.message === "The export's attachments are too large to import together.",
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

test("damaged and unsupported zips say why", async () => {
  const good = buildZip([{ name: "export/export.md", data: EXPORT }]);
  await rejects(good.subarray(0, good.length - 30), /damaged or not a zip/);
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
