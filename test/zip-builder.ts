import { deflateRawSync } from "node:zlib";
import { crc32 } from "../src/zip.ts";

/** One file in a zip built for a test. */
export interface Entry {
  name: string;
  data: Uint8Array | string;
  stored?: boolean;
  /** Overrides, to build a broken or hostile zip. */
  size?: number;
  crc?: number;
  flags?: number;
  zip64?: boolean;
  /** Bytes for the central directory's extra field, in place of the ZIP64 one. */
  extra?: Uint8Array;
  /** The central directory's comment for this file. */
  comment?: Uint8Array;
}

/** A zip with a central directory, like any zip tool writes. */
export function buildZip(entries: Entry[]): Uint8Array {
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

    let extra = e.extra ? Buffer.from(e.extra) : Buffer.alloc(0);
    if (e.zip64 && !e.extra) {
      extra = Buffer.alloc(4 + 24);
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
    central.writeUInt16LE(e.comment?.length ?? 0, 32);
    central.writeUInt32LE(e.zip64 ? 0xffffffff : offset, 42);
    centrals.push(central, name, extra, Buffer.from(e.comment ?? []));
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

