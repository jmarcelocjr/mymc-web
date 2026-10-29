import { nodeClusters, type ArchiveNode, type CardContents } from './archive';
import { openCard, type MemoryCard } from './card';
import { DIRENT_SIZE, EntryField, Mode, isDir, parseDirEntry, setEntryU32 } from './dirent';
import { CardError } from './errors';
import { FAT_ALLOCATED, FAT_CHAIN_END, FAT_FREE } from './fat';
import { CardImage } from './image';
import { ENTRIES_PER_FAT_CLUSTER, detectLayout, parseSuperblock, type Superblock } from './superblock';
import { ImageWriter } from './writer';

/** Data clusters a card can hold: the FAT's size, capped by where the backup blocks start. */
export function cardCapacity(sb: Superblock): number {
  const limit =
    (Math.min(sb.backupBlock1, sb.backupBlock2) * sb.pagesPerEraseBlock) / sb.pagesPerCluster - sb.allocOffset;
  return Math.max(0, Math.min(sb.allocEnd, Math.floor(limit)));
}

/** Clusters the contents need: the root directory plus every entry. */
export function contentsClusters(contents: CardContents, clusterSize = 1024): number {
  const root = Math.ceil(((2 + contents.entries.length) * DIRENT_SIZE) / clusterSize);
  return root + contents.entries.reduce((sum, e) => sum + nodeClusters(e, clusterSize), 0);
}

/** Fields the builder fills in; everything else in an entry is written as given. */
const PLACED_FIELDS: [number, number][] = [
  [EntryField.length, 4],
  [EntryField.cluster, 4],
  [EntryField.dirEntry, 4],
];

/**
 * Write the contents to a fresh copy of `base`. The FAT and the whole data
 * area are rebuilt; everything outside the filesystem (superblock, page 1,
 * indirect FAT, backup blocks) is kept exactly as in `base`. Each directory
 * and file is stored in one contiguous run of clusters.
 */
