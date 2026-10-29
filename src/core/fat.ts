import { CardError } from './errors';
import type { CardImage } from './image';
import { ENTRIES_PER_FAT_CLUSTER, type Superblock } from './superblock';

export const FAT_ALLOCATED = 0x80000000;
export const FAT_CHAIN_END = 0xffffffff;
export const FAT_FREE = 0x7fffffff;
export const FAT_CLUSTER_MASK = 0x7fffffff;

/**
 * The file allocation table, reached through two levels of indirection:
 * superblock ifc_list -> indirect FAT cluster -> FAT cluster -> entry.
 * FAT and indirect FAT clusters are absolute; entries index data clusters
 * relative to allocOffset.
 */
export class Fat {
  private readonly image: CardImage;
  private readonly sb: Superblock;
  private readonly cache = new Map<number, DataView>();

  constructor(image: CardImage, sb: Superblock) {
    this.image = image;
    this.sb = sb;
  }

  /** Number of FAT entries (data clusters). */
  get size(): number {
    return this.sb.allocEnd;
  }

  private clusterView(absolute: number): DataView {
    let view = this.cache.get(absolute);
    if (!view) {
      const data = this.image.cluster(absolute);
      view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      this.cache.set(absolute, view);
    }
    return view;
  }

  /** Raw FAT entry for data cluster `n`. */
  entry(n: number): number {
    if (!Number.isInteger(n) || n < 0 || n >= this.sb.allocEnd) {
      throw new CardError('out-of-bounds', `Cluster ${n} is outside the data area (0-${this.sb.allocEnd - 1}).`);
    }
    const fatIndex = Math.floor(n / ENTRIES_PER_FAT_CLUSTER);
    const indirectOffset = fatIndex % ENTRIES_PER_FAT_CLUSTER;
    const dblIndirectIndex = Math.floor(fatIndex / ENTRIES_PER_FAT_CLUSTER);
    const indirectCluster = this.sb.indirectFatClusters[dblIndirectIndex];
    if (indirectCluster === undefined) {
      throw new CardError('out-of-bounds', `No indirect FAT cluster for entry ${n}.`);
    }
    const fatCluster = this.clusterView(indirectCluster).getUint32(indirectOffset * 4, true);
    return this.clusterView(fatCluster).getUint32((n % ENTRIES_PER_FAT_CLUSTER) * 4, true);
  }

  isAllocated(n: number): boolean {
    return (this.entry(n) & FAT_ALLOCATED) !== 0;
  }

  /**
   * Follow a cluster chain from `first`. Stops after `limit` clusters if given.
   * Throws on loops, clusters outside the data area, and links to free clusters.
   */
  chain(first: number, limit = Infinity): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    let c = first;
    while (out.length < limit) {
      if (c < 0 || c >= this.sb.allocEnd) {
        throw new CardError('out-of-bounds', `Cluster chain points outside the data area (cluster ${c}).`);
      }
      if (seen.has(c)) {
        throw new CardError('fat-cycle', `Cluster chain loops back to cluster ${c}.`);
      }
      seen.add(c);
      out.push(c);
      const next = this.entry(c);
      if (next === FAT_CHAIN_END) break;
      if ((next & FAT_ALLOCATED) === 0) {
        throw new CardError('bad-chain', `Cluster chain continues into free cluster ${next & FAT_CLUSTER_MASK}.`);
      }
      c = next & FAT_CLUSTER_MASK;
    }
    return out;
  }

  /** Free data clusters, counted the way mymc does (entries 0 to allocEnd - 1). */
  freeClusters(): number {
    let free = 0;
    for (let n = 0; n < this.sb.allocEnd; n++) {
      if (!this.isAllocated(n)) free++;
    }
    return free;
  }
}
