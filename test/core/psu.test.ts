import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CardError, exportPsu, isDir, openCard } from '../../src/core';
import { cardFixtures, loadCard, loadFile } from '../helpers/fixtures';
import { HAS_MYMC, mymcExportPsu, withMymc } from '../helpers/mymc';

describe('.psu export', () => {
  it('matches the .psu mymc++ exported for the fixtures, byte for byte', () => {
    const card = openCard(loadCard('multi-8mb'));
    const { bytes, skipped } = exportPsu(card, 'BASLES-00003ICONS');
    expect(skipped).toEqual([]);
    expect(Buffer.from(bytes).equals(Buffer.from(loadFile('three-icons.psu')))).toBe(true);
  });

  it('lays out entries and padded data', () => {
    const card = openCard(loadCard('multi-8mb'));
    const files = card.readDir('/BASLES-00003ICONS');
    const { bytes } = exportPsu(card, 'BASLES-00003ICONS');
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint32(4, true)).toBe(files.length + 2);
    expect(String.fromCharCode(bytes[512 + 0x40]!)).toBe('.');
    expect(String.fromCharCode(bytes[1024 + 0x40]!, bytes[1024 + 0x41]!)).toBe('..');
    const expected = 512 * (3 + files.length) + files.reduce((s, f) => s + Math.ceil(f.length / 1024) * 1024, 0);
    expect(bytes.length).toBe(expected);
  });

  it('exports empty files', () => {
    const card = openCard(loadCard('multi-8mb'));
    const { bytes } = exportPsu(card, 'BISLPS-00002JPTEST');
    expect(bytes.length % 512).toBe(0);
  });

  it('refuses things that are not save folders', () => {
    const card = openCard(loadCard('multi-8mb'));
    expect(() => exportPsu(card, 'ROOTFILE.BIN')).toThrow(CardError);
    expect(() => exportPsu(card, '')).toThrow(CardError);
    expect(() => exportPsu(card, 'NOPE')).toThrow(CardError);
  });

  // Every save on every fixture card, against mymc++ run live.
  describe.skipIf(!HAS_MYMC)('against mymc++ (needs .venv from npm run fixtures)', () => {
    for (const name of cardFixtures()) {
      it(name, () => {
        const bytes = loadCard(name);
        const card = openCard(bytes);
        for (const save of card.listSaves()) {
          if (!isDir(save.entry) || !save.readable) continue;
          const ours = exportPsu(card, save.name).bytes;
          const theirs = mymcExportPsu(bytes, save.name);
          expect(Buffer.from(ours).equals(Buffer.from(theirs)), `${name}/${save.name}`).toBe(true);
        }
      });
    }

    it('imports back into mymc++ with identical contents', () => {
      const source = openCard(loadCard('multi-8mb'));
      const empty = loadCard('empty-8mb');
      for (const save of source.listSaves()) {
        if (!isDir(save.entry) || !save.readable) continue;
        const psu = exportPsu(source, save.name).bytes;
        const result = withMymc(
          empty,
          (mymc, dir) => {
            mymc('import', 'save.psu');
            return openCard(new Uint8Array(readFileSync(`${dir}/card.ps2`)));
          },
          { 'save.psu': psu },
        );
        const files = source.readDir(`/${save.name}`);
        expect(result.readDir(`/${save.name}`).map((f) => f.name)).toEqual(files.map((f) => f.name));
        for (const f of files) {
          expect(Buffer.from(result.readFile(`/${save.name}/${f.name}`))).toEqual(
            Buffer.from(source.readFile(`/${save.name}/${f.name}`)),
          );
        }
        expect(result.stat(`/${save.name}`).mode).toBe(save.entry.mode);
      }
    });
  });
});
