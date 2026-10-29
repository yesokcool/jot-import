/*
 * A small ZIP reader, enough for the zips Jot shares when an export has
 * photos or files (`ExportFile.materialize` zips a folder with
 * NSFileCoordinator's `.forUploading`). It reads the central directory,
 * checks every entry, and inflates one entry at a time with the platform's
 * `DecompressionStream("deflate-raw")`, so there's no third-party code and
 * no Node or Electron API: it runs the same on desktop and mobile.
 *
 * Handles stored (0) and deflated (8) entries, data descriptors (Apple's
 * zips have sizes in the central directory only) and ZIP64 sizes. Refuses
 * encrypted and multi-disk zips, entries whose path could climb out of a
 * folder ("zip slip"), and anything bigger than `ZIP_LIMITS`. Pure: no
 * Obsidian imports, so the tests run it on real zips under Node.
 */

export interface ZipEntry {
  /** Path inside the zip, "/"-separated, NFC (macOS writes some names decomposed). */
  name: string;
  /** 0 = stored, 8 = deflated. */
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  /** Where the entry's local header starts. */
  offset: number;
}

/** A zip Jot Import won't read; `message` is one sentence for the notice. */
export class ZipError extends Error {}

export const ZIP_LIMITS = {
  /** The zip file itself. Larger ones aren't read into memory at all. */
  zipBytes: 1024 * 1024 * 1024,
  /** One entry, unpacked. */
  entryBytes: 512 * 1024 * 1024,
  /** All the entries an import unpacks, together. */
  totalBytes: 1024 * 1024 * 1024,
  /** The export's Markdown file, unpacked. */
  textBytes: 32 * 1024 * 1024,
  entries: 10000,
};

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Whether the bytes start like a zip (a local header, or an empty zip's end record). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const sig = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
  return sig >>> 0 === LOCAL || sig >>> 0 === EOCD;
}

/** Whether this device can inflate zip entries (`DecompressionStream` with "deflate-raw"). */
export function canInflate(): boolean {
  try {
    // Constructing one throws where the format isn't supported (Safari before 16.4).
    return typeof DecompressionStream === "function" && typeof new DecompressionStream("deflate-raw").readable === "object";
  } catch {
    return false;
  }
}

/**
 * Whether an entry name is a plain relative path: no "..", no leading "/",
 * no drive letter, no backslash, no control characters. Jot never writes
 * anything else; a zip that does is refused whole.
 */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.includes("\\")) return false;
  for (let i = 0; i < name.length; i++) if (name.charCodeAt(i) < 0x20) return false;
  return !name.split("/").some((part) => part === "..");
}

/** The central directory: every file entry (folders are left out), checked against the limits. */
export function readZipDirectory(data: Uint8Array): ZipEntry[] {
  if (data.length > ZIP_LIMITS.zipBytes) throw new ZipError("The zip is too large to import.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const end = findEnd(view);
  if (end < 0) throw new ZipError("The zip is damaged or not a zip.");
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) {
    throw new ZipError("The zip is split into parts, which Jot Import can't read.");
  }
  let count = view.getUint16(end + 10, true);
  let size = view.getUint32(end + 12, true);
  let start = view.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) {
    const z64 = zip64End(view, end);
    count = z64.count;
    size = z64.size;
    start = z64.start;
  }
  if (count > ZIP_LIMITS.entries) throw new ZipError("The zip holds too many files to import.");
  if (start + size > end) throw new ZipError("The zip is damaged or not a zip.");

  const decoder = new TextDecoder("utf-8");
  const entries: ZipEntry[] = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || view.getUint32(at, true) !== CENTRAL) throw new ZipError("The zip is damaged or not a zip.");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    let compressedSize = view.getUint32(at + 20, true);
    let uncompressed = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    let offset = view.getUint32(at + 42, true);
    const nameStart = at + 46;
    if (nameStart + nameLength + extraLength > end) throw new ZipError("The zip is damaged or not a zip.");
    // Apple's zips are UTF-8 without saying so (flag bit 11 unset), so names are always read as UTF-8.
    const raw = decoder.decode(data.subarray(nameStart, nameStart + nameLength));
    const name = raw.normalize("NFC");
    const z64 = readZip64Extra(view, nameStart + nameLength, extraLength, {
      size: uncompressed === 0xffffffff,
      compressed: compressedSize === 0xffffffff,
      offset: offset === 0xffffffff,
    });
    uncompressed = z64.size ?? uncompressed;
    compressedSize = z64.compressed ?? compressedSize;
    offset = z64.offset ?? offset;
    at = nameStart + nameLength + extraLength + commentLength;

    if (!isSafeEntryName(name)) throw new ZipError("The zip has a file path that points outside its folder.");
    if (name.endsWith("/")) continue;
    if (flags & 0x1) throw new ZipError("The zip is encrypted.");
    if (method !== 0 && method !== 8) throw new ZipError("The zip uses a compression Jot Import can't read.");
    if (uncompressed > ZIP_LIMITS.entryBytes) throw new ZipError("A file in the zip is too large to import.");
    if (method === 0 && compressedSize !== uncompressed) throw new ZipError("The zip is damaged or not a zip.");
    if (offset + 30 + compressedSize > start) throw new ZipError("The zip is damaged or not a zip.");
    entries.push({ name, method, compressedSize, size: uncompressed, crc, offset });
  }
  return entries;
}

