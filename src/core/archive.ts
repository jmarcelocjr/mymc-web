import type { MemoryCard, ReadProblem } from './card';
import { MAX_DEPTH } from './card';
import { DIRENT_SIZE, Mode, isDir, isFile, parseDirEntry } from './dirent';
import { parseIconSys, parsePs1Title, type SaveTitle } from './iconsys';
import { CardError } from './errors';

/**
 * One entry to write on a card: a file with its data, or a directory with its
 * own "." and ".." entries and its children. `entry` is the 512-byte directory
 * entry as it will be written; length, cluster and slot fields are filled in
 * when the card is built, everything else (mode, dates, attr, name, unused
 * bytes) is kept as is.
 */
export interface ArchiveNode {
  entry: Uint8Array;
  /** The entry's name, for display and to find duplicates. */
  name: string;
  data?: Uint8Array;
  dir?: { dot: Uint8Array; dotdot: Uint8Array; children: ArchiveNode[] };
}

/** Everything in a card's root, ready to be written to a fresh card. */
export interface CardContents {
  /** The root's own "." and ".." entries. */
  dot: Uint8Array;
  dotdot: Uint8Array;
  entries: ArchiveNode[];
}

export interface ReadContentsResult {
  contents: CardContents;
  /** Root entries left out because they can't be read (see decision 4 of the plan). */
  unreadable: ReadProblem[];
}

const copy = (b: Uint8Array) => b.slice(0, DIRENT_SIZE);

/** Read one root entry (and everything under it) from a card. Throws CardError if any part can't be read. */
export function readNode(card: MemoryCard, path: string, depth = 1): ArchiveNode {
  if (depth > MAX_DEPTH) throw new CardError('too-deep', `Directories are nested too deeply: ${path}`);
  const entry = card.stat(path);
  if (isFile(entry)) return { entry: copy(entry.raw), name: entry.name, data: card.readFile(path).slice() };
  if (!isDir(entry)) throw new CardError('bad-directory', `${path} is neither a file nor a folder.`);
  const all = card.directoryWithDots(path);
  return {
    entry: copy(entry.raw),
    name: entry.name,
    dir: {
      dot: copy(all[0]!.raw),
      dotdot: copy(all[1]!.raw),
      children: all.slice(2).map((e) => readNode(card, `${path}/${e.name}`, depth + 1)),
    },
  };
}

/**
 * Everything on a card, as a list of root entries in card order. Entries
 * that can't be read are left out and listed in `unreadable`, so the caller
 * can ask the user before writing a card without them.
 */
export function readContents(card: MemoryCard): ReadContentsResult {
  const root = card.directoryWithDots('/');
  const entries: ArchiveNode[] = [];
  const unreadable: ReadProblem[] = [];
  for (const save of card.listSaves()) {
    if (!save.readable) {
      unreadable.push(save.problem ?? { path: `/${save.name}`, code: 'bad-directory', message: 'Unreadable.' });
      continue;
    }
    try {
      entries.push(readNode(card, `/${save.name}`));
    } catch (e) {
      if (!(e instanceof CardError)) throw e;
      unreadable.push({ path: `/${save.name}`, code: e.code, message: e.message });
    }
  }
  return { contents: { dot: copy(root[0]!.raw), dotdot: copy(root[1]!.raw), entries }, unreadable };
}

/** Name of a raw entry, as the reader decodes it. */
export function entryName(entry: Uint8Array): string {
  return parseDirEntry(entry, 0).name;
}

/** Bytes a node takes on the card: its entries and data in whole clusters (mymc's dir_size). */
export function nodeClusters(node: ArchiveNode, clusterSize = 1024): number {
  if (node.dir) {
    const own = Math.ceil(((2 + node.dir.children.length) * DIRENT_SIZE) / clusterSize);
    return own + node.dir.children.reduce((sum, c) => sum + nodeClusters(c, clusterSize), 0);
  }
  return Math.ceil((node.data?.length ?? 0) / clusterSize);
}

/**
 * The game's title for a save that isn't on a card yet (e.g. one being
 * imported), read the same way as for saves on a card: icon.sys for PS2
 * saves, the save file's header for PS1 saves.
 */
export function nodeTitle(node: ArchiveNode): SaveTitle | undefined {
  const files = node.dir?.children ?? [];
  const psx = (parseDirEntry(node.entry, 0).mode & Mode.PSX) !== 0;
  try {
    if (psx) {
      const save = files.find((f) => f.name === node.name && f.data);
      return save ? parsePs1Title(save.data!) : undefined;
    }
    const iconSys = files.find((f) => f.name === 'icon.sys' && f.data);
    return iconSys ? parseIconSys(iconSys.data!).title : undefined;
  } catch {
    return undefined;
  }
}
