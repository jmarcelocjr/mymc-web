import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildCard,
  contentsClusters,
  formatCard,
  openCard,
  readContents,
  rebuildCard,
  verifyCard,
  type CardContents,
} from '../../src/core';
import { cardFixtures, loadCard, loadGolden, type GoldenCard } from '../helpers/fixtures';
import { HAS_MYMC, mymcCheck, mymcDescribe, withMymc } from '../helpers/mymc';
import { describeTree, portableTree } from '../helpers/tree';

/** Absolute clusters a rebuild may change: the FAT and the data area. */
function rewritable(card: ReturnType<typeof openCard>): (cluster: number) => boolean {
  const sb = card.superblock;
  const fat = new Set<number>();
  const fatClusters = Math.ceil(sb.allocEnd / 256);
  const view = new DataView(card.bytes.buffer, card.bytes.byteOffset);
  const { rawPageSize, pageSize } = card.layout;
  for (let k = 0; k < fatClusters; k++) {
    const ifc = sb.indirectFatClusters[Math.floor(k / 256)]!;
    const byte = (k % 256) * 4;
    const page = ifc * 2 + Math.floor(byte / pageSize);
    fat.add(view.getUint32(page * rawPageSize + (byte % pageSize), true));
  }
  return (c) => fat.has(c) || (c >= sb.allocOffset && c < sb.allocOffset + sb.allocEnd);
}

describe('formatCard', () => {
  it('makes the same blank card as mymc++', () => {
    const ref = loadCard('empty-8mb');
    const now = openCard(ref).directoryWithDots('/')[0]!.created;
    expect(Buffer.from(formatCard({ now })).equals(Buffer.from(ref))).toBe(true);
  });

  describe.skipIf(!HAS_MYMC)('every size, against mymc++ format', () => {
    for (const [clusters, ecc] of [
      [16384, true],
      [32768, true],
      [65536, true],
      [8192, false],
    ] as const) {
      it(`${clusters} clusters${ecc ? '' : ', no ECC'}`, () => {
        const ref = withMymc(new Uint8Array(0), (mymc, dir) => {
          mymc('format', '-c', String(clusters), ...(ecc ? [] : ['-e']));
          return new Uint8Array(readFileSync(`${dir}/card.ps2`));
        });
        const now = openCard(ref).directoryWithDots('/')[0]!.created;
        expect(Buffer.from(formatCard({ clusters, ecc, now })).equals(Buffer.from(ref))).toBe(true);
      });
    }
  });
});

describe('rebuilding a card unchanged', () => {
  for (const name of cardFixtures()) {
    it(name, () => {
      const source = openCard(loadCard(name));
      const { contents, unreadable } = readContents(source);
      expect(unreadable).toEqual([]);
      const bytes = rebuildCard(source.bytes, contents);
      const rebuilt = openCard(bytes);

      // Same saves, files, metadata and contents; only storage locations change.
      expect(portableTree(describeTree(rebuilt))).toEqual(portableTree(describeTree(source)));
      expect(rebuilt.problems()).toEqual([]);
      expect(rebuilt.checkEcc().failed).toEqual([]);

      // Nothing outside the FAT and data area changes (superblock, page 1, backup blocks...).
      const may = rewritable(source);
      const raw = source.layout.rawPageSize * source.layout.pagesPerCluster;
      for (let c = 0; c < source.superblock.clustersPerCard; c++) {
        if (may(c)) continue;
        const a = source.bytes.subarray(c * raw, (c + 1) * raw);
        const b = bytes.subarray(c * raw, (c + 1) * raw);
        if (!Buffer.from(a).equals(Buffer.from(b))) throw new Error(`cluster ${c} changed`);
      }
    });
  }

  it('drops deleted entries and defragments', () => {
    const source = openCard(loadCard('fragmented-8mb'));
    const rebuilt = openCard(rebuildCard(source.bytes, readContents(source).contents));
    for (const save of rebuilt.listSaves()) {
      const chain = rebuilt.clusterChain(save.entry.cluster);
      expect(chain).toEqual(chain.map((_, i) => chain[0]! + i));
    }
    expect(rebuilt.freeBytes()).toBeGreaterThanOrEqual(source.freeBytes());
  });

  describe.skipIf(!HAS_MYMC)('accepted by mymc++', () => {
    for (const name of cardFixtures()) {
      it(name, () => {
        const source = openCard(loadCard(name));
        const bytes = rebuildCard(source.bytes, readContents(source).contents);
        expect(mymcCheck(bytes)).toContain('No errors found');
        const theirs = mymcDescribe<GoldenCard>(bytes);
        expect(portableTree(theirs.root)).toEqual(portableTree(loadGolden(name).root));
        expect(theirs.free_bytes).toBe(openCard(bytes).freeBytes());
      });
    }
  });
});

