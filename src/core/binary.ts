import { CardError } from './errors';

/** Little-endian reads with bounds checks. */
export class ByteReader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.length;
  }

  private check(offset: number, size: number): void {
    if (offset < 0 || offset + size > this.bytes.length) {
      throw new CardError('out-of-bounds', `Read of ${size} bytes at ${offset} is past the end (${this.bytes.length})`);
    }
  }

  u8(offset: number): number {
    this.check(offset, 1);
    return this.view.getUint8(offset);
  }

  u16(offset: number): number {
    this.check(offset, 2);
    return this.view.getUint16(offset, true);
  }

  i16(offset: number): number {
    this.check(offset, 2);
    return this.view.getInt16(offset, true);
  }

  u32(offset: number): number {
    this.check(offset, 4);
    return this.view.getUint32(offset, true);
  }

  f32(offset: number): number {
    this.check(offset, 4);
    return this.view.getFloat32(offset, true);
  }

  slice(offset: number, length: number): Uint8Array {
    this.check(offset, length);
    return this.bytes.subarray(offset, offset + length);
  }

  /** Bytes up to the first NUL, within a fixed-size field. */
  cBytes(offset: number, maxLength: number): Uint8Array {
    const field = this.slice(offset, maxLength);
    const end = field.indexOf(0);
    return end === -1 ? field : field.subarray(0, end);
  }

  /** ASCII string up to the first NUL. Non-ASCII bytes come through as Latin-1. */
  cString(offset: number, maxLength: number): string {
    return latin1(this.cBytes(offset, maxLength));
  }
}

export function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

const sjis = new TextDecoder('shift_jis');

export function decodeShiftJis(bytes: Uint8Array): string {
  return sjis.decode(bytes);
}
