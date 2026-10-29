import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');

/** Golden data written by scripts/make_fixtures.py from mymc++'s view of each card. */
export interface GoldenEntry {
  name: string;
  mode: number;
  length: number;
  created: number[];
  modified: number[];
  cluster: number;
  attr: number;
  chain?: [number, number][];
  sha256?: string;
  children?: GoldenEntry[];
}

export interface GoldenCard {
  file_size: number;
  has_ecc: boolean;
  superblock: Record<string, number | number[]>;
  free_bytes: number;
  root: GoldenEntry[];
  mymc_dir: string | null;
  mymc_df: string;
}

/** Names of all fixture cards, e.g. "multi-8mb". */
export function cardFixtures(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.ps2.gz'))
    .map((f) => f.replace(/\.ps2\.gz$/, ''))
    .sort();
}

const cardCache = new Map<string, Uint8Array>();

/** A fresh copy of a fixture card, safe to modify in a test. */
export function loadCard(name: string): Uint8Array {
  let bytes = cardCache.get(name);
  if (!bytes) {
    bytes = new Uint8Array(gunzipSync(readFileSync(join(FIXTURES_DIR, `${name}.ps2.gz`))));
    cardCache.set(name, bytes);
  }
  return bytes.slice();
}

export function loadGolden(name: string): GoldenCard {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')) as GoldenCard;
}

export function loadFile(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES_DIR, name)));
}

/** The user's own card, outside the repo. Tests using it are skipped when unset. */
export const REAL_CARD_PATH = process.env.PS2_REAL_CARD;

export function loadRealCard(): Uint8Array {
  if (!REAL_CARD_PATH || !existsSync(REAL_CARD_PATH)) {
    throw new Error(`PS2_REAL_CARD not found: ${REAL_CARD_PATH}`);
  }
  return new Uint8Array(readFileSync(REAL_CARD_PATH));
}
