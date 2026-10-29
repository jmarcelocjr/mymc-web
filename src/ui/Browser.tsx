import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CARD_SIZES,
  CardError,
  nodeClusters,
  nodeTitle,
  parseSaveFile,
  readContents,
  todFromDate,
  type CardSizeMb,
  type ImportedSave,
  type MemoryCard,
  type SaveSummary,
  type Tod,
} from '../core';
import type { Session } from './App';
import { useDialog } from './Dialog';
import { IconGrid, type GridApi } from './IconGrid';
import { SaveDetails } from './SaveDetails';
import { download } from './download';
import { applyContents, freeAfter, modifiedOf, withSave, withoutSave } from './editing';
import { canExport, exportSave, type ExportFormat } from './exportSave';
import { displayTitle, formatKb, formatTod, todToDate } from './format';

/** Save files dropped or picked while a card is open. */
export interface ImportRequest {
  files: { name: string; bytes: Uint8Array }[];
  id: number;
}

const errorText = (e: unknown) => (e instanceof CardError ? e.message : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
/** How an incoming save's date compares with the one on the card. */
function compareAge(incoming: Tod, onCard: Tod): string {
  const a = todToDate(incoming)?.getTime();
  const b = todToDate(onCard)?.getTime();
  if (a === undefined || b === undefined) return '';
  if (a === b) return '— same date';
  return a > b ? '— this one is newer' : '— this one is older';
}

const canDelete = (s: SaveSummary) => s.protection === 'none' || s.protection === 'copy';

type SortKey = 'card' | 'title' | 'folder' | 'size' | 'modified';

const SORTS: Record<SortKey, { label: string; compare?: (a: SaveSummary, b: SaveSummary) => number }> = {
  card: { label: 'Card order' },
  title: { label: 'Title', compare: (a, b) => displayTitle(a).join(' ').localeCompare(displayTitle(b).join(' ')) },
  folder: { label: 'Folder name', compare: (a, b) => a.name.localeCompare(b.name) },
  size: { label: 'Size', compare: (a, b) => b.sizeOnCard - a.sizeOnCard },
  modified: {
    label: 'Last modified',
    compare: (a, b) => (todToDate(b.entry.modified)?.getTime() ?? 0) - (todToDate(a.entry.modified)?.getTime() ?? 0),
  },
};

interface Props {
  session: Session;
  importRequest: ImportRequest | null;
  onImportHandled: () => void;
  onOpenFile: () => void;
  onNewCard: (size: CardSizeMb) => void;
  onChange: (card: MemoryCard, change: string) => void;
  onReadOnly: () => void;
  onDownload: () => void;
  onDiscard: () => void;
}

export function Browser({ session, importRequest, onImportHandled, onOpenFile, onNewCard, onChange, onReadOnly, onDownload, onDiscard }: Props) {
  const { card, fileName } = session;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('card');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [columns, setColumns] = useState(5);
  const grid = useRef<GridApi | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const { dialog, ask, isOpen: dialogOpen } = useDialog();
  const [busy, setBusy] = useState<string | null>(null);
  /** An animation to play once the grid shows the new card (after an import). */
  const pendingAnimation = useRef<string | null>(null);

  // Notices go away on their own after a few seconds.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.error ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const doExport = useCallback(
    (save: SaveSummary, format: ExportFormat) => {
      if (!canExport(save, format)) return;
      try {
        const file = exportSave(card, save, format);
        download(file);
        // Show the save's copy animation while the download starts.
        setDetailsOpen(false);
        void grid.current?.playAction(save.name, 'copy');
        setNotice({
          text:
            `Downloaded ${file.fileName}` +
            (file.skipped.length ? ` (left out subfolders it can't hold: ${file.skipped.join(', ')})` : '.'),
        });
      } catch (e) {
        setNotice({ text: `Couldn't export ${save.name}: ${e instanceof CardError ? e.message : String(e)}`, error: true });
      }
    },
    [card],
  );

  const all = useMemo(() => card.listSaves(), [card]);
  const problems = useMemo(() => card.problems(), [card]);
  const eccInUse = useMemo(() => card.checkEcc().failedInUse.length, [card]);
  const free = useMemo(() => card.freeBytes(), [card]);
  const capacity = card.superblock.allocEnd * card.clusterSize;

  const saves = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? all.filter((s) => `${displayTitle(s).join(' ')} ${s.title?.lines.join(' ') ?? ''} ${s.name}`.toLowerCase().includes(q))
      : all.slice();
    const compare = SORTS[sort].compare;
    return compare ? list.sort(compare) : list;
  }, [all, query, sort]);

  const found = saves.findIndex((s) => s.name === selectedName);
  const selected = saves.length === 0 ? -1 : Math.max(found, 0);
  const current = saves[selected];

  const select = useCallback(
    (i: number) => {
      const s = saves[Math.min(Math.max(i, 0), saves.length - 1)];
      if (s) setSelectedName(s.name);
    },
    [saves],
  );

  // ------------------------------------------------------------ editing

  /**
   * Writing makes a new card from the saves that can be read. If some can't,
   * ask once whether to go on without them or keep the card read-only.
   */
  const ensureWritable = useCallback(async (): Promise<string[] | null> => {
    if (session.readOnly) {
      setNotice({ text: 'This card is read-only for now, because some saves on it can\'t be read. Open it again to choose differently.', error: true });
      return null;
    }
    const { unreadable } = readContents(card);
    if (unreadable.length === 0) return [];
    const choice = await ask({
      title: 'Some saves can\'t be read',
      body: (
        <>
          <p>A new card can only hold the saves that can be read. These would be left out:</p>
          <ul>
            {unreadable.map((p) => (
              <li key={p.path}>
                <span className="mono">{p.path.slice(1)}</span>: {p.message}
              </li>
            ))}
          </ul>
          <p>Your original file keeps them either way.</p>
        </>
      ),
      actions: [
        { label: 'Keep read-only', value: 'read-only' },
        { label: 'Continue without them', value: 'continue', kind: 'danger' },
      ],
    });
    if (choice === 'continue') return unreadable.map((p) => p.path.split('/')[1]!);
    if (choice === 'read-only') onReadOnly();
    return null;
  }, [card, session.readOnly, ask, onReadOnly]);

  /** The change description, noting saves that were left out because they can't be read. */
  const describe = (change: string, dropped: string[]) =>
    dropped.length ? `Left out unreadable ${dropped.join(', ')} · ${change}` : change;

  /** Build the new card off the main path of the click, showing a busy note meanwhile. */
  const rebuild = useCallback(async (label: string, make: () => MemoryCard): Promise<MemoryCard | null> => {
    setBusy(label);
    await new Promise((r) => setTimeout(r, 30)); // let the note paint
    try {
      return make();
    } catch (e) {
      setNotice({ text: errorText(e), error: true });
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  const doDelete = useCallback(
    async (save: SaveSummary) => {
      const title = displayTitle(save).join(' ').trim() || save.name;
      if (!canDelete(save)) {
        setNotice({ text: `“${title}” is protected against deleting, like on the PS2.`, error: true });
        return;
      }
      const dropped = await ensureWritable();
      if (!dropped) return;
      const choice = await ask({
        title: 'Delete this save?',
        body: (
          <>
            <p>
              <strong>{title}</strong> <span className="mono">({save.name})</span>, {formatKb(save.sizeOnCard)}.
            </p>
            <p>Your original file isn't changed: this makes a new card for you to download.</p>
          </>
        ),
        actions: [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Delete', value: 'delete', kind: 'danger' },
        ],
      });
      if (choice !== 'delete') return;
      const next = await rebuild('Deleting…', () => applyContents(card, withoutSave(readContents(card).contents, save.name)));
      if (!next) return;
      setDetailsOpen(false);
      await grid.current?.playAction(save.name, 'delete', false);
      onChange(next, describe(`Deleted ${title}`, dropped));
    },
    [card, ask, ensureWritable, rebuild, onChange],
  );

  const doImport = useCallback(
    async (files: ImportRequest['files']) => {
      const parsed: ImportedSave[] = [];
      const failed: string[] = [];
      const now = todFromDate(new Date());
      for (const f of files) {
        try {
          parsed.push(parseSaveFile(f.bytes, now));
        } catch (e) {
          failed.push(`${f.name}: ${errorText(e)}`);
        }
      }
      if (failed.length) setNotice({ text: `Couldn't import ${failed.join('; ')}`, error: true });
      if (parsed.length === 0) return;
      const dropped = await ensureWritable();
      if (!dropped) return;

      // One summary of what's coming in: game, folder, size, date, and what it replaces.
      const base = readContents(card).contents;
      const byName = new Map(parsed.map((p) => [p.node.name, p])); // the same folder twice: the last one wins
      const items = [...byName.values()].map(({ node, warnings }) => {
        const title = nodeTitle(node)?.display.join(' ').replace(/\s+/g, ' ').trim();
        return {
          node,
          warnings,
          title: title || node.name,
          existing: base.entries.find((e) => e.name === node.name),
          size: nodeClusters(node, card.clusterSize) * card.clusterSize,
          files: node.dir?.children.length ?? 0,
        };
      });
      const fresh = items.filter((i) => !i.existing);
      const replacing = items.length - fresh.length;
      const plan = (list: typeof items) => list.reduce((c, i) => withSave(c, i.node), base);
      const freeText = (list: typeof items) => {
        const free = freeAfter(card, plan(list));
        return free < 0 ? `not enough space (${formatKb(-free)} more needed)` : `${formatKb(free)} free afterwards`;
      };

      const choice = await ask({
        title: items.length === 1 ? 'Import this save?' : `Import ${items.length} saves?`,
        body: (
          <>
            <ul className="import-list">
              {items.map((i) => (
                <li key={i.node.name}>
                  <div className="import-title">{i.title}</div>
                  <div className="hint">
                    <span className="mono">{i.node.name}</span> · {formatKb(i.size)} · {i.files} file{i.files === 1 ? '' : 's'} ·
                    modified {formatTod(modifiedOf(i.node))}
                  </div>
                  {i.existing && (
                    <div className="warning">
                      Already on the card (modified {formatTod(modifiedOf(i.existing))}){' '}
                      {compareAge(modifiedOf(i.node), modifiedOf(i.existing))}.
                    </div>
                  )}
                  {i.warnings.map((w) => (
                    <div key={w} className="warning">
                      {w}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
            <p className="hint">
              {replacing > 0 && fresh.length > 0
                ? `Replacing: ${freeText(items)}. Skipping those already on the card: ${freeText(fresh)}.`
                : `${freeText(items)[0]!.toUpperCase()}${freeText(items).slice(1)}.`}
            </p>
          </>
        ),
        actions: [
          { label: 'Cancel', value: 'cancel' },
          ...(replacing > 0 && fresh.length > 0 ? [{ label: 'Import new only', value: 'new' }] : []),
          replacing > 0
            ? { label: replacing === items.length && items.length === 1 ? 'Replace' : 'Import and replace', value: 'all', kind: 'danger' as const }
            : { label: 'Import', value: 'all', kind: 'primary' as const },
        ],
      });
      if (choice !== 'all' && choice !== 'new') return;
      const chosen = choice === 'all' ? items : fresh;
      if (chosen.length === 0) return;
      const contents = plan(chosen);
      const free = freeAfter(card, contents);
      if (free < 0) {
        setNotice({ text: `Not enough space on the card: ${formatKb(-free)} more is needed. Delete something first.`, error: true });
        return;
      }
      const added = chosen.map((i) => i.node.name);
      const next = await rebuild('Importing…', () => applyContents(card, contents));
      if (!next) return;
      pendingAnimation.current = added[added.length - 1]!;
      setSelectedName(pendingAnimation.current);
      const what = chosen.map((i) => (i.existing ? `${i.title} (replaced)` : i.title)).join(', ');
      onChange(next, describe(`Imported ${what}`, dropped));
    },
    [card, ask, ensureWritable, rebuild, onChange],
  );

  // Saves dropped or picked in the app come in through here.
  const handledImport = useRef<number | null>(null);
  useEffect(() => {
    if (!importRequest || handledImport.current === importRequest.id) return;
    handledImport.current = importRequest.id;
    onImportHandled();
    void doImport(importRequest.files);
  }, [importRequest, doImport, onImportHandled]);

  // After an import, the grid shows the new card; play the copy animation on the new save.
  useEffect(() => {
    const name = pendingAnimation.current;
    if (!name) return;
    pendingAnimation.current = null;
    void grid.current?.playAction(name, 'copy');
  }, [card]);

  const askNewCard = useCallback(async () => {
    const choice = await ask({
      title: 'Create a blank memory card',
      body: <p>A new, formatted card, the same as PCSX2 makes. Pick its size:</p>,
      actions: [
        { label: 'Cancel', value: 'cancel' },
        ...Object.keys(CARD_SIZES).map((mb) => ({ label: `${mb} MB`, value: mb, kind: mb === '8' ? ('primary' as const) : undefined })),
      ],
    });
    if (choice && choice !== 'cancel') onNewCard(Number(choice) as CardSizeMb);
  }, [ask, onNewCard]);

  // Keyboard: arrows move, Enter opens details, Escape goes back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialogOpen || busy) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, select, textarea, button, [tabindex]') && e.key !== 'Escape') return;
      if (e.key === 'Escape') {
        if (detailsOpen) setDetailsOpen(false);
        else if (target instanceof HTMLInputElement) target.blur();
        return;
      }
      if (detailsOpen || selected < 0) return;
      const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
      if (e.key in moves) {
        e.preventDefault();
        const next = selected + moves[e.key]!;
        if (next >= 0 && next < saves.length) select(next);
      } else if (e.key === 'Enter') {
        setDetailsOpen(true);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && saves[selected]) {
        e.preventDefault();
        void doDelete(saves[selected]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, saves, columns, detailsOpen, select, dialogOpen, busy, doDelete]);

  const [title1, title2] = current ? displayTitle(current) : ['', ''];
  const usedPct = capacity > 0 ? Math.min(100, ((capacity - free) / capacity) * 100) : 0;

  return (
    <main className="screen">
      <IconGrid
        card={card}
        saves={saves}
        selected={selected}
        onSelect={select}
        onOpen={(i) => {
          select(i);
          setDetailsOpen(true);
        }}
        onColumns={setColumns}
        apiRef={grid}
      />

      <header className="hud-top">
        <div className="card-info">
          <div className="card-name">
            Memory Card <span className="small">(PS2)</span>
          </div>
          <div className="card-free">{formatKb(free)} Free</div>
          <div className="usage" title={`${formatKb(capacity - free)} used of ${formatKb(capacity)}`}>
            <div className="usage-fill" style={{ width: `${usedPct}%` }} />
          </div>
          <div className="file-name" title={fileName}>
            {fileName}
            {card.hasEcc ? '' : ' · no ECC'}
            {session.readOnly ? ' · read-only' : ''}
          </div>
        </div>
        <div className="save-title" aria-live="polite">
          <div>{title1}</div>
          <div>{title2}</div>
        </div>
      </header>

      {(problems.length > 0 || eccInUse > 0) && (
        <div className="banner" role="alert">
          {problems.length > 0 && (
            <div>
              {problems.length === 1 ? "1 save can't be read" : `${problems.length} saves can't be read`}:{' '}
              {problems.map((p) => p.path.split('/')[1]).join(', ')}.
            </div>
          )}
          {eccInUse > 0 && <div>{eccInUse} page(s) with saved data fail their error check; the card may be damaged.</div>}
        </div>
      )}

      {all.length === 0 && <div className="empty">This memory card is empty.</div>}
      {all.length > 0 && saves.length === 0 && <div className="empty">No saves match “{query}”.</div>}

      <footer className="hud-bottom">
        {session.changes.length > 0 && (
          <div className="changes" role="status">
            <span>
              <strong>Not downloaded yet:</strong> {session.changes.join(' · ')}
            </span>
            <span className="changes-actions">
              <button type="button" className="primary-action" onClick={onDownload}>
                Download card
              </button>
              <button type="button" onClick={onDiscard}>
                Undo all
              </button>
            </span>
          </div>
        )}
        <div className="toolbar">
          <input
            type="search"
            placeholder="Search saves"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search saves"
          />
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort saves">
            {Object.entries(SORTS).map(([key, { label }]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <button type="button" onClick={onOpenFile} title="Open another card, or import .psu / .max saves into this one">
            Open / import…
          </button>
          <button type="button" onClick={() => void askNewCard()}>
            New card…
          </button>
        </div>
        <div className="hints">
          <button type="button" className="hint-button" onClick={() => current && setDetailsOpen(true)} disabled={!current}>
            <span className="btn-cross">✕</span> Details
          </button>
          <button
            type="button"
            className="hint-button"
            onClick={() => current && doExport(current, 'psu')}
            disabled={!current || !canExport(current, 'psu')}
            title="Download the selected save as a .psu file"
          >
            <span className="btn-triangle">△</span> Export
          </button>
          <button type="button" className="hint-button" onClick={() => setDetailsOpen(false)} disabled={!detailsOpen}>
            <span className="btn-circle">○</span> Back
          </button>
        </div>
      </footer>

      {detailsOpen && current && (
        <SaveDetails
          key={current.name}
          card={card}
          save={current}
          onClose={() => setDetailsOpen(false)}
          onExport={(format) => doExport(current, format)}
          onDelete={session.readOnly ? undefined : () => void doDelete(current)}
          deleteBlocked={canDelete(current) ? undefined : 'Protected against deleting'}
          onPreview={(kind) => {
            // Close the panel so the icon is in view, then play its animation.
            setDetailsOpen(false);
            void grid.current?.playAction(current.name, kind);
          }}
        />
      )}
      {dialog}
      {busy && (
        <div className="busy" role="status">
          {busy}
        </div>
      )}

      {notice && (
        <div className={notice.error ? 'toast' : 'toast toast-info'} role={notice.error ? 'alert' : 'status'}>
          <span>{notice.text}</span>
          <button type="button" className="icon-button" onClick={() => setNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </main>
  );
}
