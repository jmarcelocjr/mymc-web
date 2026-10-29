import { describe, expect, it } from 'vitest';
import { cardFixtures, loadCard, loadFile, loadGolden } from './helpers/fixtures';

// Sanity checks on the fixtures themselves; the real reader tests start in Phase 1.
describe('fixtures', () => {
  const names = cardFixtures();

  it('has every expected card', () => {
    expect(names).toEqual([
      'empty-8mb', 'fragmented-8mb', 'full-8mb', 'multi-8mb', 'no-ecc-8mb',
      'one-save-16mb', 'one-save-32mb', 'one-save-64mb', 'one-save-8mb',
    ]);
  });

  it.each(names)('%s decompresses to the size mymc++ reported', (name) => {
    const golden = loadGolden(name);
    const bytes = loadCard(name);
    expect(bytes.length).toBe(golden.file_size);
    const magic = new TextDecoder('ascii').decode(bytes.subarray(0, 28));
    expect(magic).toBe('Sony PS2 Memory Card Format ');
  });

  it('has the save files used by import tests', () => {
    expect(new TextDecoder('ascii').decode(loadFile('three-icons.max').subarray(0, 12))).toBe('Ps2PowerSave');
    expect(loadFile('three-icons.psu').length % 512).toBe(0);
  });
});
