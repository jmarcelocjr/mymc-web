import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CardError,
  exportPsu,
  isDir,
  lzariDecode,
  nodeTitle,
  openCard,
  parseMax,
  parsePsu,
  parseSaveFile,
  readContents,
  readNode,
  rebuildCard,
  type ArchiveNode,
  type Tod,
} from '../../src/core';
import { loadCard, loadFile } from '../helpers/fixtures';
import { HAS_MYMC, mymcCheck, withMymc } from '../helpers/mymc';
import { describeTree, portableTree } from '../helpers/tree';

const NOW: Tod = { seconds: 1, minutes: 2, hours: 3, day: 4, month: 5, year: 2026 };
const ICONS = 'BASLES-00003ICONS';
const files = (node: ArchiveNode) => Object.fromEntries(node.dir!.children.map((c) => [c.name, Buffer.from(c.data!).toString('hex')]));

describe('.psu import', () => {
  const card = openCard(loadCard('multi-8mb'));
  const original = readNode(card, `/${ICONS}`);

  it('reads the save exactly as it was on the card', () => {
    const { node, format, warnings } = parsePsu(loadFile('three-icons.psu'));
    expect(format).toBe('psu');
    expect(warnings).toEqual([]);
    expect(node.name).toBe(ICONS);
    expect(files(node)).toEqual(files(original));
    expect(node.dir!.children.map((c) => c.name)).toEqual(original.dir!.children.map((c) => c.name));
  });

  it('round-trips through a card: delete, import, same tree', () => {
    const { contents } = readContents(card);
    const index = contents.entries.findIndex((e) => e.name === ICONS);
    const imported = parsePsu(exportPsu(card, ICONS).bytes).node;
    const entries = contents.entries.slice();
    entries[index] = imported;
    const rebuilt = openCard(rebuildCard(card.bytes, { ...contents, entries }));
    expect(portableTree(describeTree(rebuilt))).toEqual(portableTree(describeTree(card)));
  });

  it('rejects damaged files', () => {
    const good = loadFile('three-icons.psu');
    const expectBad = (bytes: Uint8Array) => expect(() => parsePsu(bytes)).toThrow(CardError);
    expectBad(new Uint8Array(100));
    expectBad(good.subarray(0, 512 * 3 + 600)); // truncated inside the first file
    const fileAsDir = good.slice();
    fileAsDir[512 * 3] = 0x27; // first file's mode: directory
    expectBad(fileAsDir);
    const huge = good.slice();
    new DataView(huge.buffer).setUint32(4, 50000, true); // absurd file count
    expectBad(huge);
    const noName = good.slice();
    noName.fill(0, 0x40, 0x60);
    expectBad(noName);
  });
});

describe('.max import', () => {
  const card = openCard(loadCard('multi-8mb'));
  const original = readNode(card, `/${ICONS}`);

  it('decompresses the save made by mymc++', () => {
    const { node, format, warnings } = parseMax(loadFile('three-icons.max'), NOW);
    expect(format).toBe('max');
    expect(warnings).toEqual([]);
    expect(node.name).toBe(ICONS);
    expect(files(node)).toEqual(files(original));
    // .max keeps no dates: everything gets "now".
    const created = new DataView(node.entry.buffer).getUint16(14, true);
    expect(created).toBe(2026);
  });

  it('is picked by parseSaveFile from its signature', () => {
    expect(parseSaveFile(loadFile('three-icons.max'), NOW).format).toBe('max');
    expect(parseSaveFile(loadFile('three-icons.psu'), NOW).format).toBe('psu');
  });

  it('warns about a bad checksum but still checks the contents', () => {
    const bytes = loadFile('three-icons.max').slice();
    bytes[12]! ^= 0xff;
    const { warnings, node } = parseMax(bytes, NOW);
    expect(warnings).toHaveLength(1);
    expect(files(node)).toEqual(files(original));
  });

  it('rejects damaged files without hanging', () => {
    const good = loadFile('three-icons.max');
    expect(() => parseMax(new Uint8Array(50), NOW)).toThrow(CardError);
    expect(() => parseMax(good.subarray(0, 0x5c + 40), NOW)).toThrow(CardError);
    // Random garbage after a valid header: must end with an error or a result, quickly.
    let seed = 7;
    for (let round = 0; round < 20; round++) {
      const junk = good.slice();
      for (let i = 0x5c; i < junk.length; i++) junk[i] = (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
      try {
        parseMax(junk, NOW);
      } catch (e) {
        expect(e).toBeInstanceOf(CardError);
      }
    }
  });

  it('decodes empty input to nothing', () => {
    expect(lzariDecode(new Uint8Array(0), 0)).toEqual(new Uint8Array(0));
    expect(() => lzariDecode(new Uint8Array(0), 100000)).toThrow(CardError);
  });

  describe.skipIf(!HAS_MYMC)('every save, compressed by mymc++', () => {
    for (const name of ['multi-8mb', 'fragmented-8mb', 'one-save-64mb']) {
      it(name, () => {
        const bytes = loadCard(name);
        const c = openCard(bytes);
        for (const save of c.listSaves()) {
          if (!isDir(save.entry) || !save.readable || save.kind !== 'ps2') continue;
          let max: Uint8Array;
          try {
            max = withMymc(bytes, (mymc, dir) => {
              mymc('export', '-m', '-o', join(dir, 'out.max'), save.name);
              return new Uint8Array(readFileSync(join(dir, 'out.max')));
            });
          } catch (e) {
            // mymc++ can't write .max for saves with non-ASCII titles; nothing to compare then.
            if (String(e).includes('UnicodeEncodeError')) continue;
            throw e;
          }
          const { node, warnings } = parseMax(max, NOW);
          expect(warnings).toEqual([]);
          expect(files(node)).toEqual(files(readNode(c, `/${save.name}`)));
        }
      });
    }

    it('an imported .max card passes mymc++ check', () => {
      const empty = openCard(loadCard('empty-8mb'));
      const { contents } = readContents(empty);
      const node = parseMax(loadFile('three-icons.max'), NOW).node;
      const bytes = rebuildCard(empty.bytes, { ...contents, entries: [node] });
      expect(mymcCheck(bytes)).toContain('No errors found');
    });
  });
});

describe('nodeTitle', () => {
  const card = openCard(loadCard('multi-8mb'));
  it('reads the game title of saves being imported', () => {
    expect(nodeTitle(parsePsu(loadFile('three-icons.psu')).node)?.display).toEqual(['Three Icons', 'Save']);
    expect(nodeTitle(parseMax(loadFile('three-icons.max'), NOW).node)?.display).toEqual(['Three Icons', 'Save']);
  });
  it('matches the titles of saves on the card, PS1 included', () => {
    for (const save of card.listSaves()) {
      if (!isDir(save.entry) || !save.readable) continue;
      expect(nodeTitle(readNode(card, `/${save.name}`))?.display, save.name).toEqual(save.title?.display);
    }
  });
});
