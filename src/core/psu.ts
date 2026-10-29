import type { MemoryCard } from './card';
import { DIRENT_SIZE, Mode, isDir, isFile, type DirEntry } from './dirent';
import { CardError } from './errors';

/** .psu files pad each file's data to whole clusters. */
const PSU_CLUSTER = 1024;
/** Where the name starts in a directory entry; the 28 bytes before it are unused. */
const NAME_OFFSET = 0x40;
const UNUSED_START = 0x24;

export interface PsuExport {
  bytes: Uint8Array;
  /** Entries left out because .psu can't hold them (subdirectories). */
  skipped: string[];
}

/**
 * A directory entry as mymc++ writes it: the card's fields, with the unused
 * bytes and everything after the name's terminator zeroed.
 */
function cleanEntry(raw: Uint8Array, length?: number): Uint8Array {
  const out = new Uint8Array(DIRENT_SIZE);
  out.set(raw.subarray(0, UNUSED_START));
  const name = raw.subarray(NAME_OFFSET, DIRENT_SIZE);
  const end = name.indexOf(0);
  out.set(end < 0 ? name : name.subarray(0, end), NAME_OFFSET);
  if (length !== undefined) new DataView(out.buffer).setUint32(4, length, true);
  return out;
}

/** The "." and ".." entries: both carry the save directory's creation time. */
function dotEntry(dir: DirEntry, name: string): Uint8Array {
  const out = new Uint8Array(DIRENT_SIZE);
  const view = new DataView(out.buffer);
  view.setUint16(0, Mode.READ | Mode.WRITE | Mode.EXECUTE | Mode.DIR | Mode.PS2_SAVE | Mode.EXISTS, true);
  const created = dir.raw.subarray(8, 16);
  out.set(created, 8);
  out.set(created, 24);
  for (let i = 0; i < name.length; i++) out[NAME_OFFSET + i] = name.charCodeAt(i);
  return out;
}

/**
 * Export a save directory as an EMS/uLaunchELF .psu file, laid out exactly as
 * mymc++ writes it: the directory's entry (counting "." and ".."), the two dot
 * entries, then each file's entry followed by its data padded to 1024 bytes.
 */
export function exportPsu(card: MemoryCard, name: string): PsuExport {
  const path = `/${name}`;
  const dir = card.stat(path);
  if (!isDir(dir) || name === '' || name.includes('/')) {
    throw new CardError('not-a-directory', `Only save folders can be exported as .psu: ${name}`);
  }
  const skipped: string[] = [];
  const files: { entry: DirEntry; data: Uint8Array }[] = [];
  for (const entry of card.readDir(path)) {
    if (!isFile(entry)) {
      skipped.push(entry.name);
      continue;
    }
    files.push({ entry, data: card.readFile(`${path}/${entry.name}`) });
  }

  const padded = (n: number) => Math.ceil(n / PSU_CLUSTER) * PSU_CLUSTER;
  const size = DIRENT_SIZE * (3 + files.length) + files.reduce((sum, f) => sum + padded(f.data.length), 0);
  const out = new Uint8Array(size);
  let at = 0;
  const put = (bytes: Uint8Array, advance = bytes.length) => {
    out.set(bytes, at);
    at += advance;
  };
  put(cleanEntry(dir.raw, files.length + 2));
  put(dotEntry(dir, '.'));
  put(dotEntry(dir, '..'));
  for (const { entry, data } of files) {
    put(cleanEntry(entry.raw));
    put(data, padded(data.length));
  }
  return { bytes: out, skipped };
}
