// A zip file made in memory, the files stored as they are (no compression). Names are UTF-8
// (flag bit 11). Copied from the MRA Returns app (mra_returns/src/lib/zip.ts), without its
// folder entries: an Excel file has none. Nothing here is stored anywhere.

export interface ZipEntry {
  /** "xl/worksheets/sheet1.xml": folders separated by "/". */
  path: string;
  bytes: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The date and time as a zip writes them (local time, 2-second steps, from 1980). */
function dosStamp(at: Date): { time: number; date: number } {
  const year = Math.min(Math.max(at.getFullYear(), 1980), 2107);
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

const UTF8_NAMES = 0x0800;
const STORED = 0;
const VERSION = 20;

/** The zip of these files, in this order. */
export function makeZip(entries: readonly ZipEntry[], at: Date): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosStamp(at);
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const crc = crc32(entry.bytes);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, VERSION, true);
    head.setUint16(6, UTF8_NAMES, true);
    head.setUint16(8, STORED, true);
    head.setUint16(10, time, true);
    head.setUint16(12, date, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, entry.bytes.length, true);
    head.setUint32(22, entry.bytes.length, true);
    head.setUint16(26, name.length, true);
    head.setUint16(28, 0, true);
    local.push(new Uint8Array(head.buffer), name, entry.bytes);

    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, VERSION, true);
    record.setUint16(6, VERSION, true);
    record.setUint16(8, UTF8_NAMES, true);
    record.setUint16(10, STORED, true);
    record.setUint16(12, time, true);
    record.setUint16(14, date, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, entry.bytes.length, true);
    record.setUint32(24, entry.bytes.length, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    central.push(new Uint8Array(record.buffer), name);
    offset += 30 + name.length + entry.bytes.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of parts) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}
