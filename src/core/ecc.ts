// Hamming code used in the spare area of each memory card page.
// Port of mymc's ps2mc_ecc.py: 3 ECC bytes for every 128 data bytes.

export const ECC_CHUNK = 128;

export type EccStatus = 'ok' | 'corrected' | 'failed';

const parityTable = new Uint8Array(256);
const columnParityMasks = new Uint8Array(256);

(function buildTables() {
  for (let b = 0; b < 256; b++) {
    let a = b ^ (b >> 1);
    a ^= a >> 2;
    a ^= a >> 4;
    parityTable[b] = a & 1;
  }
  const cpmasks = [0x55, 0x33, 0x0f, 0x00, 0xaa, 0xcc, 0xf0];
  for (let b = 0; b < 256; b++) {
    let mask = 0;
    for (let i = 0; i < cpmasks.length; i++) {
      mask |= parityTable[b & cpmasks[i]!]! << i;
    }
    columnParityMasks[b] = mask;
  }
})();

/** ECC for one 128-byte chunk starting at `offset`. */
export function eccChunk(data: Uint8Array, offset = 0): [number, number, number] {
  let columnParity = 0x77;
  let lineParity0 = 0x7f;
  let lineParity1 = 0x7f;
  for (let i = 0; i < ECC_CHUNK; i++) {
    const b = data[offset + i]!;
    columnParity ^= columnParityMasks[b]!;
    if (parityTable[b]) {
      lineParity0 ^= ~i;
      lineParity1 ^= i;
    }
  }
  return [columnParity, lineParity0 & 0x7f, lineParity1];
}

/** The spare area for a page: 3 ECC bytes per 128-byte chunk, zero padded to `spareSize`. */
export function eccSpare(page: Uint8Array, spareSize = 16): Uint8Array {
  const spare = new Uint8Array(spareSize);
  const chunks = Math.ceil(page.length / ECC_CHUNK);
  for (let c = 0; c < chunks; c++) {
    spare.set(eccChunk(page, c * ECC_CHUNK), c * 3);
  }
  return spare;
}

function popcount(a: number): number {
  let n = 0;
  while (a) {
    a &= a - 1;
    n++;
  }
  return n;
}

/** Check one chunk against its stored ECC (mymc's ecc_check, without repairing). */
export function eccCheckChunk(data: Uint8Array, offset: number, ecc: ArrayLike<number>): EccStatus {
  const [c0, c1, c2] = eccChunk(data, offset);
  if (c0 === ecc[0] && c1 === ecc[1] && c2 === ecc[2]) return 'ok';

  const cpDiff = (c0 ^ ecc[0]!) & 0x77;
  const lp0Diff = (c1 ^ ecc[1]!) & 0x7f;
  const lp1Diff = (c2 ^ ecc[2]!) & 0x7f;
  const lpComp = lp0Diff ^ lp1Diff;
  const cpComp = (cpDiff >> 4) ^ (cpDiff & 0x07);

  if (lpComp === 0x7f && cpComp === 0x07) return 'corrected'; // single bit error in the data
  if ((cpDiff === 0 && lp0Diff === 0 && lp1Diff === 0) || popcount(lpComp) + popcount(cpComp) === 1) {
    return 'corrected'; // single bit error in the ECC itself
  }
  return 'failed';
}

/** Check a whole page (data + spare). The worst chunk result wins. */
export function eccCheckPage(page: Uint8Array, spare: Uint8Array): EccStatus {
  let result: EccStatus = 'ok';
  const chunks = Math.ceil(page.length / ECC_CHUNK);
  for (let c = 0; c < chunks; c++) {
    const status = eccCheckChunk(page, c * ECC_CHUNK, spare.subarray(c * 3, c * 3 + 3));
    if (status === 'failed') return 'failed';
    if (status === 'corrected') result = 'corrected';
  }
  return result;
}
