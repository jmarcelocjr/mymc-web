import type { ArchiveNode } from './archive';
import { latin1 } from './binary';
import { DIRENT_SIZE, EntryField, MAX_NAME_LENGTH, Mode, makeEntry, parseDirEntry, type Tod } from './dirent';
import { CardError } from './errors';
import { DIR_MODE } from './format';
import { lzariDecode } from './lzari';

const PSU_CLUSTER = 1024;
/** No real save comes close; anything bigger is a damaged header. */
const MAX_SAVE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 1000;
/** Mode mymc gives files that come without one (.max): rwx, file, PS2, exists. */
export const FILE_MODE = Mode.READ | Mode.WRITE | Mode.EXECUTE | Mode.FILE | Mode.PS2_SAVE | Mode.EXISTS;

export interface ImportedSave {
  node: ArchiveNode;
  format: 'psu' | 'max';
  /** Things the user should know, e.g. a checksum that didn't match. */
  warnings: string[];
}

const bad = (msg: string) => new CardError('bad-save-file', msg);

/** Names the card can hold: not empty, not "." or "..", no slashes, at most 31 bytes. */
function checkName(name: string, what: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.length > MAX_NAME_LENGTH) {
    throw bad(`${what} has an invalid name: "${name}".`);
  }
}

function withMode(entry: Uint8Array, set: number, clear: number): Uint8Array {
  const out = entry.slice(0, DIRENT_SIZE);
  const view = new DataView(out.buffer);
  view.setUint16(EntryField.mode, ((view.getUint16(EntryField.mode, true) | set) & ~clear) & 0xffff, true);
  return out;
}

/** Read an EMS/uLaunchELF .psu save (the format exportPsu writes). */
export function parsePsu(bytes: Uint8Array): ImportedSave {
  if (bytes.length < DIRENT_SIZE * 3) throw bad('Not a .psu file (too short).');
  const at = (i: number) => bytes.subarray(i, i + DIRENT_SIZE);
  const dir = parseDirEntry(at(0), 0);
  const dot = parseDirEntry(at(DIRENT_SIZE), 0);
  const dotdot = parseDirEntry(at(DIRENT_SIZE * 2), 0);
  const isDirMode = (m: number) => (m & Mode.DIR) !== 0;
  if (!isDirMode(dir.mode) || !isDirMode(dot.mode) || !isDirMode(dotdot.mode) || dir.length < 2) {
    throw bad('Not a .psu file (its header is not a save folder).');
  }
  checkName(dir.name, 'The save folder');
  const count = dir.length - 2;
  if (count > MAX_FILES) throw bad(`The .psu says it has ${count} files; it is probably damaged.`);

  let offset = DIRENT_SIZE * 3;
  const children: ArchiveNode[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + DIRENT_SIZE > bytes.length) throw bad(`The .psu ends early (file ${i + 1} of ${count} is missing).`);
    const raw = at(offset);
    const e = parseDirEntry(raw, 0);
    offset += DIRENT_SIZE;
    if ((e.mode & Mode.FILE) === 0 || (e.mode & Mode.DIR) !== 0) throw bad(`"${e.name}" in the .psu is a folder; saves can't hold folders.`);
    checkName(e.name, 'A file');
    if (e.length > MAX_SAVE_BYTES || offset + e.length > bytes.length) throw bad(`The .psu ends in the middle of "${e.name}".`);
    if (children.some((c) => c.name === e.name)) throw bad(`The .psu has "${e.name}" twice.`);
    children.push({ entry: withMode(raw, Mode.FILE | Mode.EXISTS, Mode.DIR), name: e.name, data: bytes.slice(offset, offset + e.length) });
    offset += Math.ceil(e.length / PSU_CLUSTER) * PSU_CLUSTER;
  }
  return {
    format: 'psu',
    warnings: [],
    node: {
      entry: withMode(at(0), Mode.DIR | Mode.EXISTS, Mode.FILE),
      name: dir.name,
      dir: { dot: at(DIRENT_SIZE).slice(), dotdot: at(DIRENT_SIZE * 2).slice(), children },
    },
  };
}

