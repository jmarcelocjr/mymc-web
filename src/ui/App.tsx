import { useCallback, useEffect, useRef, useState } from 'react';
import { CardError, openCard, type MemoryCard } from '../core';
import { Browser } from './Browser';

// The largest PCSX2 card (64 MB with ECC) is 69,206,016 bytes.
const MAX_FILE_SIZE = 80 * 1024 * 1024;

interface Loaded {
  card: MemoryCard;
  fileName: string;
}

export function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (file: File) => {
    setError(null);
    if (file.size > MAX_FILE_SIZE) {
      setError(`${file.name} is too large to be a PS2 memory card.`);
      return;
    }
    try {
      // Read locally; the file never leaves the browser.
      const bytes = new Uint8Array(await file.arrayBuffer());
      setLoaded({ card: openCard(bytes), fileName: file.name });
    } catch (e) {
      const message = e instanceof CardError ? e.message : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
      setError(`Couldn't open ${file.name}. ${message}`);
    }
  }, []);

  // Drop a card anywhere on the page, at any time.
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
      const file = e.dataTransfer?.files[0];
      if (file) void load(file);
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
  }, [load]);

  const openPicker = () => inputRef.current?.click();

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".ps2,.mcd,.bin"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void load(file);
        }}
      />

      {loaded ? (
        <Browser key={loaded.fileName + loaded.card.bytes.length} card={loaded.card} fileName={loaded.fileName} onOpenFile={openPicker} />
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
            <p className="fine-print">Everything happens in your browser. The file is never uploaded, and it's never changed.</p>
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

      {dragging && <div className="drop-overlay">Drop the memory card to open it</div>}
    </>
  );
}
