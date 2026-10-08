/**
 * Small ZIP reader/writer for locally uploaded .xlsx files.
 * No remote services, libraries, or persistence. Existing compressed payloads
 * are copied byte-for-byte; only changed XML entries are written uncompressed.
 * Supports ordinary non-encrypted ZIP32 XLSX workbooks (not ZIP64).
 */
const MAX_XLSX_BYTES = 20 * 1024 * 1024;
const MAX_ENTRY_BYTES = 30 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunksToBytes(chunks) {
  const length = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) { combined.set(c, offset); offset += c.length; }
  return combined;
}

export class WorkbookZip {
  constructor(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length > MAX_XLSX_BYTES) throw new Error('Workbook exceeds the 20 MB file limit.');
    this.entries = new Map();
    this.order = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    const limit = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= limit; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('Invalid or unsupported XLSX ZIP archive.');
    const entryCount = view.getUint16(end + 10, true);
    const centralOffset = view.getUint32(end + 16, true);
    if (entryCount === 0xffff || centralOffset === 0xffffffff || entryCount > 3000) {
      throw new Error('Unsupported XLSX ZIP64 archive or excessive file entries.');
    }
    let position = centralOffset;
    for (let i = 0; i < entryCount; i++) {
      if (position + 46 > bytes.length || view.getUint32(position, true) !== 0x02014b50) {
        throw new Error('Corrupted XLSX ZIP central directory.');
      }
      const flags = view.getUint16(position + 8, true);
      const method = view.getUint16(position + 10, true);
      const dosTime = view.getUint16(position + 12, true);
      const dosDate = view.getUint16(position + 14, true);
      const crc = view.getUint32(position + 16, true);
      const compressedSize = view.getUint32(position + 20, true);
      const uncompressedSize = view.getUint32(position + 24, true);
      const nameLength = view.getUint16(position + 28, true);
      const extraLength = view.getUint16(position + 30, true);
      const commentLength = view.getUint16(position + 32, true);
      const offset = view.getUint32(position + 42, true);
      if (flags & 1 || ![0, 8].includes(method) || compressedSize === 0xffffffff ||
          uncompressedSize === 0xffffffff || uncompressedSize > MAX_ENTRY_BYTES) {
        throw new Error('Unsupported encrypted/compressed XLSX entry.');
      }
      const nameBytes = bytes.slice(position + 46, position + 46 + nameLength);
      const name = decoder.decode(nameBytes);
      if (this.entries.has(name) || name.startsWith('/') || name.includes('..')) {
        throw new Error('Duplicate or unsafe XLSX package entry.');
      }
      if (offset + 30 > bytes.length || view.getUint32(offset, true) !== 0x04034b50) {
        throw new Error('Invalid XLSX ZIP local header.');
      }
      const localDataStart = offset + 30 + view.getUint16(offset + 26, true) +
        view.getUint16(offset + 28, true);
      if (localDataStart + compressedSize > bytes.length) {
        throw new Error('Truncated XLSX ZIP entry.');
      }
      this.entries.set(name, {
        nameBytes, flags, method, dosTime, dosDate, crc,
        uncompressedSize, compressed: bytes.slice(localDataStart, localDataStart + compressedSize)
      });
      this.order.push(name);
      position += 46 + nameLength + extraLength + commentLength;
    }
  }

  has(path) { return this.entries.has(path); }

  async read(path) {
    const entry = this.entries.get(path);
    if (!entry) throw new Error('Workbook XML part missing: ' + path);
    if (entry.method === 0) return entry.compressed.slice();
    const stream = new Blob([entry.compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const result = new Uint8Array(await new Response(stream).arrayBuffer());
    if (result.length !== entry.uncompressedSize || result.length > MAX_ENTRY_BYTES ||
        crc32(result) !== entry.crc) throw new Error('Workbook ZIP checksum/length mismatch.');
    return result;
  }

  replace(path, value) {
    const existing = this.entries.get(path);
    if (!existing) throw new Error('Workbook XML part missing: ' + path);
    const raw = typeof value === 'string' ? encoder.encode(value) : value;
    if (!(raw instanceof Uint8Array) || raw.length > MAX_ENTRY_BYTES) {
      throw new Error('Invalid or oversized XLSX XML update.');
    }
    this.entries.set(path, {
      ...existing, method: 0, compressed: raw,
      crc: crc32(raw), uncompressedSize: raw.length
    });
  }

  toBlob() {
    const localParts = [], centralParts = [];
    let offset = 0, centralSize = 0;
    for (const name of this.order) {
      const entry = this.entries.get(name);
      // Use a fixed UTF-8 flag and clear data-descriptor flag: all lengths are known.
      const flags = (entry.flags | 0x800) & ~0x8;
      const fileName = entry.nameBytes;
      const local = new Uint8Array(30);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, flags, true);
      lv.setUint16(8, entry.method, true);
      lv.setUint16(10, entry.dosTime, true);
      lv.setUint16(12, entry.dosDate, true);
      lv.setUint32(14, entry.crc, true);
      lv.setUint32(18, entry.compressed.length, true);
      lv.setUint32(22, entry.uncompressedSize, true);
      lv.setUint16(26, fileName.length, true);
      localParts.push(local, fileName, entry.compressed);

      const central = new Uint8Array(46);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, flags, true);
      cv.setUint16(10, entry.method, true);
      cv.setUint16(12, entry.dosTime, true);
      cv.setUint16(14, entry.dosDate, true);
      cv.setUint32(16, entry.crc, true);
      cv.setUint32(20, entry.compressed.length, true);
      cv.setUint32(24, entry.uncompressedSize, true);
      cv.setUint16(28, fileName.length, true);
      cv.setUint32(42, offset, true);
      centralParts.push(central, fileName);
      offset += local.length + fileName.length + entry.compressed.length;
      centralSize += central.length + fileName.length;
    }
    if (offset + centralSize > 0xffffffff) throw new Error('ZIP32 size limit exceeded.');
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.order.length, true);
    ev.setUint16(10, this.order.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    return new Blob([...localParts, ...centralParts, end], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }
}
