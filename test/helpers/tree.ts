import { createHash } from 'node:crypto';
import { isDir, type DirEntry, type MemoryCard, type Tod } from '../../src/core';
import type { GoldenEntry } from './fixtures';

const todList = (t: Tod) => [t.seconds, t.minutes, t.hours, t.day, t.month, t.year];

function ranges(chain: number[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const c of chain) {
    const last = runs[runs.length - 1];
    if (last && last[0] + last[1] === c) last[1]++;
    else runs.push([c, 1]);
  }
  return runs;
}

/** The card's tree in the same shape as the golden JSON written by make_fixtures.py. */
export function describeTree(card: MemoryCard, path = '/'): GoldenEntry[] {
  return card.readDir(path).map((e: DirEntry) => {
    const child = path === '/' ? `/${e.name}` : `${path}/${e.name}`;
    const out: GoldenEntry = {
      name: e.name,
      mode: e.mode,
      length: e.length,
      created: todList(e.created),
      modified: todList(e.modified),
      cluster: e.cluster,
      attr: e.attr,
    };
    if (isDir(e)) {
      out.chain = ranges(card.clusterChain(e.cluster));
      out.children = describeTree(card, child);
    } else {
      if (e.length > 0) out.chain = ranges(card.clusterChain(e.cluster));
      out.sha256 = createHash('sha256').update(card.readFile(child)).digest('hex');
    }
    return out;
  });
}

export interface MymcDirSave {
  name: string;
  title: [string, string];
  kb: number;
  protection: string;
}

/** Parse the text of `mymc++ dir` (format from mymc.py do_dir). */
export function parseMymcDir(text: string): { saves: MymcDirSave[]; freeKb: number } {
  // mymc++ prints "corrected N" to stdout when it probes ECC on a card that has none.
  const clean = text.split('\n').filter((l) => !/^corrected \d$/.test(l)).join('\n');
  const blocks = clean.trimEnd().split('\n\n');
  const free = blocks.pop()!.trim();
  const saves = blocks.map((block) => {
    const [l1, l2] = block.split('\n') as [string, string];
    return {
      name: l1.slice(0, 32).trimEnd(),
      title: [l1.slice(33), l2.slice(33)] as [string, string],
      kb: Number(l2.slice(0, 4).trim()),
      protection: l2.slice(7, 32).trimEnd(),
    };
  });
  return { saves, freeKb: Number(free.replace(/ KB Free$/, '').replace(/,/g, '')) };
}
