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
    if (card.length > 0) writeFileSync(path, card); // an empty card: let mymc++ create the file (format)
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

/** `mymc++ check` output for a card. */
export function mymcCheck(card: Uint8Array): string {
  return withMymc(card, (mymc) => mymc('check'));
}

/** mymc++'s view of a card (the same data as the golden JSON files). */
export function mymcDescribe<T>(card: Uint8Array): T {
  return withMymc(card, (_mymc, dir) => {
    const script =
      'import sys, json; sys.path.insert(0, "scripts"); import make_fixtures as m; from pathlib import Path; ' +
      'print(json.dumps(m.describe(Path(sys.argv[1]))))';
    const out = execFileSync(PYTHON, ['-c', script, join(dir, 'card.ps2')], {
      cwd: join(import.meta.dirname, '..', '..'),
      maxBuffer: 64 * 1024 * 1024,
    });
    // mymc++ prints "corrected N" for each ECC fix it makes on no-ECC images; skip that noise.
    const json = out.toString().split('\n').filter((l) => !l.startsWith('corrected')).join('\n');
    return JSON.parse(json) as T;
  });
}
