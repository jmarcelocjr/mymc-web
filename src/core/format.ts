import { DIRENT_SIZE, Mode, makeEntry, setEntryU32, EntryField, type Tod } from './dirent';
import { CardError } from './errors';
import { FAT_CHAIN_END, FAT_FREE } from './fat';
import { CARD_MAGIC } from './superblock';
import { ImageWriter } from './writer';

/** Card sizes PCSX2 can create, in MB, with their cluster counts. */
export const CARD_SIZES = { 8: 8192, 16: 16384, 32: 32768, 64: 65536 } as const;
export type CardSizeMb = keyof typeof CARD_SIZES;

const PAGE_SIZE = 512;
const PAGES_PER_CLUSTER = 2;
const CLUSTER_SIZE = 1024;
const PAGES_PER_ERASE_BLOCK = 16;
const ENTRIES_PER_CLUSTER = CLUSTER_SIZE / 4;
const INDIRECT_FAT_OFFSET = 0x2000;
const MAX_INDIRECT_FAT_CLUSTERS = 32;
const SPARE_SIZE = 16;

/** Mode of a directory's "." entry (and of save folders): rwx, directory, PS2, exists. */
export const DIR_MODE = Mode.READ | Mode.WRITE | Mode.EXECUTE | Mode.DIR | Mode.PS2_SAVE | Mode.EXISTS;
/** Mode of the root's ".." entry, which the PS2 hides. */
export const ROOT_DOTDOT_MODE = Mode.WRITE | Mode.EXECUTE | Mode.DIR | Mode.PS2_SAVE | Mode.HIDDEN | Mode.EXISTS;

/**
 * A blank, formatted card, laid out exactly as `mymc++ format` makes it (and
 * so as PCSX2 accepts it): every page zeroed with its ECC, the indirect FAT
 * and FAT after cluster 8, and a root directory holding "." and "..".
 */
