import type { IconAnimation } from './icon';

/** Animation frames per second. The PS2 runs icon animations at the video rate. */
export const ICON_FPS = 60;

/** The animation frame (fractional, in [0, frameLength)) at a time in seconds. */
export function animationFrame(anim: IconAnimation | undefined, seconds: number): number {
  if (!anim || !(anim.frameLength > 1)) return 0;
  const speed = Number.isFinite(anim.speed) && anim.speed > 0 ? anim.speed : 1;
  const f = seconds * ICON_FPS * speed + anim.playOffset;
  const len = anim.frameLength;
  return ((f % len) + len) % len;
}

/**
 * Turns an icon's animation into per-shape blend weights.
 *
 * Each animation frame lists keys (time, weight) for one shape. Read as steps
 * (a shape keeps its last key's weight until its next key, wrapping around the
 * loop), the weights add up to 1 at every moment in real icons. So we take the
 * step weights at each key time and blend linearly from one key time to the
 * next, which gives a smooth loop through the shapes the game intended.
 *
 * Icons without usable keys fall back to looping through the shapes in order,
 * like ps2mc-browser does.
 */
export class ShapeBlender {
  private readonly times: number[] = [];
  private readonly steps: Float32Array[] = [];
  private readonly out: Float32Array;

  constructor(
    private readonly anim: IconAnimation | undefined,
    private readonly shapeCount: number,
  ) {
    this.out = new Float32Array(shapeCount);
    if (!anim || shapeCount < 2 || !(anim.frameLength > 1)) return;
    const len = anim.frameLength;

    const frames = anim.frames
      .filter((f) => f.shapeId < shapeCount)
      .map((f) => ({
        shape: f.shapeId,
        keys: f.keys
          .filter((k) => Number.isFinite(k.time) && Number.isFinite(k.value))
          .map((k) => ({ time: ((k.time % len) + len) % len, value: Math.max(k.value, 0) }))
          .sort((a, b) => a.time - b.time),
      }))
      .filter((f) => f.keys.length > 0);

    const times = [...new Set(frames.flatMap((f) => f.keys.map((k) => k.time)))].sort((a, b) => a - b);
    for (const t of times) {
      const w = new Float32Array(shapeCount);
      for (const f of frames) {
        // Last key at or before t; before the first key, the last one (wrapping).
        let key = f.keys[f.keys.length - 1]!;
        for (const k of f.keys) {
          if (k.time <= t) key = k;
          else break;
        }
        w[f.shape]! += key.value;
      }
      const sum = w.reduce((a, b) => a + b, 0);
      if (!(sum > 1e-6)) continue;
      for (let i = 0; i < shapeCount; i++) w[i]! /= sum;
      this.times.push(t);
      this.steps.push(w);
    }
  }

  /** Whether the shapes change over time at all. */
  get animated(): boolean {
    if (this.shapeCount < 2 || !this.anim || !(this.anim.frameLength > 1)) return false;
    if (this.times.length === 0) return true; // fallback loop
    return this.steps.some((w) => w.some((v, i) => Math.abs(v - this.steps[0]![i]!) > 1e-6));
  }

  /** Blend weights for each shape at an animation frame. The returned array is reused. */
  weights(frame: number): Float32Array {
    const out = this.out;
    out.fill(0);
    if (this.shapeCount < 2 || !this.anim || !(this.anim.frameLength > 1)) {
      if (this.shapeCount > 0) out[0] = 1;
      return out;
    }
    const len = this.anim.frameLength;

    if (this.times.length === 0) {
      // Fallback: shape i morphs into i + 1, looping.
      const pos = (frame / len) * this.shapeCount;
      const i = Math.floor(pos) % this.shapeCount;
      const t = pos - Math.floor(pos);
      out[i] = 1 - t;
      out[(i + 1) % this.shapeCount]! += t;
      return out;
    }

    const n = this.times.length;
    // Find the key time at or before the frame, wrapping before the first.
    let k = n - 1;
    for (let i = 0; i < n; i++) {
      if (this.times[i]! <= frame) k = i;
      else break;
    }
    const next = (k + 1) % n;
    let from = this.times[k]!;
    let to = this.times[next]!;
    let f = frame;
    if (from > f) from -= len; // wrapped: frame is before the first key time
    if (to <= from) to += len;
    if (f < from) f += len;
    const t = to > from ? Math.min(Math.max((f - from) / (to - from), 0), 1) : 0;
    const a = this.steps[k]!;
    const b = this.steps[next]!;
    for (let i = 0; i < this.shapeCount; i++) out[i] = a[i]! * (1 - t) + b[i]! * t;
    return out;
  }
}
