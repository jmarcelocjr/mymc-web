import { describe, expect, it } from 'vitest';
import { CardError, openCard } from '../../src/core';
import { loadCard, loadGolden } from '../helpers/fixtures';

// Damage is applied to the no-ECC card, where cluster n sits at byte n * 1024.
// Offsets are worked out here from the raw bytes, independently of the reader.
const CARD = 'no-ecc-8mb';
const golden = loadGolden(CARD);
const ALLOC_OFFSET = golden.superblock.alloc_offset as number;
const SAVE = 'BASLUS-00001SYNTH';

const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true);
const setU32 = (b: Uint8Array, o: number, v: number) => new DataView(b.buffer, b.byteOffset).setUint32(o, v, true);
const setU16 = (b: Uint8Array, o: number, v: number) => new DataView(b.buffer, b.byteOffset).setUint16(o, v, true);

/** Byte offset of FAT entry n. */
function fatOffset(b: Uint8Array, n: number): number {
  const indirect = u32(b, 0x50);
  const fatCluster = u32(b, indirect * 1024 + Math.floor(n / 256) * 4);
  return fatCluster * 1024 + (n % 256) * 4;
}

/** Byte offset of the nth directory entry named `name` (entries are 512-byte aligned, name at 0x40). */
function direntOffset(b: Uint8Array, name: string, nth = 0): number {
  const want = new TextEncoder().encode(name + '\0');
  let seen = 0;
  for (let o = ALLOC_OFFSET * 1024; o < b.length; o += 512) {
    if (want.every((c, i) => b[o + 0x40 + i] === c) && (b[o + 1]! & 0x80) !== 0) { // mode & 0x8000 (exists)
      if (seen++ === nth) return o;
    }
  }
  throw new Error(`dirent ${name} not found`);
}

const goldenSave = golden.root.find((e) => e.name === SAVE)!;
const dataFile = goldenSave.children!.find((e) => e.name === SAVE)!; // 5000 bytes, 5 clusters

function expectProblem(bytes: Uint8Array, code: string, pathEnd: string) {
  const card = openCard(bytes);
  const save = card.listSaves().find((s) => s.name === SAVE)!;
  expect(save.readable).toBe(false);
  expect(save.problem).toMatchObject({ code });
  expect(save.problem!.path.endsWith(pathEnd)).toBe(true);
  // The rest of the card is still readable.
  expect(card.listSaves().filter((s) => s.name !== SAVE).every((s) => s.readable)).toBe(true);
  expect(card.problems()).toHaveLength(1);
  return card;
}

describe('damaged cards', () => {
  it('detects a loop in a FAT chain', () => {
    const b = loadCard(CARD);
    const first = dataFile.cluster;
    const second = u32(b, fatOffset(b, first)) & 0x7fffffff;
    setU32(b, fatOffset(b, second), 0x80000000 | first); // second -> first
    const card = expectProblem(b, 'fat-cycle', `${SAVE}/${SAVE}`);
    expect(() => card.readFile(`/${SAVE}/${SAVE}`)).toThrow(CardError);
  });

  it('detects a chain that runs into a free cluster', () => {
    const b = loadCard(CARD);
    setU32(b, fatOffset(b, dataFile.cluster), 0x7fffffff);
    expectProblem(b, 'bad-chain', `${SAVE}/${SAVE}`);
  });

  it('detects a cluster outside the card', () => {
    const b = loadCard(CARD);
    setU32(b, direntOffset(b, SAVE, 1) + 0x10, 0x00ffffff); // the data file's first cluster
    expectProblem(b, 'out-of-bounds', `${SAVE}/${SAVE}`);
  });

  it('rejects an absurd directory length without trying to read it', () => {
    const b = loadCard(CARD);
    setU32(b, direntOffset(b, SAVE, 0) + 0x04, 0x7fffffff);
    expectProblem(b, 'bad-chain', SAVE);
  });

  it('stops a directory that contains itself', () => {
    const b = loadCard(CARD);
    const dir = direntOffset(b, SAVE, 0);
    const ico = direntOffset(b, 'icon.ico', 0);
    setU16(b, ico, 0x8427); // turn icon.ico into a directory...
    setU32(b, ico + 0x04, u32(b, dir + 0x04)); // ...pointing back at the save itself
    setU32(b, ico + 0x10, u32(b, dir + 0x10));
    expectProblem(b, 'too-deep', 'icon.ico');
  });

  it('refuses a card whose root directory is damaged', () => {
    const b = loadCard(CARD);
    b[ALLOC_OFFSET * 1024 + 0x40] = 0x58; // "." -> "X"
    expect(() => openCard(b)).toThrow(expect.objectContaining({ code: 'bad-directory' }));
  });

  it('refuses a file that is not a memory card', () => {
    const b = loadCard(CARD);
    b[0] = 0x58;
    expect(() => openCard(b)).toThrow(expect.objectContaining({ code: 'not-a-card' }));
    expect(() => openCard(new Uint8Array(100))).toThrow(expect.objectContaining({ code: 'not-a-card' }));
  });

  it('refuses a truncated card', () => {
    const b = loadCard('one-save-8mb');
    expect(() => openCard(b.subarray(0, b.length - 528))).toThrow(expect.objectContaining({ code: 'bad-size' }));
  });

  it('refuses a size that disagrees with the superblock', () => {
    const b = loadCard('one-save-8mb');
    setU32(b, 0x30, 16384); // claims 16 MB
    expect(() => openCard(b)).toThrow(expect.objectContaining({ code: 'bad-size' }));
  });

  it('refuses nonsense superblock values', () => {
    const b = loadCard('one-save-8mb');
    setU32(b, 0x38, 0xffffff); // alloc_end past the card
    expect(() => openCard(b)).toThrow(expect.objectContaining({ code: 'bad-superblock' }));
  });

  it('reports bad paths clearly', () => {
    const card = openCard(loadCard(CARD));
    expect(() => card.readFile('/NOPE')).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(() => card.readFile(`/${SAVE}`)).toThrow(expect.objectContaining({ code: 'not-a-file' }));
    expect(() => card.readDir(`/${SAVE}/icon.sys`)).toThrow(expect.objectContaining({ code: 'not-a-directory' }));
  });
});
