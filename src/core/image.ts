import { CardError } from './errors';
import type { Layout } from './superblock';

/** Page and cluster access on the raw image, skipping the ECC spare area. */
export class CardImage {
  readonly bytes: Uint8Array;
  readonly layout: Layout;

  constructor(bytes: Uint8Array, layout: Layout) {
    this.bytes = bytes;
    this.layout = layout;
  }

  /** Data part of page `n` (a view, not a copy). */
  page(n: number): Uint8Array {
    this.checkPage(n);
    const start = n * this.layout.rawPageSize;
    return this.bytes.subarray(start, start + this.layout.pageSize);
  }

  /** Spare (ECC) part of page `n`; empty without ECC. */
  spare(n: number): Uint8Array {
    this.checkPage(n);
    const start = n * this.layout.rawPageSize + this.layout.pageSize;
    return this.bytes.subarray(start, start + this.layout.spareSize);
  }

  /** Data of absolute cluster `n` (1024 bytes). */
  cluster(n: number): Uint8Array {
    const { pagesPerCluster, pageSize, hasEcc, clusterSize } = this.layout;
    if (!Number.isInteger(n) || n < 0 || n * pagesPerCluster >= this.layout.totalPages) {
      throw new CardError('out-of-bounds', `Cluster ${n} is outside the card.`);
    }
    if (!hasEcc) {
      return this.bytes.subarray(n * clusterSize, (n + 1) * clusterSize);
    }
    const out = new Uint8Array(clusterSize);
    for (let p = 0; p < pagesPerCluster; p++) {
      out.set(this.page(n * pagesPerCluster + p), p * pageSize);
    }
    return out;
  }

  private checkPage(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n >= this.layout.totalPages) {
      throw new CardError('out-of-bounds', `Page ${n} is outside the card.`);
    }
  }
}
