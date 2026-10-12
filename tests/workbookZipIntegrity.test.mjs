import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkbookZip } from '../utils/workbookZip.js';

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

function makeStoredArchive(contents = '<sheet/>') {
  const name = encoder.encode('xl/worksheets/sheet1.xml');
  const payload = encoder.encode(contents);
  const localHeader = new Uint8Array(30);
  const local = new DataView(localHeader.buffer);
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(6, 0x800, true);
  local.setUint32(14, crc32(payload), true);
  local.setUint32(18, payload.length, true);
  local.setUint32(22, payload.length, true);
  local.setUint16(26, name.length, true);

  const centralHeader = new Uint8Array(46);
  const central = new DataView(centralHeader.buffer);
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, 20, true);
  central.setUint16(6, 20, true);
  central.setUint16(8, 0x800, true);
  central.setUint32(16, crc32(payload), true);
  central.setUint32(20, payload.length, true);
  central.setUint32(24, payload.length, true);
  central.setUint16(28, name.length, true);

  const dataOffset = localHeader.length + name.length;
  const centralOffset = dataOffset + payload.length;
  const end = new Uint8Array(22);
  const footer = new DataView(end.buffer);
  footer.setUint32(0, 0x06054b50, true);
  footer.setUint16(8, 1, true);
  footer.setUint16(10, 1, true);
  footer.setUint32(12, centralHeader.length + name.length, true);
  footer.setUint32(16, centralOffset, true);

  const archive = new Uint8Array(centralOffset + centralHeader.length + name.length + end.length);
  let offset = 0;
  for (const chunk of [localHeader, name, payload, centralHeader, name, end]) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  return { archive, dataOffset, centralOffset };
}

test('valid uncompressed workbook parts still read and export successfully', async () => {
  const { archive } = makeStoredArchive();
  const zip = new WorkbookZip(archive);
  assert.equal(decoder.decode(await zip.read('xl/worksheets/sheet1.xml')), '<sheet/>');
  zip.replace('xl/worksheets/sheet1.xml', encoder.encode('<sheet><row/></sheet>'));
  const updated = new WorkbookZip(new Uint8Array(await zip.toBlob().arrayBuffer()));
  assert.equal(decoder.decode(await updated.read('xl/worksheets/sheet1.xml')),
    '<sheet><row/></sheet>');
});

test('corruption of a stored workbook part is rejected by its ZIP CRC', async () => {
  const { archive, dataOffset } = makeStoredArchive();
  archive[dataOffset] ^= 1;
  const zip = new WorkbookZip(archive);
  await assert.rejects(() => zip.read('xl/worksheets/sheet1.xml'),
    /Workbook ZIP checksum\/length mismatch/);
});

test('stored workbook entries with conflicting sizes fail immediately at ZIP validation', () => {
  const { archive, centralOffset } = makeStoredArchive();
  const view = new DataView(archive.buffer);
  view.setUint32(centralOffset + 24, 999, true);
  // Stronger ZIP header hardening rejects the mismatch before read(), rather
  // than waiting for a subsequent checksum check.
  assert.throws(() => new WorkbookZip(archive),
    /Conflicting XLSX ZIP local and central headers/);
});
