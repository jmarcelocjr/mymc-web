import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openCard, type MemoryCard } from '../src/core';
import { REAL_CARD_PATH, loadRealCard, type GoldenCard } from './helpers/fixtures';
import { describeTree } from './helpers/tree';

const PYTHON = join(import.meta.dirname, '..', '.venv', 'bin', 'python');

/** mymc++'s view of the card, taken from a temporary copy so the original is never touched. */
function mymcView(): GoldenCard {
  const dir = mkdtempSync(join(tmpdir(), 'mymc-real-'));
  try {
    const copy = join(dir, 'card.ps2');
    copyFileSync(REAL_CARD_PATH!, copy);
    const script =
      'import sys, json; sys.path.insert(0, "scripts"); import make_fixtures as m; from pathlib import Path; ' +
      'print(json.dumps(m.describe(Path(sys.argv[1]))))';
    const out = execFileSync(PYTHON, ['-c', script, copy], {
      cwd: join(import.meta.dirname, '..'),
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(out.toString()) as GoldenCard;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Runs only with PS2_REAL_CARD=/path/to/Mcd001.ps2. The card never goes in the repo.
describe.skipIf(!REAL_CARD_PATH)('real card', () => {
  // Opened lazily: the describe body runs even when the suite is skipped.
  let cached: MemoryCard | undefined;
  const getCard = () => (cached ??= openCard(loadRealCard()));

  it('opens and lists saves', () => {
    const saves = getCard().listSaves();
    console.log(
      saves
        .map((s) => `${s.readable ? ' ' : '!'} ${s.name.padEnd(32)} ${s.kind.padEnd(6)} ${(s.sizeOnCard / 1024).toFixed(0).padStart(5)} KB  ${s.title?.display.join(' / ') ?? ''}`)
        .join('\n'),
    );
    expect(saves.length).toBeGreaterThanOrEqual(0);
  });

  it('has no read problems or ECC errors where data lives', () => {
    expect(getCard().problems()).toEqual([]);
    const ecc = getCard().checkEcc();
    if (ecc.failed.length > 0) console.log('ECC mismatches outside the filesystem (harmless), pages:', ecc.failed);
    expect(ecc.failedInUse).toEqual([]);
  });

  it.skipIf(!existsSync(PYTHON))('matches mymc++ (needs .venv from npm run fixtures)', () => {
    const golden = mymcView();
    const card = getCard();
    expect(card.hasEcc).toBe(golden.has_ecc);
    expect(card.freeBytes()).toBe(golden.free_bytes);
    expect(describeTree(card)).toEqual(golden.root);
  });
});
