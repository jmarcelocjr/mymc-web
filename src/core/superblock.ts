import { ByteReader, latin1 } from './binary';
import { CardError } from './errors';

export const CARD_MAGIC = 'Sony PS2 Memory Card Format ';
export const SUPERBLOCK_SIZE = 0x154;
export const ENTRIES_PER_FAT_CLUSTER = 256; // 1024-byte cluster / 4-byte entries

export interface Superblock {
  version: string;
  pageSize: number;
  pagesPerCluster: number;
  pagesPerEraseBlock: number;
  clustersPerCard: number;
  /** First cluster of the data area; data cluster numbers in chains are relative to it. */
  allocOffset: number;
  /** Number of FAT entries (data clusters) in use by the filesystem. */
  allocEnd: number;
  rootDirCluster: number;
  backupBlock1: number;
  backupBlock2: number;
  /** Absolute clusters holding the indirect FAT (only the non-zero entries in use). */
  indirectFatClusters: number[];
  badBlocks: number[];
  cardType: number;
  cardFlags: number;
}

/** Physical layout of the image file. */
export interface Layout {
  hasEcc: boolean;
  pageSize: number;
  /** Bytes per page in the file: page + spare (16) with ECC, page only without. */
  rawPageSize: number;
  spareSize: number;
  pagesPerCluster: number;
  clusterSize: number;
  totalPages: number;
}

// Largest card PCSX2 can create is 64 MB (65536 clusters). Allow some headroom,
// but refuse absurd values that would only come from a damaged superblock.
const MAX_CLUSTERS = 1 << 20;

export function parseSuperblock(bytes: Uint8Array): Superblock {
  if (bytes.length < SUPERBLOCK_SIZE || latin1(bytes.subarray(0, 28)) !== CARD_MAGIC) {
    throw new CardError('not-a-card', 'Not a PS2 memory card image (signature not found).');
  }
  const r = new ByteReader(bytes);
  const ifc: number[] = [];
  for (let i = 0; i < 32; i++) ifc.push(r.u32(0x50 + i * 4));
  const bad: number[] = [];
  for (let i = 0; i < 32; i++) bad.push(r.u32(0xd0 + i * 4));

  const sb: Superblock = {
    version: r.cString(0x1c, 12),
    pageSize: r.u16(0x28),
    pagesPerCluster: r.u16(0x2a),
    pagesPerEraseBlock: r.u16(0x2c),
    clustersPerCard: r.u32(0x30),
    allocOffset: r.u32(0x34),
    allocEnd: r.u32(0x38),
    rootDirCluster: r.u32(0x3c),
    backupBlock1: r.u32(0x40),
    backupBlock2: r.u32(0x44),
    indirectFatClusters: [],
    badBlocks: bad,
    cardType: r.u8(0x150),
    cardFlags: r.u8(0x151),
  };

  const bad_ = (msg: string) => new CardError('bad-superblock', `Damaged or unsupported memory card: ${msg}.`);
  if (sb.pageSize !== 512) throw bad_(`page size ${sb.pageSize} (expected 512)`);
  if (sb.pagesPerCluster !== 2) throw bad_(`${sb.pagesPerCluster} pages per cluster (expected 2)`);
  if (sb.pagesPerEraseBlock === 0) throw bad_('erase block size is 0');
  if (sb.clustersPerCard === 0 || sb.clustersPerCard > MAX_CLUSTERS) throw bad_(`card has ${sb.clustersPerCard} clusters`);
  if (sb.allocOffset >= sb.clustersPerCard) throw bad_('data area starts past the end of the card');
  if (sb.allocEnd === 0 || sb.allocOffset + sb.allocEnd > sb.clustersPerCard) throw bad_('data area extends past the end of the card');
  if (sb.rootDirCluster >= sb.allocEnd) throw bad_('root directory is outside the data area');

  // The indirect FAT clusters needed to cover allocEnd entries.
  const fatClusters = Math.ceil(sb.allocEnd / ENTRIES_PER_FAT_CLUSTER);
  const indirectNeeded = Math.ceil(fatClusters / ENTRIES_PER_FAT_CLUSTER);
  if (indirectNeeded > 32) throw bad_('FAT is too large');
  for (let i = 0; i < indirectNeeded; i++) {
    const c = ifc[i]!;
    if (c >= sb.clustersPerCard) throw bad_(`indirect FAT cluster ${c} is outside the card`);
    sb.indirectFatClusters.push(c);
  }
  return sb;
}

/**
 * Work out whether the image stores ECC by comparing its size with the
 * superblock. The size alone is ambiguous: an 8 MB card with ECC
 * (8,650,752 bytes) is also a multiple of 512.
 */
export function detectLayout(fileSize: number, sb: Superblock): Layout {
  const totalPages = sb.clustersPerCard * sb.pagesPerCluster;
  const spareSize = Math.ceil(sb.pageSize / 128) * 4;
  const withEcc = totalPages * (sb.pageSize + spareSize);
  const withoutEcc = totalPages * sb.pageSize;
  let hasEcc: boolean;
  if (fileSize === withEcc) hasEcc = true;
  else if (fileSize === withoutEcc) hasEcc = false;
  else {
    throw new CardError(
      'bad-size',
      `File size (${fileSize} bytes) doesn't match the card's own description ` +
        `(${withEcc} bytes with ECC or ${withoutEcc} without). The file may be truncated or not a PS2 card.`,
    );
  }
  return {
    hasEcc,
    pageSize: sb.pageSize,
    spareSize: hasEcc ? spareSize : 0,
    rawPageSize: hasEcc ? sb.pageSize + spareSize : sb.pageSize,
    pagesPerCluster: sb.pagesPerCluster,
    clusterSize: sb.pageSize * sb.pagesPerCluster,
    totalPages,
  };
}
