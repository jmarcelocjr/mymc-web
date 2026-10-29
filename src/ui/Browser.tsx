import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CardError, type MemoryCard, type SaveSummary } from '../core';
import { IconGrid, type GridApi } from './IconGrid';
import { SaveDetails } from './SaveDetails';
import { download } from './download';
import { canExport, exportSave, type ExportFormat } from './exportSave';
import { displayTitle, formatKb, todToDate } from './format';

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
  card: MemoryCard;
  fileName: string;
  onOpenFile: () => void;
}

export function Browser({ card, fileName, onOpenFile }: Props) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('card');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [columns, setColumns] = useState(5);
  const grid = useRef<GridApi | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

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

  // Keyboard: arrows move, Enter opens details, Escape goes back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, saves.length, columns, detailsOpen, select]);

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
          <button type="button" onClick={onOpenFile}>
            Open card…
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
          onPreview={(kind) => {
            // Close the panel so the icon is in view, then play its animation.
            setDetailsOpen(false);
            void grid.current?.playAction(current.name, kind);
          }}
        />
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
