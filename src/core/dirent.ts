import { ByteReader } from './binary';

export const DIRENT_SIZE = 512;

/** Mode flags of a directory entry (from mymc's ps2mc_dir.py). */
export const Mode = {
  READ: 0x0001,
  WRITE: 0x0002,
  EXECUTE: 0x0004,
  PROTECTED: 0x0008,
  FILE: 0x0010,
  DIR: 0x0020,
  PS2_SAVE: 0x0400, // set on every PS2 entry
  POCKETSTATION: 0x0800,
  PSX: 0x1000,
  HIDDEN: 0x2000,
  EXISTS: 0x8000,
} as const;

/**
 * Timestamp as stored on the card. Real consoles (and mymc) write Japan
 * time (UTC+9); the values are exposed exactly as stored.
 */
export interface Tod {
  seconds: number;
  minutes: number;
  hours: number;
  day: number;
  month: number;
  year: number;
}

export interface DirEntry {
  name: string;
  mode: number;
  /** Bytes for a file; number of entries (including "." and "..") for a directory. */
  length: number;
  created: Tod;
  modified: Tod;
  /** First data cluster (relative to allocOffset). 0xFFFFFFFF for empty files. */
  cluster: number;
  /** Index of this directory's entry in its parent (used by "." entries). */
  dirEntry: number;
  attr: number;
  /** Position of this entry within its directory. */
  index: number;
  /** The raw 512 bytes, kept so a rebuild can preserve fields we don't interpret. */
  raw: Uint8Array;
}

function parseTod(r: ByteReader, offset: number): Tod {
  return {
    seconds: r.u8(offset + 1),
    minutes: r.u8(offset + 2),
    hours: r.u8(offset + 3),
    day: r.u8(offset + 4),
    month: r.u8(offset + 5),
    year: r.u16(offset + 6),
  };
}

export function parseDirEntry(bytes: Uint8Array, index: number): DirEntry {
  const r = new ByteReader(bytes);
  return {
    mode: r.u16(0x00),
    length: r.u32(0x04),
    created: parseTod(r, 0x08),
    cluster: r.u32(0x10),
    dirEntry: r.u32(0x14),
    modified: parseTod(r, 0x18),
    attr: r.u32(0x20),
    name: r.cString(0x40, 32),
    index,
    raw: bytes.slice(0, DIRENT_SIZE),
  };
}

export const exists = (e: DirEntry) => (e.mode & Mode.EXISTS) !== 0;

export const isDir = (e: DirEntry) =>
  (e.mode & (Mode.FILE | Mode.DIR | Mode.EXISTS)) === (Mode.DIR | Mode.EXISTS);

export const isFile = (e: DirEntry) =>
  (e.mode & (Mode.FILE | Mode.DIR | Mode.EXISTS)) === (Mode.FILE | Mode.EXISTS);

/** How the PS2 browser labels a save's protection (mymc's do_dir). */
export type Protection = 'none' | 'copy' | 'delete' | 'copy-and-delete';

export function protectionOf(mode: number): Protection {
  const p = mode & (Mode.PROTECTED | Mode.WRITE);
  if (p === 0) return 'delete';
  if (p === Mode.WRITE) return 'none';
  if (p === Mode.PROTECTED) return 'copy-and-delete';
  return 'copy';
}
