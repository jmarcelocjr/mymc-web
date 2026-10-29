import { describe, expect, it } from 'vitest';
import { REAL_CARD_PATH, loadRealCard } from './helpers/fixtures';

// Runs only with PS2_REAL_CARD=/path/to/Mcd001.ps2. The card never goes in the repo.
describe.skipIf(!REAL_CARD_PATH)('real card', () => {
  it('has a known memory card size', () => {
    const bytes = loadRealCard();
    const pageSize = bytes.length % 528 === 0 ? 528 : 512;
    expect(bytes.length % (pageSize * 2)).toBe(0);
  });
});