describe('editing contents', () => {
  const source = () => openCard(loadCard('multi-8mb'));

  it('deletes a save', () => {
    const card = source();
    const { contents } = readContents(card);
    const without: CardContents = { ...contents, entries: contents.entries.filter((e) => e.name !== 'BASLES-00003ICONS') };
    const rebuilt = openCard(rebuildCard(card.bytes, without));
    expect(rebuilt.listSaves().map((s) => s.name)).toEqual(card.listSaves().map((s) => s.name).filter((n) => n !== 'BASLES-00003ICONS'));
    expect(rebuilt.freeBytes()).toBe((card.superblock.allocEnd - contentsClusters(without)) * 1024);
    expect(rebuilt.freeBytes()).toBeGreaterThan(card.freeBytes());
  });

  it('refuses contents that do not fit', () => {
    const card = source();
    const { contents } = readContents(card);
    const huge = { ...contents.entries.find((e) => e.name === 'ROOTFILE.BIN')!, data: new Uint8Array(9 * 1024 * 1024) };
    expect(() => buildCard(card.bytes, { ...contents, entries: [...contents.entries, huge] })).toThrow(
      expect.objectContaining({ code: 'no-space' }),
    );
  });

  it('fills a card exactly to capacity', () => {
    const card = openCard(loadCard('empty-8mb'));
    const { contents } = readContents(card);
    const free = card.freeBytes();
    const file = { entry: contents.dot.slice(), name: 'FILL', data: new Uint8Array(free - 1024) };
    file.entry.fill(0, 0x40);
    file.entry.set([0x46, 0x49, 0x4c, 0x4c], 0x40);
    new DataView(file.entry.buffer).setUint16(0, 0x8417, true);
    const bytes = rebuildCard(card.bytes, { ...contents, entries: [file] });
    expect(openCard(bytes).freeBytes()).toBe(0);
  });
});

describe('verifyCard', () => {
  it('catches a card that does not hold the contents', () => {
    const card = openCard(loadCard('multi-8mb'));
    const { contents } = readContents(card);
    const bytes = buildCard(card.bytes, contents);
    expect(verifyCard(bytes, contents).ok).toBe(true);

    // Corrupt one data byte of a file (and fix its ECC so only the contents differ).
    const changed = { ...contents, entries: contents.entries.map((e) => (e.name === 'ROOTFILE.BIN' ? { ...e, data: e.data!.map((b, i) => (i === 5 ? b ^ 1 : b)) } : e)) };
    const result = verifyCard(bytes, changed);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('/ROOTFILE.BIN: contents differ');

    const renamed = { ...contents, entries: contents.entries.slice(1) };
    expect(verifyCard(bytes, renamed).ok).toBe(false);
  });

  it('reports a card that does not open', () => {
    const { contents } = readContents(openCard(loadCard('empty-8mb')));
    const result = verifyCard(new Uint8Array(100), contents);
    expect(result.ok).toBe(false);
  });
});
