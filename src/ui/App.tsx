import { useCallback, useEffect, useRef, useState } from 'react';
import { CARD_MAGIC, CARD_SIZES, CardError, formatCard, openCard, todFromDate, type CardSizeMb, type MemoryCard } from '../core';
import { Browser, type ImportRequest } from './Browser';
import { download } from './download';

// The largest PCSX2 card (64 MB with ECC) is 69,206,016 bytes.
const MAX_FILE_SIZE = 80 * 1024 * 1024;

/** A card being viewed, and the changes made to it in this session. */
export interface Session {
  card: MemoryCard;
  fileName: string;
  /** What was changed since the card was opened (or last downloaded), newest last. */
  changes: string[];
  /** The opened card, to go back to. */
  original: MemoryCard;
  /** Set when the user chose not to write a card without its unreadable saves. */
  readOnly: boolean;
  /** Bumped on every change, so the browser can tell cards apart. */
  version: number;
  /** Changes when a different card is opened (not when this one is edited). */
  id: number;
}

const isCard = (bytes: Uint8Array) =>
  bytes.length >= CARD_MAGIC.length && String.fromCharCode(...bytes.subarray(0, CARD_MAGIC.length)) === CARD_MAGIC;

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [importRequest, setImportRequest] = useState<ImportRequest | null>(null);
  const [newSize, setNewSize] = useState<CardSizeMb>(8);
  const inputRef = useRef<HTMLInputElement>(null);
  const unsaved = (session?.changes.length ?? 0) > 0;

  // Warn before leaving with changes that haven't been downloaded.
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  const confirmDiscard = useCallback(
    () => !unsaved || window.confirm("The changes to this card haven't been downloaded. Discard them?"),
    [unsaved],
  );

  const openBytes = useCallback((bytes: Uint8Array, fileName: string, changes: string[] = []) => {
    const card = openCard(bytes);
    setSession({ card, original: card, fileName, changes, readOnly: false, version: 0, id: Date.now() });
    setImportRequest(null); // saves picked for the previous card don't carry over
  }, []);

  /** Open memory cards; send save files (.psu, .max) to the open card. */
  const handleFiles = useCallback(
    async (files: File[]) => {
      setError(null);
      const saves: { name: string; bytes: Uint8Array }[] = [];
      for (const file of files) {
        if (file.size > MAX_FILE_SIZE) {
          setError(`${file.name} is too large to be a PS2 memory card or save.`);
          return;
        }
        // Read locally; the file never leaves the browser.
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (isCard(bytes)) {
          if (!confirmDiscard()) return;
          try {
            openBytes(bytes, file.name);
          } catch (e) {
            const message = e instanceof CardError ? e.message : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
            setError(`Couldn't open ${file.name}. ${message}`);
          }
          return;
        }
        saves.push({ name: file.name, bytes });
      }
      if (saves.length === 0) return;
      if (!session) {
        setError(`${saves.map((s) => s.name).join(', ')} ${saves.length === 1 ? "isn't" : "aren't"} a PS2 memory card. To import a save, open or create a card first.`);
        return;
      }
      setImportRequest({ files: saves, id: Date.now() });
    },
    [session, confirmDiscard, openBytes],
  );

  // Drop cards or saves anywhere on the page, at any time.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void handleFiles(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [handleFiles]);

  const openPicker = () => inputRef.current?.click();

  const newCard = (size: CardSizeMb) => {
    if (!confirmDiscard()) return;
    const bytes = formatCard({ clusters: CARD_SIZES[size], now: todFromDate(new Date()) });
    openBytes(bytes, `Mcd-new-${size}MB.ps2`, [`Created a blank ${size} MB card`]);
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".ps2,.mcd,.bin,.psu,.max"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) void handleFiles(files);
        }}
      />

      {session ? (
        <Browser
          key={session.id}
          session={session}
          importRequest={importRequest}
          onImportHandled={() => setImportRequest(null)}
          onOpenFile={openPicker}
          onNewCard={newCard}
          onChange={(card, change) =>
            setSession((s) => s && { ...s, card, changes: [...s.changes, change], version: s.version + 1 })
          }
          onReadOnly={() => setSession((s) => s && { ...s, readOnly: true })}
          onDownload={() => {
            download({ fileName: session.fileName, bytes: session.card.bytes, skipped: [] });
            setSession((s) => s && { ...s, changes: [], original: s.card });
          }}
          onDiscard={() => {
            if (!window.confirm('Undo all changes and go back to the card as it was opened?')) return;
            setSession((s) => s && { ...s, card: s.original, changes: [], version: s.version + 1 });
          }}
        />
      ) : (
        <main className="screen landing">
          <div className="landing-box">
            <h1>
              Memory Card <span className="small">(PS2)</span>
            </h1>
            <p>Drop a PCSX2 memory card file (.ps2) here, or choose one.</p>
            <button type="button" className="primary" onClick={openPicker}>
              Choose a memory card…
            </button>
            <div className="new-card">
              or{' '}
              <button type="button" className="link-button" onClick={() => newCard(newSize)}>
                create a blank card
              </button>{' '}
              of{' '}
              <select value={newSize} onChange={(e) => setNewSize(Number(e.target.value) as CardSizeMb)} aria-label="New card size">
                {Object.keys(CARD_SIZES).map((mb) => (
                  <option key={mb} value={mb}>
                    {mb} MB
                  </option>
                ))}
              </select>
            </div>
            <p className="fine-print">
              Everything happens in your browser. Files are never uploaded, and the card you open is never changed: edits
              make a new card for you to download.
            </p>
          </div>
        </main>
      )}

      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button type="button" className="icon-button" onClick={() => setError(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {dragging && <div className="drop-overlay">{session ? 'Drop a card to open it, or saves (.psu, .max) to import them' : 'Drop the memory card to open it'}</div>}
    </>
  );
}
