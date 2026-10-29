import { CardError, type CardErrorCode } from './errors';
import { eccCheckPage } from './ecc';
import { Fat } from './fat';
import { CardImage } from './image';
import { DIRENT_SIZE, Mode, exists, isDir, isFile, parseDirEntry, protectionOf, type DirEntry, type Protection } from './dirent';
import { parseIconSys, parsePs1Title, type IconSys, type SaveTitle } from './iconsys';
import { detectLayout, parseSuperblock, type Layout, type Superblock } from './superblock';

/** PS2 saves are one level deep; anything much deeper is a damaged (looping) directory tree. */
export const MAX_DEPTH = 8;

export type SaveKind = 'ps2' | 'ps1' | 'pocketstation' | 'unknown' | 'file';

export interface ReadProblem {
  /** Path on the card, e.g. "/BASLUS-21005SAVE" or "/BASLUS-21005SAVE/data.bin". */
  path: string;
  code: CardErrorCode;
  message: string;
}

/** One entry in the card's root: usually a save directory. */
export interface SaveSummary {
  name: string;
  entry: DirEntry;
  kind: SaveKind;
  title?: SaveTitle;
  iconSys?: IconSys;
  /** Why icon.sys couldn't be used, when a PS2 save has a broken one. */
  iconSysError?: string;
  /** Space used on the card, as the PS2 browser counts it (whole clusters, directory included). */
  sizeOnCard: number;
  protection: Protection;
  hidden: boolean;
  /** False when some part of the save can't be read; see `problem`. */
  readable: boolean;
  problem?: ReadProblem;
}

export interface EccReport {
  pagesChecked: number;
  /** Pages with a single-bit error that ECC can repair. */
  corrected: number[];
  /** Pages whose data doesn't match their ECC. */
  failed: number[];
  /**
   * The subset of `failed` that holds filesystem data (superblock, FAT or a
   * used data cluster). Failures elsewhere don't affect any save.
   */
  failedInUse: number[];
}

const roundUp = (n: number, to: number) => Math.ceil(n / to) * to;

