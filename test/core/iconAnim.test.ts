import { describe, expect, it } from 'vitest';
import { ShapeBlender, animationFrame, type IconAnimation } from '../../src/core';

const close = (actual: Float32Array, expected: number[]) =>
  expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 3));

// Harry Potter: Prisoner of Azkaban's icon (a real save): 4 shapes, played
// 0 → 1 → 2 → 3 → 2 → 0, with some half-way keys.
const hp: IconAnimation = {
  frameLength: 131,
  speed: 1,
  playOffset: 0,
  frames: [
    { shapeId: 0, keys: [{ time: 8, value: 0.5 }, { time: 12, value: 0 }, { time: 88, value: 0 }, { time: 96, value: 1 }, { time: 130, value: 1 }] },
    { shapeId: 1, keys: [{ time: 8, value: 0.5 }, { time: 12, value: 1 }, { time: 24, value: 0 }] },
    { shapeId: 2, keys: [{ time: 24, value: 1 }, { time: 30, value: 0.5 }, { time: 36, value: 0 }, { time: 82, value: 0 }, { time: 88, value: 1 }, { time: 96, value: 0 }] },
    { shapeId: 3, keys: [{ time: 30, value: 0.5 }, { time: 36, value: 1 }, { time: 82, value: 1 }, { time: 88, value: 0 }] },
  ],
};

// The synthetic fixture icons: two shapes, 0 → 1 → 0 over 60 frames.
const pyramid: IconAnimation = {
  frameLength: 60,
  speed: 1,
  playOffset: 0,
  frames: [
    { shapeId: 0, keys: [{ time: 0, value: 1 }, { time: 30, value: 0 }] },
    { shapeId: 1, keys: [{ time: 0, value: 0 }, { time: 30, value: 1 }] },
  ],
};

describe('animationFrame', () => {
  it('runs at 60 frames per second and loops', () => {
    expect(animationFrame(hp, 1)).toBeCloseTo(60);
    expect(animationFrame(hp, 131 / 60 + 0.5)).toBeCloseTo(30);
  });

  it('applies speed and play offset', () => {
    expect(animationFrame({ ...pyramid, speed: 2 }, 0.25)).toBeCloseTo(30);
    expect(animationFrame({ ...pyramid, playOffset: 70 }, 0)).toBeCloseTo(10);
  });

  it('is 0 for static or missing animations', () => {
    expect(animationFrame(undefined, 5)).toBe(0);
    expect(animationFrame({ ...pyramid, frameLength: 1 }, 5)).toBe(0);
    expect(animationFrame({ ...pyramid, speed: Number.NaN }, 0.5)).toBeCloseTo(30);
  });
});

describe('ShapeBlender', () => {
  it('plays the real icon through its shapes', () => {
    const b = new ShapeBlender(hp, 4);
    expect(b.animated).toBe(true);
    close(b.weights(8), [0.5, 0.5, 0, 0]);
    close(b.weights(12), [0, 1, 0, 0]);
    close(b.weights(18), [0, 0.5, 0.5, 0]);
    close(b.weights(33), [0, 0, 0.25, 0.75]);
    close(b.weights(50), [0, 0, 0, 1]);
    close(b.weights(85), [0, 0, 0.5, 0.5]);
    close(b.weights(92), [0.5, 0, 0.5, 0]);
    close(b.weights(110), [1, 0, 0, 0]);
    // Wraps from the last key (130) to the first (8 + 131).
    close(b.weights(0), [1 - 0.5 / 9, 0.5 / 9, 0, 0]);
  });

  it('always sums to 1', () => {
    const b = new ShapeBlender(hp, 4);
    for (let f = 0; f < 131; f += 0.7) {
      expect(b.weights(f).reduce((a, v) => a + v, 0)).toBeCloseTo(1, 5);
    }
  });

  it('ping-pongs the fixture pyramids', () => {
    const b = new ShapeBlender(pyramid, 2);
    close(b.weights(0), [1, 0]);
    close(b.weights(15), [0.5, 0.5]);
    close(b.weights(30), [0, 1]);
    close(b.weights(45), [0.5, 0.5]);
  });

  it('loops shape to shape when there are no usable keys', () => {
    const b = new ShapeBlender({ frameLength: 90, speed: 1, playOffset: 0, frames: [] }, 3);
    expect(b.animated).toBe(true);
    close(b.weights(0), [1, 0, 0]);
    close(b.weights(45), [0, 0.5, 0.5]);
    close(b.weights(75), [0.5, 0, 0.5]);
  });

  it('holds a single shape still', () => {
    const b = new ShapeBlender({ frameLength: 1, speed: 1, playOffset: 0, frames: [{ shapeId: 0, keys: [] }] }, 1);
    expect(b.animated).toBe(false);
    close(b.weights(0), [1]);
    expect(new ShapeBlender(undefined, 3).weights(10)).toEqual(new Float32Array([1, 0, 0]));
  });

  it('ignores bad keys and shape ids', () => {
    const b = new ShapeBlender(
      {
        frameLength: 60,
        speed: 1,
        playOffset: 0,
        frames: [
          { shapeId: 9, keys: [{ time: 0, value: 1 }] },
          { shapeId: 0, keys: [{ time: Number.NaN, value: 1 }, { time: 0, value: 1 }] },
          { shapeId: 1, keys: [{ time: 30, value: Number.POSITIVE_INFINITY }, { time: 30, value: 1 }] },
        ],
      },
      2,
    );
    for (let f = 0; f < 60; f += 3) {
      const w = b.weights(f);
      expect(w.every(Number.isFinite)).toBe(true);
      expect(w[0]! + w[1]!).toBeCloseTo(1, 5);
    }
  });
});
