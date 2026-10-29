import type { SaveKind, SaveSummary, Tod } from '../core';

export function formatKb(bytes: number): string {
  return `${Math.floor(bytes / 1024).toLocaleString('en-US')} KB`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toLocaleString('en-US', { maximumFractionDigits: 1 })} KB`;
}

/** Card timestamps are Japan time (UTC+9). Returns undefined for blank or invalid dates. */
export function todToDate(t: Tod): Date | undefined {
  if (!t.year || t.month < 1 || t.month > 12 || t.day < 1 || t.day > 31) return undefined;
  const d = new Date(Date.UTC(t.year, t.month - 1, t.day, t.hours - 9, t.minutes, t.seconds));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function formatTod(t: Tod): string {
  const d = todToDate(t);
  return d ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

export const KIND_LABEL: Record<SaveKind, string> = {
  ps2: 'PS2 save',
  ps1: 'PS1 save',
  pocketstation: 'PocketStation',
  unknown: 'Unknown',
  file: 'File',
};

export const PROTECTION_LABEL: Record<SaveSummary['protection'], string> = {
  none: 'Not protected',
  copy: 'Copy protected',
  delete: 'Delete protected',
  'copy-and-delete': 'Copy & delete protected',
};

/** Title lines for display; saves without icon.sys show their directory name. */
export function displayTitle(save: SaveSummary): [string, string] {
  if (save.title) return save.title.display;
  return [save.name, ''];
}
