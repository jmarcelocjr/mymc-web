import { describe, expect, it } from 'vitest';
import { openCard, type SaveSummary } from '../../src/core';
import { cardFixtures, loadCard, loadGolden } from '../helpers/fixtures';
import { describeTree, parseMymcDir } from '../helpers/tree';

// Every fixture card must read exactly as mymc++ read it.
describe.each(cardFixtures())('%s', (name) => {
  const golden = loadGolden(name);
  const card = openCard(loadCard(name));

  it('detects the layout', () => {
    expect(card.hasEcc).toBe(golden.has_ecc);
  });

  it('reads the superblock', () => {
    const sb = card.superblock;
    expect({
      page_len: sb.pageSize,
      pages_per_cluster: sb.pagesPerCluster,
      pages_per_erase_block: sb.pagesPerEraseBlock,
      clusters_per_card: sb.clustersPerCard,
      alloc_offset: sb.allocOffset,
      alloc_end: sb.allocEnd,
      rootdir_cluster: sb.rootDirCluster,
      backup_block1: sb.backupBlock1,
      backup_block2: sb.backupBlock2,
      ifc_list: sb.indirectFatClusters,
    }).toEqual(golden.superblock);
  });

  it('reports the same free space', () => {
    expect(card.freeBytes()).toBe(golden.free_bytes);
  });

  it('reads every entry, chain and file byte for byte', () => {
    expect(describeTree(card)).toEqual(golden.root);
  });

  it('has no read problems', () => {
    expect(card.problems()).toEqual([]);
    expect(card.listSaves().every((s) => s.readable)).toBe(true);
  });

  it('passes ECC checks', () => {
    const ecc = card.checkEcc();
    expect(ecc.failed).toEqual([]);
    expect(ecc.corrected).toEqual([]);
    if (golden.has_ecc) expect(ecc.pagesChecked).toBeGreaterThan(0);
  });

  it.skipIf(golden.mymc_dir === null)('lists saves like `mymc++ dir`', () => {
    const expected = parseMymcDir(golden.mymc_dir!);
    const protectionText: Record<SaveSummary['protection'], string> = {
      none: 'Not Protected',
      copy: 'Copy Protected',
      delete: 'Delete Protected',
      'copy-and-delete': 'Copy & Delete Protected',
    };
    const ours = card
      .listSaves()
      .filter((s) => s.kind !== 'file')
      .map((s) => ({
        name: s.name,
        title: s.title ? s.title.lines : ['Corrupt', ''],
        kb: Math.floor(s.sizeOnCard / 1024),
        protection:
          s.kind === 'ps1' ? 'PlayStation' : s.kind === 'pocketstation' ? 'PocketStation' : protectionText[s.protection],
      }));
    expect(ours).toEqual(expected.saves);
    expect(Math.floor(card.freeBytes() / 1024)).toBe(expected.freeKb);
  });
});

describe('save summaries (multi-8mb)', () => {
  const card = openCard(loadCard('multi-8mb'));
  const byName = new Map(card.listSaves().map((s) => [s.name, s]));

  it('lists every root entry, deleted ones excluded', () => {
    expect([...byName.keys()]).toEqual([
      'BASLUS-00001SYNTH',
      'BISLPS-00002JPTEST',
      'BASLES-00003ICONS',
      'BESLES-00004PS1',
      'BASLUS-00009HIDDEN',
      'ROOTFILE.BIN',
    ]);
  });

  it('classifies kinds and flags', () => {
    expect(byName.get('BASLUS-00001SYNTH')).toMatchObject({ kind: 'ps2', protection: 'none', hidden: false });
    expect(byName.get('BISLPS-00002JPTEST')).toMatchObject({ kind: 'ps2', protection: 'copy' });
    expect(byName.get('BESLES-00004PS1')).toMatchObject({ kind: 'ps1' });
    expect(byName.get('BASLUS-00009HIDDEN')).toMatchObject({ kind: 'ps2', hidden: true });
    expect(byName.get('ROOTFILE.BIN')).toMatchObject({ kind: 'file', sizeOnCard: 2048 });
  });

  it('decodes Shift-JIS titles and normalizes them for display', () => {
    const t = byName.get('BISLPS-00002JPTEST')!.title!;
    expect(t.lines).toEqual(['ＪＰ　テスト　セーブ', 'データ　１']);
    expect(t.display).toEqual(['JP テスト セーブ', 'データ 1']);
  });

  it('reads icon.sys details', () => {
    const icons = byName.get('BASLES-00003ICONS')!.iconSys!;
    expect(icons.icons).toEqual({ normal: 'list.ico', copy: 'copy.ico', delete: 'del.ico' });
    expect(icons.backgroundColors[0]).toEqual([64, 0, 96, 0]);
    expect(icons.lightDirections[0]).toEqual([0.5, 0.5, 0.5, 0]);
    expect(icons.ambientLight[0]).toBeCloseTo(0.2);
  });

  it('has no title for a PS1 save without an SC header', () => {
    expect(byName.get('BESLES-00004PS1')!.title).toBeUndefined();
  });
});
