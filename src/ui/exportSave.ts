import { zipSync, type Zippable } from 'fflate';
import { exportPsu, isDir, type MemoryCard, type SaveSummary } from '../core';
import { todToDate } from './format';

export type ExportFormat = 'psu' | 'zip';

export interface ExportedFile {
  fileName: string;
  bytes: Uint8Array;
  /** Anything left out, to tell the user. */
  skipped: string[];
}

/** A file name safe on every desktop OS. Card names are ASCII-ish but may hold anything. */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '');
  return cleaned || 'save';
}

/** Zip timestamps can't go before 1980; leave those to the zip default. */
function zipTime(save: { modified: SaveSummary['entry']['modified'] }): { mtime?: Date } {
  const d = todToDate(save.modified);
  return d && d.getUTCFullYear() >= 1980 ? { mtime: d } : {};
}

/** Whether a save can be exported in a format. */
export function canExport(save: SaveSummary, format: ExportFormat): boolean {
  if (!save.readable) return false;
  return format === 'zip' || isDir(save.entry);
}

/** Build the file to download for a save. */
export function exportSave(card: MemoryCard, save: SaveSummary, format: ExportFormat): ExportedFile {
  const base = safeFileName(save.name);
  if (format === 'psu') {
    const { bytes, skipped } = exportPsu(card, save.name);
    return { fileName: `${base}.psu`, bytes, skipped };
  }

  // .zip: the save's folder with its files as they are on the card.
  if (!isDir(save.entry)) {
    const data = card.readFile(`/${save.name}`);
    return { fileName: `${base}.zip`, bytes: zipSync({ [base]: [data, zipTime(save.entry)] }), skipped: [] };
  }
  const folder: Zippable = {};
  const skipped: string[] = [];
  for (const f of card.readDir(`/${save.name}`)) {
    if (isDir(f)) {
      skipped.push(f.name);
      continue;
    }
    folder[safeFileName(f.name)] = [card.readFile(`/${save.name}/${f.name}`), zipTime(f)];
  }
  return { fileName: `${base}.zip`, bytes: zipSync({ [base]: [folder, zipTime(save.entry)] }), skipped };
}
