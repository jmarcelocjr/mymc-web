import { describe, expect, it } from 'vitest';
import { eccSpare, openCard } from '../../src/core';
import { loadCard } from '../helpers/fixtures';

const RAW_PAGE = 528;

describe('ECC', () => {
  it('computes the same spare bytes mymc++ wrote', () => {
    const bytes = loadCard('multi-8mb');
    for (const page of [0, 1, 100, 500, 2000]) {
      const data = bytes.subarray(page * RAW_PAGE, page * RAW_PAGE + 512);
      const spare = bytes.subarray(page * RAW_PAGE + 512, (page + 1) * RAW_PAGE);
      expect(eccSpare(data)).toEqual(spare);
    }
  });

  it('reports a single flipped bit as correctable', () => {
    const bytes = loadCard('one-save-8mb');
    bytes[100 * RAW_PAGE + 7]! ^= 0x10;
    expect(openCard(bytes).checkEcc()).toMatchObject({ corrected: [100], failed: [] });
  });

  it('reports several flipped bits as failed', () => {
    const bytes = loadCard('one-save-8mb');
    bytes[100 * RAW_PAGE + 7]! ^= 0x10;
    bytes[100 * RAW_PAGE + 9]! ^= 0x01;
    expect(openCard(bytes).checkEcc()).toMatchObject({ corrected: [], failed: [100] });
  });

  it('tells failures in filesystem data from failures in unused areas', () => {
    const bytes = loadCard('one-save-8mb');
    const card = openCard(bytes);
    const fileCluster = card.readDir('/BASLUS-00001SYNTH').find((e) => e.name === 'icon.sys')!.cluster;
    const usedPage = (fileCluster + card.superblock.allocOffset) * 2;
    const unusedPage = 1; // second page of the superblock cluster, outside the filesystem
    const freePage = (card.superblock.allocOffset + card.superblock.allocEnd - 1) * 2; // last data cluster, free
    // Two flipped bits in the last 128-byte chunk (past the superblock fields on page 0).
    for (const p of [0, usedPage, unusedPage, freePage]) {
      bytes[p * RAW_PAGE + 0x1f0]! ^= 0x10;
      bytes[p * RAW_PAGE + 0x1f2]! ^= 0x01;
    }
    const report = openCard(bytes).checkEcc();
    expect(report.failed).toEqual([0, unusedPage, usedPage, freePage].sort((a, b) => a - b));
    expect(report.failedInUse).toEqual([0, usedPage]);
  });

  it('skips the check on cards without ECC', () => {
    expect(openCard(loadCard('no-ecc-8mb')).checkEcc().pagesChecked).toBe(0);
  });
});
