import { ByteReader } from './binary';
import { CardError } from './errors';

// PS2 3D icon (.ico). Layout from mymc++'s ps2icon.py and ps2mc-browser's icon.py,
// which agree. All coordinates are fixed point: divide by 4096.

const ICON_MAGIC = 0x010000;
const ANIM_MAGIC = 0x01;
const FIXED = 4096;
export const TEXTURE_SIZE = 128;
const TEXTURE_BYTES = TEXTURE_SIZE * TEXTURE_SIZE * 2;

// Real icons have a few hundred to a few thousand vertices and a handful of shapes.
// Generous caps that still stop a damaged header from allocating gigabytes.
const MAX_VERTICES = 1 << 16;
const MAX_SHAPES = 64;
const MAX_FRAMES = 1024;
const MAX_KEYS = 1024;

export interface IconKey {
  time: number;
  value: number;
}

export interface IconFrame {
  shapeId: number;
  keys: IconKey[];
}

export interface IconAnimation {
  /** Length of one animation loop, in frames (60 per second). */
  frameLength: number;
  speed: number;
  playOffset: number;
  frames: IconFrame[];
}

export interface IconModel {
  vertexCount: number;
  /** Morph targets: one xyz array per shape (vertexCount * 3). */
  shapes: Float32Array[];
  normals: Float32Array;
  uvs: Float32Array;
  /** Per-vertex RGBA, 0-255 (0x80 is "full" on the PS2). */
  colors: Uint8Array;
  textureType: number;
  animation?: IconAnimation;
  /** 128x128 RGBA (row 0 first), when the icon has a texture. */
  texture?: Uint8Array;
  /** Set when the file ended early; whatever came before is still usable. */
  warning?: string;
}

function iconError(msg: string): CardError {
  return new CardError('bad-icon', `Icon file is damaged: ${msg}.`);
}

/** A1B5G5R5 pixels to RGBA8 (alpha forced opaque, as the PS2 browser draws them). */
export function decodeTexture(pixels: Uint8Array): Uint8Array {
  const out = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let i = 0; i < TEXTURE_SIZE * TEXTURE_SIZE; i++) {
    const v = pixels[i * 2]! | (pixels[i * 2 + 1]! << 8);
    const r = v & 0x1f;
    const g = (v >> 5) & 0x1f;
    const b = (v >> 10) & 0x1f;
    out[i * 4] = (r << 3) | (r >> 2);
    out[i * 4 + 1] = (g << 3) | (g >> 2);
    out[i * 4 + 2] = (b << 3) | (b >> 2);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Undo the icon texture RLE. Returns the raw 32 KB A1B5G5R5 texture. */
export function decompressTexture(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(TEXTURE_BYTES);
  let o = 0;
  let i = 0;
  while (i + 1 < data.length) {
    const code = data[i]! | (data[i + 1]! << 8);
    i += 2;
    if (code & 0x8000) {
      // Copy the next (0x10000 - code) 16-bit pixels as they are.
      const len = (0x10000 - code) * 2;
      if (i + len > data.length) throw iconError('compressed texture is cut short');
      if (o + len > TEXTURE_BYTES) throw iconError('compressed texture is larger than 128x128');
      out.set(data.subarray(i, i + len), o);
      i += len;
      o += len;
    } else if (code > 0) {
      // Repeat the next pixel `code` times.
      if (i + 2 > data.length) throw iconError('compressed texture is cut short');
      if (o + code * 2 > TEXTURE_BYTES) throw iconError('compressed texture is larger than 128x128');
      for (let k = 0; k < code; k++) {
        out[o++] = data[i]!;
        out[o++] = data[i + 1]!;
      }
      i += 2;
    }
  }
  return out;
}

export function parseIcon(bytes: Uint8Array): IconModel {
  const r = new ByteReader(bytes);
  if (bytes.length < 20) throw iconError('file is too small');
  if (r.u32(0) !== ICON_MAGIC) throw iconError('wrong signature');
  const shapeCount = r.u32(4);
  const textureType = r.u32(8);
  const vertexCount = r.u32(16);
  if (shapeCount < 1 || shapeCount > MAX_SHAPES) throw iconError(`${shapeCount} animation shapes`);
  if (vertexCount > MAX_VERTICES) throw iconError(`${vertexCount} vertices`);

  const stride = shapeCount * 8 + 8 + 4 + 4;
  if (20 + vertexCount * stride > bytes.length) throw iconError('vertex data is cut short');

  const shapes = Array.from({ length: shapeCount }, () => new Float32Array(vertexCount * 3));
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = new Uint8Array(vertexCount * 4);
  let o = 20;
  for (let v = 0; v < vertexCount; v++) {
    for (let s = 0; s < shapeCount; s++) {
      const pos = shapes[s]!;
      pos[v * 3] = r.i16(o) / FIXED;
      pos[v * 3 + 1] = r.i16(o + 2) / FIXED;
      pos[v * 3 + 2] = r.i16(o + 4) / FIXED;
      o += 8;
    }
    normals[v * 3] = r.i16(o) / FIXED;
    normals[v * 3 + 1] = r.i16(o + 2) / FIXED;
    normals[v * 3 + 2] = r.i16(o + 4) / FIXED;
    uvs[v * 2] = r.i16(o + 8) / FIXED;
    uvs[v * 2 + 1] = r.i16(o + 10) / FIXED;
    colors.set(bytes.subarray(o + 12, o + 16), v * 4);
    o += 16;
  }

  const model: IconModel = { vertexCount, shapes, normals, uvs, colors, textureType };

  // Everything after the vertices is optional: some games ship icons that end early.
  try {
    if (o + 20 > bytes.length) throw iconError('animation header is missing');
    if (r.u32(o) !== ANIM_MAGIC) throw iconError('bad animation header');
    const frameCount = r.u32(o + 16);
    if (frameCount > MAX_FRAMES) throw iconError(`${frameCount} animation frames`);
    const animation: IconAnimation = {
      frameLength: r.u32(o + 4),
      speed: r.f32(o + 8),
      playOffset: r.u32(o + 12),
      frames: [],
    };
    o += 20;
    for (let f = 0; f < frameCount; f++) {
      const shapeId = r.u32(o);
      // The stored count is one more than the keys that follow (both references agree).
      const keyCount = Math.max(r.u32(o + 4) - 1, 0);
      if (keyCount > MAX_KEYS) throw iconError(`${keyCount} keys in a frame`);
      o += 16;
      const keys: IconKey[] = [];
      for (let k = 0; k < keyCount; k++) {
        keys.push({ time: r.f32(o), value: r.f32(o + 4) });
        o += 8;
      }
      animation.frames.push({ shapeId, keys });
    }
    model.animation = animation;

    // Bit 2: has a texture. Bit 3: texture is RLE compressed.
    if ((textureType & 0x04) !== 0 && o < bytes.length) {
      if ((textureType & 0x08) !== 0) {
        const size = r.u32(o);
        model.texture = decodeTexture(decompressTexture(r.slice(o + 4, size)));
      } else {
        model.texture = decodeTexture(r.slice(o, TEXTURE_BYTES));
      }
    }
  } catch (e) {
    if (!(e instanceof CardError)) throw e;
    model.warning = e.message;
  }
  return model;
}
