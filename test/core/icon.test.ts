import { describe, expect, it } from 'vitest';
import { CardError, decompressTexture, openCard, parseIcon } from '../../src/core';
import { loadCard } from '../helpers/fixtures';

// The synthetic icons from make_fixtures.py: a 2-shape pyramid (18 vertices),
// one animation frame per shape with 2 keys, and a two-color checkerboard texture.
const card = openCard(loadCard('multi-8mb'));
const read = (path: string) => card.readFile(path);

describe('.ico parser', () => {
  const plain = parseIcon(read('/BASLUS-00001SYNTH/icon.ico'));
  const compressed = parseIcon(read('/BISLPS-00002JPTEST/jp.ico'));

  it('reads geometry and morph shapes', () => {
    expect(plain.vertexCount).toBe(18);
    expect(plain.shapes).toHaveLength(2);
    // The apex of the pyramid: (0, -1) in shape 0 and (0, -1.6) in shape 1.
    expect(plain.shapes[0]!.slice(0, 3)).toEqual(new Float32Array([0, -1, 0]));
    expect(plain.shapes[1]![1]).toBeCloseTo(-1.6, 3);
    expect(plain.uvs.length).toBe(36);
    expect(plain.warning).toBeUndefined();
  });

  it('reads the animation', () => {
    expect(plain.animation).toEqual({
      frameLength: 60,
      speed: 1,
      playOffset: 0,
      frames: [
        { shapeId: 0, keys: [{ time: 0, value: 1 }, { time: 30, value: 0 }] },
        { shapeId: 1, keys: [{ time: 0, value: 0 }, { time: 30, value: 1 }] },
      ],
    });
  });

  it('decodes plain and RLE-compressed textures', () => {
    for (const icon of [plain, compressed]) {
      expect(icon.texture).toHaveLength(128 * 128 * 4);
      const tex = icon.texture!;
      const px = (x: number, y: number) => Array.from(tex.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 4));
      // 16x16 checkerboard of two colors, fully opaque.
      expect(px(0, 0)).toEqual(px(32, 0));
      expect(px(0, 0)).not.toEqual(px(16, 0));
      expect(px(16, 16)).toEqual(px(0, 0));
      expect(px(5, 5)[3]).toBe(255);
    }
  });

  it('keeps the geometry when the file ends early', () => {
    const bytes = read('/BASLUS-00001SYNTH/icon.ico');
    const cut = parseIcon(bytes.subarray(0, 20 + 18 * 32 + 10));
    expect(cut.vertexCount).toBe(18);
    expect(cut.texture).toBeUndefined();
    expect(cut.warning).toMatch(/animation/);
  });

  it('rejects damaged headers', () => {
    const bytes = read('/BASLUS-00001SYNTH/icon.ico');
    expect(() => parseIcon(bytes.subarray(0, 100))).toThrow(CardError);
    const bad = bytes.slice();
    bad[0] = 9;
    expect(() => parseIcon(bad)).toThrow(/signature/);
    const huge = bytes.slice();
    new DataView(huge.buffer).setUint32(16, 0x7fffffff, true);
    expect(() => parseIcon(huge)).toThrow(/vertices/);
  });

  it('rejects RLE data that overflows or ends early', () => {
    // Repeat one pixel 16385 times: one more than a 128x128 texture holds.
    expect(() => decompressTexture(new Uint8Array([0x01, 0x40, 0xaa, 0xbb]))).toThrow(/larger than 128x128/);
    // Promise 4 literal pixels (0x10000 - 0xfffc), deliver 1.
    expect(() => decompressTexture(new Uint8Array([0xfc, 0xff, 1, 2]))).toThrow(/cut short/);
    // A repeat run followed by a literal run decodes in order.
    const out = decompressTexture(new Uint8Array([0x02, 0x00, 0x11, 0x22, 0xff, 0xff, 0x33, 0x44]));
    expect(Array.from(out.subarray(0, 6))).toEqual([0x11, 0x22, 0x11, 0x22, 0x33, 0x44]);
  });
});