export function formatCard(options: { clusters?: number; ecc?: boolean; now: Tod }): Uint8Array {
  const clusters = options.clusters ?? CARD_SIZES[8];
  const ecc = options.ecc ?? true;
  const pagesPerCard = Math.floor((clusters * PAGES_PER_CLUSTER) / PAGES_PER_ERASE_BLOCK) * PAGES_PER_ERASE_BLOCK;
  const clustersPerEraseBlock = PAGES_PER_ERASE_BLOCK / PAGES_PER_CLUSTER;
  const eraseBlocks = pagesPerCard / PAGES_PER_ERASE_BLOCK;
  const clustersPerCard = pagesPerCard / PAGES_PER_CLUSTER;

  const goodBlock1 = eraseBlocks - 1;
  const goodBlock2 = eraseBlocks - 2;
  const firstIfc = Math.ceil(INDIRECT_FAT_OFFSET / CLUSTER_SIZE);
  const allocatable = clustersPerCard - (firstIfc + 2);
  let fatClusters = Math.ceil(allocatable / ENTRIES_PER_CLUSTER);
  let ifcCount = Math.ceil(fatClusters / ENTRIES_PER_CLUSTER);
  if (ifcCount > MAX_INDIRECT_FAT_CLUSTERS) {
    ifcCount = MAX_INDIRECT_FAT_CLUSTERS;
    fatClusters = ifcCount * ENTRIES_PER_CLUSTER;
  }
  const allocOffset = firstIfc + ifcCount + fatClusters;
  const allocEnd = goodBlock2 * clustersPerEraseBlock - allocOffset;
  if (allocEnd < 1) throw new CardError('bad-superblock', 'Card too small to format.');

  const rawPage = ecc ? PAGE_SIZE + SPARE_SIZE : PAGE_SIZE;
  const bytes = new Uint8Array(pagesPerCard * rawPage);
  const w = new ImageWriter(bytes, {
    hasEcc: ecc,
    pageSize: PAGE_SIZE,
    spareSize: ecc ? SPARE_SIZE : 0,
    rawPageSize: rawPage,
    pagesPerCluster: PAGES_PER_CLUSTER,
    clusterSize: CLUSTER_SIZE,
    totalPages: pagesPerCard,
  });
  const zero = new Uint8Array(PAGE_SIZE);
  if (ecc) for (let p = 0; p < pagesPerCard; p++) w.writePage(p, zero);

  // Indirect FAT: lists the FAT clusters, which follow it.
  const firstFat = firstIfc + ifcCount;
  const remainder = fatClusters % ENTRIES_PER_CLUSTER;
  for (let i = 0; i < ifcCount; i++) {
    const buf = new Uint8Array(CLUSTER_SIZE);
    const view = new DataView(buf.buffer);
    for (let j = 0; j < ENTRIES_PER_CLUSTER; j++) {
      const unused = i === ifcCount - 1 && remainder !== 0 && j >= remainder;
      view.setUint32(j * 4, unused ? 0xffffffff : firstFat + i * ENTRIES_PER_CLUSTER + j, true);
    }
    w.writeCluster(firstIfc + i, buf);
  }

  // FAT: cluster 0 is the root (one cluster), the rest free, and the
  // entries past the end of the data area marked as chain ends.
  for (let k = 0; k < fatClusters; k++) {
    const buf = new Uint8Array(CLUSTER_SIZE);
    const view = new DataView(buf.buffer);
    for (let j = 0; j < ENTRIES_PER_CLUSTER; j++) {
      const n = k * ENTRIES_PER_CLUSTER + j;
      view.setUint32(j * 4, n === 0 || n >= allocEnd ? FAT_CHAIN_END : FAT_FREE, true);
    }
    w.writeCluster(firstFat + k, buf);
  }

  // Root directory.
  const root = new Uint8Array(CLUSTER_SIZE);
  const dot = makeEntry({ mode: DIR_MODE, name: '.', created: options.now });
  setEntryU32(dot, EntryField.length, 2);
  root.set(dot, 0);
  root.set(makeEntry({ mode: ROOT_DOTDOT_MODE, name: '..', created: options.now }), DIRENT_SIZE);
  w.writeCluster(allocOffset, root);

  // Superblock.
  const sb = new Uint8Array(PAGE_SIZE);
  const view = new DataView(sb.buffer);
  for (let i = 0; i < CARD_MAGIC.length; i++) sb[i] = CARD_MAGIC.charCodeAt(i);
  const version = '1.2.0.0';
  for (let i = 0; i < version.length; i++) sb[0x1c + i] = version.charCodeAt(i);
  view.setUint16(0x28, PAGE_SIZE, true);
  view.setUint16(0x2a, PAGES_PER_CLUSTER, true);
  view.setUint16(0x2c, PAGES_PER_ERASE_BLOCK, true);
  view.setUint16(0x2e, 0xff00, true);
  view.setUint32(0x30, clustersPerCard, true);
  view.setUint32(0x34, allocOffset, true);
  view.setUint32(0x38, allocEnd, true);
  view.setUint32(0x3c, 0, true);
  view.setUint32(0x40, goodBlock1, true);
  view.setUint32(0x44, goodBlock2, true);
  for (let i = 0; i < ifcCount; i++) view.setUint32(0x50 + i * 4, firstIfc + i, true);
  for (let i = 0; i < 32; i++) view.setUint32(0xd0 + i * 4, 0xffffffff, true);
  sb[0x150] = 2; // card type: PS2
  sb[0x151] = 0x2b; // card flags
  w.writePage(0, sb);

  // mymc leaves the second backup erase block erased (all 0xFF, spare included).
  const erased = new Uint8Array(rawPage).fill(0xff);
  for (let p = 0; p < PAGES_PER_ERASE_BLOCK; p++) w.writeRawPage(goodBlock2 * PAGES_PER_ERASE_BLOCK + p, erased);

  return bytes;
}