export class MemoryCard {
  readonly superblock: Superblock;
  readonly layout: Layout;
  readonly bytes: Uint8Array;
  private readonly image: CardImage;
  private readonly fat: Fat;
  private rootCache?: DirEntry[];
  private savesCache?: SaveSummary[];

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.superblock = parseSuperblock(bytes);
    this.layout = detectLayout(bytes.length, this.superblock);
    this.image = new CardImage(bytes, this.layout);
    this.fat = new Fat(this.image, this.superblock);
    // Reading the root up front: a card without a usable root can't be shown at all.
    this.rootEntries();
  }

  get hasEcc(): boolean {
    return this.layout.hasEcc;
  }

  get clusterSize(): number {
    return this.layout.clusterSize;
  }

  freeBytes(): number {
    return this.fat.freeClusters() * this.clusterSize;
  }

  /** The data clusters of a chain (relative to allocOffset). */
  clusterChain(first: number): number[] {
    return this.fat.chain(first);
  }

  // ------------------------------------------------------------- low level

  /** Read `length` bytes following the chain from `first`. */
  private readChain(first: number, length: number): Uint8Array {
    if (length === 0) return new Uint8Array(0);
    const needed = Math.ceil(length / this.clusterSize);
    const chain = this.fat.chain(first, needed);
    if (chain.length < needed) {
      throw new CardError('bad-chain', `Data ends after ${chain.length} of ${needed} clusters.`);
    }
    const out = new Uint8Array(needed * this.clusterSize);
    chain.forEach((c, i) => out.set(this.image.cluster(c + this.superblock.allocOffset), i * this.clusterSize));
    return out.subarray(0, length);
  }

  /** All entries of a directory, including ".", ".." and deleted ones. */
  private readDirectory(first: number, entryCount: number): DirEntry[] {
    if (entryCount < 2) {
      throw new CardError('bad-directory', `Directory has ${entryCount} entries (needs at least "." and "..").`);
    }
    const data = this.readChain(first, entryCount * DIRENT_SIZE);
    const entries: DirEntry[] = [];
    for (let i = 0; i < entryCount; i++) {
      entries.push(parseDirEntry(data.subarray(i * DIRENT_SIZE, (i + 1) * DIRENT_SIZE), i));
    }
    if (entries[0]!.name !== '.' || entries[1]!.name !== '..') {
      throw new CardError('bad-directory', 'Directory is missing its "." and ".." entries.');
    }
    return entries;
  }

  private rootEntries(): DirEntry[] {
    if (!this.rootCache) {
      try {
        const first = this.readChain(this.superblock.rootDirCluster, DIRENT_SIZE);
        const dot = parseDirEntry(first, 0);
        if (dot.name !== '.' || !isDir(dot)) {
          throw new CardError('bad-directory', 'Root directory is damaged.');
        }
        this.rootCache = this.readDirectory(this.superblock.rootDirCluster, dot.length);
      } catch (e) {
        if (e instanceof CardError) {
          throw new CardError('bad-directory', `The card's root directory can't be read: ${e.message}`);
        }
        throw e;
      }
    }
    return this.rootCache;
  }

  /** Entries of a directory entry's contents, existing ones only, without "." and "..". */
  private children(dir: DirEntry): DirEntry[] {
    return this.readDirectory(dir.cluster, dir.length).filter((e, i) => i >= 2 && exists(e));
  }

  /** Find the entry at `path`. Returns undefined for "/" (the root has no entry of its own). */
  private resolve(path: string): DirEntry | undefined {
    const parts = path.split('/').filter((p) => p !== '' && p !== '.');
    if (parts.length > MAX_DEPTH) throw new CardError('too-deep', `Path is nested too deeply: ${path}`);
    let entries = this.rootEntries().filter((e, i) => i >= 2 && exists(e));
    let found: DirEntry | undefined;
    for (let i = 0; i < parts.length; i++) {
      found = entries.find((e) => e.name === parts[i]);
      if (!found) throw new CardError('not-found', `Not found: ${path}`);
      if (i < parts.length - 1) {
        if (!isDir(found)) throw new CardError('not-a-directory', `Not a directory: ${parts.slice(0, i + 1).join('/')}`);
        entries = this.children(found);
      }
    }
    return found;
  }

  // ------------------------------------------------------------- public reading

  /** Existing entries of a directory ("/" for the root), without "." and "..". */
  readDir(path: string): DirEntry[] {
    const dir = this.resolve(path);
    if (!dir) return this.rootEntries().filter((e, i) => i >= 2 && exists(e));
    if (!isDir(dir)) throw new CardError('not-a-directory', `Not a directory: ${path}`);
    return this.children(dir);
  }

  /**
   * A directory's "." and ".." entries followed by its existing entries, in
   * card order ("/" for the root). Rebuilding the card keeps all of them.
   */
  directoryWithDots(path: string): DirEntry[] {
    const dir = this.resolve(path);
    let all: DirEntry[];
    if (!dir) all = this.rootEntries();
    else if (!isDir(dir)) throw new CardError('not-a-directory', `Not a directory: ${path}`);
    else all = this.readDirectory(dir.cluster, dir.length);
    return all.filter((e, i) => i < 2 || exists(e));
  }

  stat(path: string): DirEntry {
    const e = this.resolve(path);
    if (!e) return this.rootEntries()[0]!;
    return e;
  }

  readFile(path: string): Uint8Array {
    const e = this.resolve(path);
    if (!e || !isFile(e)) throw new CardError('not-a-file', `Not a file: ${path}`);
    return this.readChain(e.cluster, e.length);
  }

  /** Every root entry (saves, loose files), with titles, sizes and readability. */
  listSaves(): SaveSummary[] {
    if (!this.savesCache) {
      this.savesCache = this.rootEntries()
        .filter((e, i) => i >= 2 && exists(e))
        .map((e) => this.summarize(e));
    }
    return this.savesCache;
  }

  /** Everything on the card that couldn't be read. Empty for a healthy card. */
  problems(): ReadProblem[] {
    return this.listSaves().flatMap((s) => (s.problem ? [s.problem] : []));
  }

  /** Check every page against its ECC. Reading ignores ECC; this reports damage. */
  checkEcc(): EccReport {
    const report: EccReport = { pagesChecked: 0, corrected: [], failed: [], failedInUse: [] };
    if (!this.hasEcc) return report;
    for (let p = 0; p < this.layout.totalPages; p++) {
      const page = this.image.page(p);
      const spare = this.image.spare(p);
      // Erased pages (all 0xFF, spare included) have no ECC to check.
      if (page.every((b) => b === 0xff) && spare.every((b) => b === 0xff)) continue;
      report.pagesChecked++;
      const status = eccCheckPage(page, spare);
      if (status === 'corrected') report.corrected.push(p);
      else if (status === 'failed') report.failed.push(p);
    }
    if (report.failed.length > 0) {
      const inUse = this.clustersInUse();
      report.failedInUse = report.failed.filter(
        (p) => p === 0 || inUse.has(Math.floor(p / this.layout.pagesPerCluster)),
      );
    }
    return report;
  }

  /**
   * Absolute clusters holding filesystem data: the indirect FAT, the FAT and
   * every allocated data cluster. (The superblock is only page 0 of cluster 0.)
   */
  private clustersInUse(): Set<number> {
    const sb = this.superblock;
    const used = new Set<number>(sb.indirectFatClusters);
    const fatClusters = Math.ceil(sb.allocEnd / 256);
    for (let k = 0; k < fatClusters; k++) {
      const ifc = this.image.cluster(sb.indirectFatClusters[Math.floor(k / 256)]!);
      used.add(new DataView(ifc.buffer, ifc.byteOffset).getUint32((k % 256) * 4, true));
    }
    for (let n = 0; n < sb.allocEnd; n++) {
      if (this.fat.isAllocated(n)) used.add(n + sb.allocOffset);
    }
    return used;
  }

  // ------------------------------------------------------------- summaries

  private summarize(entry: DirEntry): SaveSummary {
    const path = `/${entry.name}`;
    const base = {
      name: entry.name,
      entry,
      protection: protectionOf(entry.mode),
      hidden: (entry.mode & Mode.HIDDEN) !== 0,
    };

    if (!isDir(entry)) {
      try {
        this.readChain(entry.cluster, entry.length);
        return { ...base, kind: 'file', sizeOnCard: roundUp(entry.length, this.clusterSize), readable: true };
      } catch (e) {
        return { ...base, kind: 'file', sizeOnCard: roundUp(entry.length, this.clusterSize), ...unreadable(path, e) };
      }
    }

    const psx = (entry.mode & Mode.PSX) !== 0;
    const kind: SaveKind = psx ? ((entry.mode & Mode.POCKETSTATION) !== 0 ? 'pocketstation' : 'ps1') : 'ps2';
    let sizeOnCard: number;
    try {
      sizeOnCard = this.checkTree(entry, path, 1);
    } catch (e) {
      return { ...base, kind, sizeOnCard: 0, ...unreadable(path, e) };
    }

    const summary: SaveSummary = { ...base, kind, sizeOnCard, readable: true };
    const files = this.children(entry);
    if (psx) {
      const saveFile = files.find((f) => f.name === entry.name && isFile(f));
      const title = saveFile ? parsePs1Title(this.readChain(saveFile.cluster, saveFile.length)) : undefined;
      if (title) summary.title = title;
      return summary;
    }
    const iconSysEntry = files.find((f) => f.name === 'icon.sys' && isFile(f));
    if (!iconSysEntry) {
      summary.kind = 'unknown';
      return summary;
    }
    try {
      const iconSys = parseIconSys(this.readChain(iconSysEntry.cluster, iconSysEntry.length));
      summary.iconSys = iconSys;
      summary.title = iconSys.title;
    } catch (e) {
      summary.kind = 'unknown';
      summary.iconSysError = e instanceof Error ? e.message : String(e);
    }
    return summary;
  }

  /**
   * Make sure every file and subdirectory under `dir` can be read, and return
   * the space it takes (mymc's dir_size: the directory's own entries plus each
   * file, all rounded up to whole clusters). Throws with the failing path.
   */
  private checkTree(dir: DirEntry, path: string, depth: number): number {
    if (depth > MAX_DEPTH) throw new PathError(path, new CardError('too-deep', 'Directories are nested too deeply (likely a loop).'));
    let all: DirEntry[];
    try {
      all = this.readDirectory(dir.cluster, dir.length);
    } catch (e) {
      throw new PathError(path, e);
    }
    let size = roundUp(all.length * DIRENT_SIZE, this.clusterSize);
    for (const e of all.slice(2)) {
      const child = `${path}/${e.name}`;
      if (isFile(e)) {
        try {
          this.readChain(e.cluster, e.length);
        } catch (err) {
          throw new PathError(child, err);
        }
        size += roundUp(e.length, this.clusterSize);
      } else if (isDir(e)) {
        size += this.checkTree(e, child, depth + 1);
      }
    }
    return size;
  }
}

/** Carries the path where a read failed up to the save being summarized. */
class PathError extends Error {
  readonly path: string;
  override readonly cause: unknown;

  constructor(path: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.path = cause instanceof PathError ? cause.path : path;
    this.cause = cause instanceof PathError ? cause.cause : cause;
  }
}

function unreadable(path: string, e: unknown): { readable: false; problem: ReadProblem } {
  let at = path;
  let err = e;
  if (e instanceof PathError) {
    at = e.path;
    err = e.cause;
  }
  if (!(err instanceof CardError)) throw err; // a bug in our code, not a damaged card
  return { readable: false, problem: { path: at, code: err.code, message: err.message } };
}

/** Open a memory card image. Throws CardError when the file isn't a usable PS2 card. */
export function openCard(bytes: Uint8Array): MemoryCard {
  return new MemoryCard(bytes);
}
