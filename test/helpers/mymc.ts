import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** mymc++ from the local .venv (made by `npm run fixtures`). Tests using it skip without it. */
export const PYTHON = join(import.meta.dirname, '..', '..', '.venv', 'bin', 'python');
export const HAS_MYMC = existsSync(PYTHON);

/** Run mymc++ on a temporary copy of a card. `files` are extra inputs placed next to it. */
export function withMymc<T>(
  card: Uint8Array,
  run: (mymc: (...args: string[]) => string, dir: string) => T,
  files: Record<string, Uint8Array> = {},
): T {
  const dir = mkdtempSync(join(tmpdir(), 'mymc-'));
  try {
    const path = join(dir, 'card.ps2');
    writeFileSync(path, card);
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
    const mymc = (...args: string[]) =>
      execFileSync(PYTHON, ['-m', 'mymcplusplus', path, ...args], { cwd: dir, maxBuffer: 256 * 1024 * 1024 }).toString();
    return run(mymc, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** mymc++'s .psu export of a save. */
export function mymcExportPsu(card: Uint8Array, name: string): Uint8Array {
  return withMymc(card, (mymc, dir) => {
    const out = join(dir, 'out.psu');
    mymc('export', '-p', '-o', out, name);
    return new Uint8Array(readFileSync(out));
  });
}
