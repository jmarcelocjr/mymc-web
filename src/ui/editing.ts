import {
  CardError,
  cardCapacity,
  contentsClusters,
  openCard,
  parseDirEntry,
  rebuildCard,
  type ArchiveNode,
  type CardContents,
  type MemoryCard,
  type Tod,
} from '../core';

/** The contents without one root entry. */
export function withoutSave(contents: CardContents, name: string): CardContents {
  return { ...contents, entries: contents.entries.filter((e) => e.name !== name) };
}

/** The contents with a save added at the end, or in place of the one with the same name. */
export function withSave(contents: CardContents, node: ArchiveNode): CardContents {
  const index = contents.entries.findIndex((e) => e.name === node.name);
  if (index < 0) return { ...contents, entries: [...contents.entries, node] };
  const entries = contents.entries.slice();
  entries[index] = node;
  return { ...contents, entries };
}

/** Bytes still free if the card held these contents (negative when they don't fit). */
export function freeAfter(card: MemoryCard, contents: CardContents): number {
  return (cardCapacity(card.superblock) - contentsClusters(contents, card.clusterSize)) * card.clusterSize;
}

/** Last-modified time of a save, as stored. */
export function modifiedOf(node: ArchiveNode): Tod {
  return parseDirEntry(node.entry, 0).modified;
}

/**
 * Write the contents to a fresh card based on `card` and open it. The new card
 * is checked against the contents first; a CardError explains any failure.
 */
export function applyContents(card: MemoryCard, contents: CardContents): MemoryCard {
  const free = freeAfter(card, contents);
  if (free < 0) {
    throw new CardError('no-space', `Not enough space on the card: ${Math.ceil(-free / 1024)} KB more is needed.`);
  }
  return openCard(rebuildCard(card.bytes, contents));
}
