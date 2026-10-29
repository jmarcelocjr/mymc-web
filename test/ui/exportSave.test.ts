import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { exportPsu, openCard } from '../../src/core';
import { canExport, exportSave, safeFileName } from '../../src/ui/exportSave';
import { loadCard } from '../helpers/fixtures';

const card = openCard(loadCard('multi-8mb'));
const save = (name: string) => card.listSaves().find((s) => s.name === name)!;

describe('exportSave', () => {
  it('zips a save folder with its files as on the card', () => {
    const s = save('BASLES-00003ICONS');
    const out = exportSave(card, s, 'zip');
    expect(out.fileName).toBe('BASLES-00003ICONS.zip');
    const files = unzipSync(out.bytes);
    const names = card.readDir('/BASLES-00003ICONS').map((f) => f.name);
    expect(Object.keys(files).filter((k) => !k.endsWith('/')).sort()).toEqual(names.map((n) => `BASLES-00003ICONS/${n}`).sort());
    for (const n of names) {
      expect(Buffer.from(files[`BASLES-00003ICONS/${n}`]!)).toEqual(Buffer.from(card.readFile(`/BASLES-00003ICONS/${n}`)));
    }
  });

  it('keeps empty files in the zip', () => {
    const files = unzipSync(exportSave(card, save('BISLPS-00002JPTEST'), 'zip').bytes);
    expect(files['BISLPS-00002JPTEST/data1']).toEqual(new Uint8Array(0));
  });

  it('exports .psu through the core exporter', () => {
    const out = exportSave(card, save('BASLES-00003ICONS'), 'psu');
    expect(out.fileName).toBe('BASLES-00003ICONS.psu');
    expect(out.bytes).toEqual(exportPsu(card, 'BASLES-00003ICONS').bytes);
  });

  it('zips loose files, but only folders become .psu', () => {
    const loose = save('ROOTFILE.BIN');
    expect(canExport(loose, 'psu')).toBe(false);
    expect(canExport(loose, 'zip')).toBe(true);
    const files = unzipSync(exportSave(card, loose, 'zip').bytes);
    expect(Buffer.from(files['ROOTFILE.BIN']!)).toEqual(Buffer.from(card.readFile('/ROOTFILE.BIN')));
  });

  it('makes names safe for any OS', () => {
    expect(safeFileName('BASCUS-97198YAOTWTD!')).toBe('BASCUS-97198YAOTWTD!');
    expect(safeFileName('a/b:c*?"<>|\u0001')).toBe('a_b_c_______');
    expect(safeFileName('name. ')).toBe('name');
    expect(safeFileName('...')).toBe('save');
  });
});
