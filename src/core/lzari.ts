import { CardError } from './errors';

// LZARI decompression (Haruhiko Okumura's LZ77 + adaptive arithmetic coding),
// ported from mymc's lzari.py, the variant used by Action Replay MAX saves.
// The constants are part of the format: changing any breaks compatibility.

const HIST_LEN = 4096;
const MIN_MATCH_LEN = 3;
const MAX_MATCH_LEN = 60;
const ARITH_BITS = 15;
const QUADRANT1 = 1 << ARITH_BITS;
const QUADRANT2 = QUADRANT1 * 2;
const QUADRANT3 = QUADRANT1 * 3;
const QUADRANT4 = QUADRANT1 * 4;
const MAX_CUM = QUADRANT1 - 1;
const MAX_CHAR = 256 + MAX_MATCH_LEN - MIN_MATCH_LEN + 1;

/** Position model: fixed, favoring recent positions. */
const POSITION_CUM = (() => {
  const t = new Int32Array(HIST_LEN + 1);
  let a = 0;
  for (let i = HIST_LEN; i > 0; i--) {
    a += Math.floor(10000 / (200 + i));
    t[i - 1] = a;
  }
  return t;
})();

const corrupt = () => new CardError('bad-save-file', 'The compressed save data is damaged.');

/** Decompress LZARI data to exactly `outLength` bytes. Throws CardError on damaged input. */
export function lzariDecode(src: Uint8Array, outLength: number): Uint8Array {
  const out = new Uint8Array(outLength);
  if (outLength === 0) return out;

  // Input bits, most significant first, followed by 32 zero bits (as mymc does).
  const totalBits = src.length * 8 + 32;
  let bitPos = 0;
  const bit = (): number => {
    if (bitPos >= totalBits) throw corrupt();
    const i = bitPos++;
    return i < src.length * 8 ? (src[i >> 3]! >> (7 - (i & 7))) & 1 : 0;
  };

  // Adaptive character model. sym_cum is kept increasing for a binary search.
  const symCum = new Int32Array(MAX_CHAR + 1);
  for (let i = 0; i <= MAX_CHAR; i++) symCum[i] = i;
  const symFreq = new Int32Array(MAX_CHAR + 1).fill(1);
  symFreq[0] = 0;
  const symbolToChar = new Int32Array(MAX_CHAR + 1);
  for (let i = 1; i <= MAX_CHAR; i++) symbolToChar[i] = i - 1;

  let high = QUADRANT4;
  let low = 0;
  let code = 0;
  for (let i = 0; i < ARITH_BITS + 2; i++) code = code * 2 + bit();

  const normalize = () => {
    for (;;) {
      if (low < QUADRANT2) {
        if (low < QUADRANT1 || high > QUADRANT3) {
          if (high > QUADRANT2) return;
        } else {
          low -= QUADRANT1;
          code -= QUADRANT1;
          high -= QUADRANT1;
        }
      } else {
        low -= QUADRANT2;
        code -= QUADRANT2;
        high -= QUADRANT2;
      }
      low *= 2;
      high *= 2;
      code = code * 2 + bit();
    }
  };

  const updateModel = (symbol: number) => {
    if (symCum[MAX_CHAR]! >= MAX_CUM) {
      let c = 0;
      for (let i = MAX_CHAR; i > 0; i--) {
        symCum[MAX_CHAR - i] = c;
        const a = (symFreq[i]! + 1) >> 1;
        symFreq[i] = a;
        c += a;
      }
      symCum[MAX_CHAR] = c;
    }
    const freq = symFreq[symbol]!;
    let newSymbol = symbol;
    while (symFreq[newSymbol - 1] === freq) newSymbol--;
    if (newSymbol !== symbol) {
      const swap = symbolToChar[newSymbol]!;
      symbolToChar[newSymbol] = symbolToChar[symbol]!;
      symbolToChar[symbol] = swap;
    }
    symFreq[newSymbol] = freq + 1;
    for (let i = MAX_CHAR - newSymbol + 1; i <= MAX_CHAR; i++) symCum[i]!++;
  };

  const decodeChar = (): number => {
    const range = high - low;
    const maxCum = symCum[MAX_CHAR]!;
    if (range <= 0 || maxCum <= 0) throw corrupt();
    const n = Math.floor(((code - low + 1) * maxCum - 1) / range);
    // bisect_right(sym_cum, n, lo=1): first i >= 1 with sym_cum[i] > n.
    let lo = 1;
    let hi = MAX_CHAR + 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (symCum[mid]! <= n) lo = mid + 1;
      else hi = mid;
    }
    const i = lo;
    if (i > MAX_CHAR) throw corrupt();
    high = low + Math.floor((symCum[i]! * range) / maxCum);
    low += Math.floor((symCum[i - 1]! * range) / maxCum);
    const symbol = MAX_CHAR + 1 - i;
    normalize();
    const ch = symbolToChar[symbol]!;
    updateModel(symbol);
    return ch;
  };

  const decodePosition = (): number => {
    const range = high - low;
    const maxCum = POSITION_CUM[0]!;
    if (range <= 0) throw corrupt();
    const x = Math.floor(((code - low + 1) * maxCum - 1) / range);
    // mymc's search() over the decreasing position table.
    let c = 1;
    let s = POSITION_CUM.length - 1;
    for (;;) {
      const a = (s + c) >> 1;
      if (POSITION_CUM[a]! <= x) s = a;
      else c = a + 1;
      if (c >= s) break;
    }
    const pos = c - 1;
    if (pos < 0 || pos >= HIST_LEN) throw corrupt();
    high = low + Math.floor((POSITION_CUM[pos]! * range) / maxCum);
    low += Math.floor((POSITION_CUM[pos + 1]! * range) / maxCum);
    normalize();
    return pos;
  };

  const history = new Uint8Array(HIST_LEN);
  let histPos = HIST_LEN - MAX_MATCH_LEN;
  history.fill(0x20, 0, histPos);
  let outPos = 0;
  while (outPos < outLength) {
    const ch = decodeChar();
    if (ch >= 0x100) {
      const pos = decodePosition();
      const length = ch - 0x100 + MIN_MATCH_LEN;
      const base = (((histPos - pos - 1) % HIST_LEN) + HIST_LEN) % HIST_LEN;
      for (let off = 0; off < length; off++) {
        if (outPos >= outLength) throw corrupt();
        const a = history[(base + off) % HIST_LEN]!;
        out[outPos++] = a;
        history[histPos] = a;
        histPos = (histPos + 1) % HIST_LEN;
      }
    } else {
      out[outPos++] = ch;
      history[histPos] = ch;
      histPos = (histPos + 1) % HIST_LEN;
    }
  }
  return out;
}
