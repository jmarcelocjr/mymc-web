import { eccSpare } from './ecc';
import type { Layout } from './superblock';

/** Writes pages and clusters into a raw card image, computing ECC as it goes. */
export class ImageWriter {
  private zeroSpare?: Uint8Array;

  constructor(
    readonly bytes: Uint8Array,
    readonly layout: Layout,
  ) {}

  /** Write one page of data (pageSize bytes) and its ECC. */
  writePage(n: number, data: Uint8Array): void {
    const { rawPageSize, pageSize, hasEcc } = this.layout;
    const start = n * rawPageSize;
    if (data.length !== pageSize || start + rawPageSize > this.bytes.length) {
      throw new RangeError(`writePage: page ${n} out of range or wrong size`);
    }
    this.bytes.set(data, start);
    if (hasEcc) this.bytes.set(this.spareFor(data), start + pageSize);
  }

  /** Write one cluster (clusterSize bytes) at an absolute cluster number. */
  writeCluster(n: number, data: Uint8Array): void {
    const { pageSize, pagesPerCluster } = this.layout;
    for (let p = 0; p < pagesPerCluster; p++) {
      this.writePage(n * pagesPerCluster + p, data.subarray(p * pageSize, (p + 1) * pageSize));
    }
  }

  /** Raw bytes of a page, data and spare, e.g. to fill an erase block with 0xFF. */
  writeRawPage(n: number, raw: Uint8Array): void {
    this.bytes.set(raw, n * this.layout.rawPageSize);
  }

  private spareFor(data: Uint8Array): Uint8Array {
    // Most pages of a fresh card are zeros; compute their ECC once.
    if (data.every((b) => b === 0)) {
      this.zeroSpare ??= eccSpare(new Uint8Array(this.layout.pageSize), this.layout.spareSize);
      return this.zeroSpare;
    }
    return eccSpare(data, this.layout.spareSize);
  }
}
