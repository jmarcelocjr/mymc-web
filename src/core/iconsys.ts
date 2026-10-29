import { ByteReader, decodeShiftJis } from './binary';
import { CardError } from './errors';

export const ICON_SYS_SIZE = 964;

export type Vec4 = [number, number, number, number];

export interface SaveTitle {
  /** The two lines as decoded from Shift-JIS (full-width characters kept). */
  lines: [string, string];
  /** NFKC-normalized for display and search (full-width ASCII becomes plain ASCII). */
  display: [string, string];
  raw: Uint8Array;
}

export interface IconSys {
  title: SaveTitle;
  backgroundTransparency: number;
  /** Background gradient corners: top-left, top-right, bottom-left, bottom-right. RGBA 0-255. */
  backgroundColors: [Vec4, Vec4, Vec4, Vec4];
  lightDirections: [Vec4, Vec4, Vec4];
  lightColors: [Vec4, Vec4, Vec4];
  ambientLight: Vec4;
  /** Icon file names for each browser state. Often all the same file. */
  icons: { normal: string; copy: string; delete: string };
}

export function makeTitle(raw: Uint8Array, breakOffset: number): SaveTitle {
  const at = Math.min(Math.max(breakOffset, 0), raw.length);
  const lines: [string, string] = [decodeShiftJis(raw.subarray(0, at)), decodeShiftJis(raw.subarray(at))];
  return {
    lines,
    display: [lines[0].normalize('NFKC'), lines[1].normalize('NFKC')],
    raw,
  };
}

/** Parse icon.sys. Layout from mymc's ps2iconsys.py. */
export function parseIconSys(bytes: Uint8Array): IconSys {
  if (bytes.length < ICON_SYS_SIZE) {
    throw new CardError('bad-icon-sys', `icon.sys is ${bytes.length} bytes (expected ${ICON_SYS_SIZE}).`);
  }
  const r = new ByteReader(bytes);
  if (r.cString(0, 4) !== 'PS2D') {
    throw new CardError('bad-icon-sys', 'icon.sys has the wrong signature.');
  }
  const u32x4 = (o: number): Vec4 => [r.u32(o), r.u32(o + 4), r.u32(o + 8), r.u32(o + 12)];
  const f32x4 = (o: number): Vec4 => [r.f32(o), r.f32(o + 4), r.f32(o + 8), r.f32(o + 12)];

  return {
    title: makeTitle(r.cBytes(0xc0, 68), r.u16(0x06)),
    backgroundTransparency: r.u32(0x0c),
    backgroundColors: [u32x4(0x10), u32x4(0x20), u32x4(0x30), u32x4(0x40)],
    lightDirections: [f32x4(0x50), f32x4(0x60), f32x4(0x70)],
    lightColors: [f32x4(0x80), f32x4(0x90), f32x4(0xa0)],
    ambientLight: f32x4(0xb0),
    icons: {
      normal: r.cString(0x104, 64),
      copy: r.cString(0x144, 64),
      delete: r.cString(0x184, 64),
    },
  };
}

/**
 * Title of a PS1 save stored on a PS2 card: the save file (named like its
 * directory) starts with a 128-byte header, magic "SC" then a 64-byte
 * Shift-JIS title at offset 4.
 */
export function parsePs1Title(saveFile: Uint8Array): SaveTitle | undefined {
  if (saveFile.length < 128 || saveFile[0] !== 0x53 || saveFile[1] !== 0x43) return undefined;
  const r = new ByteReader(saveFile);
  const raw = r.cBytes(4, 64);
  return makeTitle(raw, raw.length);
}
