import { describe, expect, it } from 'vitest';
import { formatKb, todToDate } from '../../src/ui/format';

describe('card timestamps', () => {
  it('reads card times as Japan time (UTC+9)', () => {
    // 00:03:46 on Oct 30 in Japan is 15:03:46 on Oct 29 UTC.
    const d = todToDate({ seconds: 46, minutes: 3, hours: 0, day: 30, month: 10, year: 2026 });
    expect(d?.toISOString()).toBe('2026-10-29T15:03:46.000Z');
  });

  it('treats blank or impossible dates as missing', () => {
    expect(todToDate({ seconds: 0, minutes: 0, hours: 0, day: 0, month: 0, year: 0 })).toBeUndefined();
    expect(todToDate({ seconds: 0, minutes: 0, hours: 0, day: 1, month: 13, year: 2004 })).toBeUndefined();
  });
});

describe('sizes', () => {
  it('shows whole KB like the PS2 browser', () => {
    expect(formatKb(8_329_216)).toBe('8,134 KB');
  });
});