// ---------------------------------------------------------------- .max

const MAX_MAGIC = 'Ps2PowerSave';
const MAX_HEADER = 0x5c;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * Read an Action Replay MAX (.max) save: a header, then the files packed
 * together and LZARI-compressed. The format keeps no dates, so the save and
 * its files get `now` (mymc does the same).
 */
export function parseMax(bytes: Uint8Array, now: Tod): ImportedSave {
  if (bytes.length < MAX_HEADER || latin1(bytes.subarray(0, 12)) !== MAX_MAGIC) {
    throw bad('Not a .max file (the "Ps2PowerSave" signature is missing).');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const storedCrc = view.getUint32(12, true);
  const dirName = parseDirEntry(padName(bytes.subarray(16, 48)), 0).name;
  const clen = view.getUint32(0x50, true);
  const fileCount = view.getUint32(0x54, true);
  const length = view.getUint32(0x58, true);
  checkName(dirName, 'The save folder');
  if (fileCount > MAX_FILES || length > MAX_SAVE_BYTES) throw bad('The .max header is damaged (sizes out of range).');

  // Some tools store the uncompressed size where the compressed size goes.
  let compressed: Uint8Array;
  if (clen === length) compressed = bytes.subarray(MAX_HEADER);
  else {
    if (clen < 4 || MAX_HEADER + clen - 4 > bytes.length) throw bad('The .max file ends early.');
    compressed = bytes.subarray(MAX_HEADER, MAX_HEADER + clen - 4);
  }

  const warnings: string[] = [];
  const header = bytes.slice(0, MAX_HEADER);
  header.fill(0, 12, 16);
  if (crc32(compressed, crc32(header)) !== storedCrc) {
    warnings.push("The .max file's checksum doesn't match; its contents were checked file by file instead.");
  }

  const data = lzariDecode(compressed, length);
  const children: ArchiveNode[] = [];
  let off = 0;
  for (let i = 0; i < fileCount; i++) {
    if (data.length - off < 36) throw bad(`The .max data ends early (file ${i + 1} of ${fileCount}).`);
    const size = new DataView(data.buffer, data.byteOffset + off).getUint32(0, true);
    const name = parseDirEntry(padName(data.subarray(off + 4, off + 36)), 0).name;
    off += 36;
    checkName(name, 'A file');
    if (size > data.length - off) throw bad(`The .max data ends in the middle of "${name}".`);
    if (children.some((c) => c.name === name)) throw bad(`The .max has "${name}" twice.`);
    children.push({ entry: makeEntry({ mode: FILE_MODE, name, created: now }), name, data: data.slice(off, off + size) });
    off += size;
    off = Math.ceil((off + 8) / 16) * 16 - 8;
  }
  return {
    format: 'max',
    warnings,
    node: {
      entry: makeEntry({ mode: DIR_MODE, name: dirName, created: now }),
      name: dirName,
      dir: {
        dot: makeEntry({ mode: DIR_MODE, name: '.', created: now }),
        dotdot: makeEntry({ mode: DIR_MODE, name: '..', created: now }),
        children,
      },
    },
  };
}

/** A 32-byte name field placed in an entry, so the entry parser decodes it the same way. */
function padName(name: Uint8Array): Uint8Array {
  const entry = new Uint8Array(DIRENT_SIZE);
  entry.set(name.subarray(0, 32), EntryField.name);
  return entry;
}

/** Read a save file, telling .max from .psu by its signature. */
export function parseSaveFile(bytes: Uint8Array, now: Tod): ImportedSave {
  return latin1(bytes.subarray(0, 12)) === MAX_MAGIC ? parseMax(bytes, now) : parsePsu(bytes);
}