export function buildCard(base: Uint8Array, contents: CardContents): Uint8Array {
  const sb = parseSuperblock(base);
  const layout = detectLayout(base.length, sb);
  const clusterSize = layout.clusterSize;
  if (sb.rootDirCluster !== 0) {
    throw new CardError('bad-superblock', `Root directory at cluster ${sb.rootDirCluster} isn't supported for writing.`);
  }
  const needed = contentsClusters(contents, clusterSize);
  const capacity = cardCapacity(sb);
  if (needed > capacity) {
    throw new CardError(
      'no-space',
      `The saves need ${needed} KB but the card holds ${capacity} KB (${needed - capacity} KB too many).`,
    );
  }

  // Lay out every directory and file, in card order.
  const data = new Uint8Array(needed * clusterSize);
  const runs: [first: number, count: number][] = [];
  let next = 0;
  const allocate = (count: number): number => {
    const first = next;
    next += count;
    if (count > 0) runs.push([first, count]);
    return first;
  };
  const entryBytes = (entries: Uint8Array[]) => {
    const buf = new Uint8Array(Math.ceil((entries.length * DIRENT_SIZE) / clusterSize) * clusterSize);
    entries.forEach((e, i) => buf.set(e, i * DIRENT_SIZE));
    return buf;
  };

  /** Place a node; returns its entry with length and cluster filled in. */
  const place = (node: ArchiveNode, parentCluster: number, index: number): Uint8Array => {
    const entry = node.entry.slice(0, DIRENT_SIZE);
    const view = new DataView(entry.buffer);
    view.setUint16(EntryField.mode, view.getUint16(EntryField.mode, true) | Mode.EXISTS, true);
    setEntryU32(entry, EntryField.dirEntry, 0);
    if (node.dir) {
      const count = 2 + node.dir.children.length;
      const first = allocate(Math.ceil((count * DIRENT_SIZE) / clusterSize));
      const dot = node.dir.dot.slice(0, DIRENT_SIZE);
      setEntryU32(dot, EntryField.length, 0);
      setEntryU32(dot, EntryField.cluster, parentCluster);
      setEntryU32(dot, EntryField.dirEntry, index);
      const dotdot = node.dir.dotdot.slice(0, DIRENT_SIZE);
      setEntryU32(dotdot, EntryField.length, 0);
      setEntryU32(dotdot, EntryField.cluster, 0);
      setEntryU32(dotdot, EntryField.dirEntry, 0);
      const children = node.dir.children.map((c, i) => place(c, first, i + 2));
      data.set(entryBytes([dot, dotdot, ...children]), first * clusterSize);
      setEntryU32(entry, EntryField.length, count);
      setEntryU32(entry, EntryField.cluster, first);
    } else {
      const bytes = node.data ?? new Uint8Array(0);
      const clusters = Math.ceil(bytes.length / clusterSize);
      const first = clusters > 0 ? allocate(clusters) : FAT_CHAIN_END;
      if (clusters > 0) data.set(bytes, first * clusterSize);
      setEntryU32(entry, EntryField.length, bytes.length);
      setEntryU32(entry, EntryField.cluster, first);
    }
    return entry;
  };

  const rootCount = 2 + contents.entries.length;
  const rootFirst = allocate(Math.ceil((rootCount * DIRENT_SIZE) / clusterSize));
  const rootDot = contents.dot.slice(0, DIRENT_SIZE);
  setEntryU32(rootDot, EntryField.length, rootCount);
  setEntryU32(rootDot, EntryField.cluster, 0);
  setEntryU32(rootDot, EntryField.dirEntry, 0);
  const rootDotDot = contents.dotdot.slice(0, DIRENT_SIZE);
  const rootEntries = contents.entries.map((e, i) => place(e, rootFirst, i + 2));
  data.set(entryBytes([rootDot, rootDotDot, ...rootEntries]), rootFirst * clusterSize);
  if (next !== needed) throw new CardError('build-failed', `Internal error: placed ${next} of ${needed} clusters.`);

  // Write the data area: placed clusters, then zeros up to the end of the FAT.
  const out = base.slice();
  const w = new ImageWriter(out, layout);
  const zero = new Uint8Array(clusterSize);
  for (let c = 0; c < sb.allocEnd; c++) {
    w.writeCluster(sb.allocOffset + c, c < needed ? data.subarray(c * clusterSize, (c + 1) * clusterSize) : zero);
  }

  // Rewrite the FAT entries for the data area, in the FAT clusters `base` already uses.
  const fat = new Uint32Array(sb.allocEnd).fill(FAT_FREE);
  for (const [first, count] of runs) {
    for (let i = 0; i < count - 1; i++) fat[first + i] = ((first + i + 1) | FAT_ALLOCATED) >>> 0;
    fat[first + count - 1] = FAT_CHAIN_END;
  }
  const image = new CardImage(base, layout);
  const fatClusters = Math.ceil(sb.allocEnd / ENTRIES_PER_FAT_CLUSTER);
  for (let k = 0; k < fatClusters; k++) {
    const ifc = image.cluster(sb.indirectFatClusters[Math.floor(k / ENTRIES_PER_FAT_CLUSTER)]!);
    const fatCluster = new DataView(ifc.buffer, ifc.byteOffset).getUint32((k % ENTRIES_PER_FAT_CLUSTER) * 4, true);
    if (fatCluster >= sb.allocOffset || fatCluster === 0) {
      throw new CardError('bad-superblock', `FAT cluster ${fatCluster} overlaps the superblock or data area.`);
    }
    const buf = image.cluster(fatCluster).slice();
    const view = new DataView(buf.buffer);
    for (let j = 0; j < ENTRIES_PER_FAT_CLUSTER; j++) {
      const n = k * ENTRIES_PER_FAT_CLUSTER + j;
      if (n < sb.allocEnd) view.setUint32(j * 4, fat[n]!, true);
    }
    w.writeCluster(fatCluster, buf);
  }
  return out;
}

// ---------------------------------------------------------------- verify

export interface VerifyResult {
  ok: boolean;
  /** What doesn't match, with the path on the card. Empty when ok. */
  errors: string[];
  card?: MemoryCard;
}