/**
 * One entry's bytes, inflated and checked against its size and CRC. Never
 * allocates more than the size the directory gave (already within
 * `ZIP_LIMITS.entryBytes`), and stops as soon as the data runs past it.
 */
export async function readZipEntry(data: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (entry.offset + 30 > data.length || view.getUint32(entry.offset, true) !== LOCAL) {
    throw new ZipError("The zip is damaged or not a zip.");
  }
  // The local header's own name and extra lengths: its extra field can differ from the central one.
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  if (start + entry.compressedSize > data.length) throw new ZipError("The zip is damaged or not a zip.");
  const packed = data.subarray(start, start + entry.compressedSize);
  const bytes = entry.method === 0 ? packed.slice() : await inflate(packed, entry.size);
  if (crc32(bytes) !== entry.crc) throw new ZipError("The zip is damaged: a file in it doesn't match its checksum.");
  return bytes;
}

async function inflate(packed: Uint8Array, size: number): Promise<Uint8Array> {
  if (!canInflate()) {
    throw new ZipError("This device can't unzip files. Unzip the export first, then import the .md file inside.");
  }
  const out = new Uint8Array(size);
  let filled = 0;
  const stream = new Blob([packed as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (filled + value.length > size) throw new ZipError("The zip is damaged: a file in it is larger than it says.");
      out.set(value, filled);
      filled += value.length;
    }
  } catch (e) {
    void reader.cancel().catch(() => undefined);
    throw e instanceof ZipError ? e : new ZipError("The zip is damaged: a file in it can't be unpacked.");
  }
  if (filled !== size) throw new ZipError("The zip is damaged: a file in it is shorter than it says.");
  return out;
}

/** Offset of the end-of-central-directory record, searched back through the comment; -1 if none. */
function findEnd(view: DataView): number {
  const last = view.byteLength - 22;
  const first = Math.max(0, last - 0xffff);
  for (let i = last; i >= first; i--) {
    if (view.getUint32(i, true) === EOCD && i + 22 + view.getUint16(i + 20, true) === view.byteLength) return i;
  }
  // A comment length that doesn't reach the end exactly: take the last signature.
  for (let i = last; i >= first; i--) if (view.getUint32(i, true) === EOCD) return i;
  return -1;
}

function zip64End(view: DataView, end: number): { count: number; size: number; start: number } {
  const locator = end - 20;
  if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR) throw new ZipError("The zip is damaged or not a zip.");
  const record = safeNumber(view.getBigUint64(locator + 8, true));
  if (record + 56 > locator || view.getUint32(record, true) !== ZIP64_EOCD) throw new ZipError("The zip is damaged or not a zip.");
  return {
    count: safeNumber(view.getBigUint64(record + 32, true)),
    size: safeNumber(view.getBigUint64(record + 40, true)),
    start: safeNumber(view.getBigUint64(record + 48, true)),
  };
}

/** The ZIP64 extra field (0x0001): the 64-bit values, in order, for the fields that were 0xFFFFFFFF. */
function readZip64Extra(
  view: DataView,
  at: number,
  length: number,
  wanted: { size: boolean; compressed: boolean; offset: boolean },
): { size?: number; compressed?: number; offset?: number } {
  if (!wanted.size && !wanted.compressed && !wanted.offset) return {};
  const end = at + length;
  while (at + 4 <= end) {
    const id = view.getUint16(at, true);
    const len = view.getUint16(at + 2, true);
    if (id === 0x0001) {
      let p = at + 4;
      const read = () => {
        if (p + 8 > at + 4 + len) throw new ZipError("The zip is damaged or not a zip.");
        const v = safeNumber(view.getBigUint64(p, true));
        p += 8;
        return v;
      };
      return {
        size: wanted.size ? read() : undefined,
        compressed: wanted.compressed ? read() : undefined,
        offset: wanted.offset ? read() : undefined,
      };
    }
    at += 4 + len;
  }
  throw new ZipError("The zip is damaged or not a zip.");
}

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("The zip is too large to import.");
  return Number(value);
}

let crcTable: Uint32Array | null = null;

/** CRC-32 (the zip/PNG one). */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