const MAX_ERRORS = 20;

/** Compare two entries, ignoring the fields the builder fills in. */
function sameEntry(a: Uint8Array, b: Uint8Array, ignoreMode = false): boolean {
  for (let i = 0; i < DIRENT_SIZE; i++) {
    if (PLACED_FIELDS.some(([o, n]) => i >= o && i < o + n)) continue;
    if (ignoreMode && i < 2) continue;
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Reopen a built card with the reader and check it holds exactly the
 * contents: same entries in the same order, same metadata, same bytes, no
 * damaged pages and no lost or leaked clusters. A card is only offered for
 * download when this passes.
 */
export function verifyCard(bytes: Uint8Array, contents: CardContents): VerifyResult {
  const errors: string[] = [];
  const fail = (msg: string) => {
    if (errors.length < MAX_ERRORS) errors.push(msg);
  };
  let card: MemoryCard;
  try {
    card = openCard(bytes);
  } catch (e) {
    return { ok: false, errors: [`The new card can't be opened: ${e instanceof Error ? e.message : String(e)}`] };
  }

  const checkDir = (path: string, dot: Uint8Array, dotdot: Uint8Array, children: ArchiveNode[]) => {
    let actual;
    try {
      actual = card.directoryWithDots(path);
    } catch (e) {
      fail(`${path}: can't be read (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    if (!sameEntry(actual[0]!.raw, dot)) fail(`${path}: "." entry differs`);
    if (!sameEntry(actual[1]!.raw, dotdot)) fail(`${path}: ".." entry differs`);
    if (actual.length !== children.length + 2) {
      fail(`${path}: has ${actual.length - 2} entries, expected ${children.length}`);
      return;
    }
    children.forEach((node, i) => {
      const got = actual[i + 2]!;
      const child = path === '/' ? `/${got.name}` : `${path}/${got.name}`;
      // The builder always sets the "exists" bit, so compare the rest of the mode separately.
      const want = parseDirEntry(node.entry, 0);
      if (got.name !== node.name || !sameEntry(got.raw, node.entry, true) || (got.mode & ~Mode.EXISTS) !== (want.mode & ~Mode.EXISTS)) {
        fail(`${child}: entry differs (name, mode, dates or attributes)`);
        return;
      }
      if (node.dir) {
        if (!isDir(got)) fail(`${child}: should be a folder`);
        else checkDir(child, node.dir.dot, node.dir.dotdot, node.dir.children);
        return;
      }
      try {
        const data = card.readFile(child);
        const expected = node.data ?? new Uint8Array(0);
        if (data.length !== expected.length || data.some((b, k) => b !== expected[k])) fail(`${child}: contents differ`);
      } catch (e) {
        fail(`${child}: can't be read (${e instanceof Error ? e.message : String(e)})`);
      }
    });
  };
  checkDir('/', contents.dot, contents.dotdot, contents.entries);

  for (const p of card.problems()) fail(`${p.path}: ${p.message}`);
  const ecc = card.checkEcc();
  if (ecc.failedInUse.length > 0) fail(`${ecc.failedInUse.length} page(s) fail their ECC check`);
  const used = contentsClusters(contents, card.clusterSize);
  const free = card.freeBytes() / card.clusterSize;
  if (free !== card.superblock.allocEnd - used) {
    fail(`Free space is ${free} clusters, expected ${card.superblock.allocEnd - used} (clusters lost or leaked)`);
  }
  return errors.length === 0 ? { ok: true, errors, card } : { ok: false, errors };
}

/** Build and verify in one step. Throws CardError('build-failed') with the reasons if they don't match. */
export function rebuildCard(base: Uint8Array, contents: CardContents): Uint8Array {
  const bytes = buildCard(base, contents);
  const result = verifyCard(bytes, contents);
  if (!result.ok) {
    throw new CardError('build-failed', `The new card didn't check out, so it wasn't offered: ${result.errors.join('; ')}`);
  }
  return bytes;
}
