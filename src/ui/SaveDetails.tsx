import { useMemo, useState } from 'react';
import { CardError, isDir, type MemoryCard, type SaveSummary } from '../core';
import { HexDump } from './HexDump';
import { KIND_LABEL, PROTECTION_LABEL, displayTitle, formatBytes, formatKb, formatTod } from './format';

interface Props {
  card: MemoryCard;
  save: SaveSummary;
  onClose: () => void;
  /** Show the save's copy or delete animation on the grid. */
  onPreview?: (kind: 'copy' | 'delete') => void;
}

export function SaveDetails({ card, save, onClose, onPreview }: Props) {
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [line1, line2] = displayTitle(save);
  const isDirectory = isDir(save.entry);

  const files = useMemo(() => {
    if (!isDirectory || !save.readable) return [];
    try {
      return card.readDir(`/${save.name}`);
    } catch {
      return [];
    }
  }, [card, save, isDirectory]);

  const fileBytes = useMemo(() => {
    const path = isDirectory ? (openFile ? `/${save.name}/${openFile}` : null) : `/${save.name}`;
    if (!path) return null;
    try {
      return card.readFile(path);
    } catch (e) {
      return e instanceof CardError ? e : null;
    }
  }, [card, save, openFile, isDirectory]);

  return (
    <aside className="details" aria-label="Save details">
      <header className="details-header">
        <div>
          <div className="details-title">{line1}</div>
          {line2 && <div className="details-title">{line2}</div>}
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </header>

      {!save.readable && save.problem && (
        <p className="warning">
          This save can't be read: {save.problem.message} ({save.problem.path})
        </p>
      )}

      <dl className="facts">
        <dt>Folder</dt>
        <dd className="mono">{save.name}</dd>
        <dt>Type</dt>
        <dd>{KIND_LABEL[save.kind]}</dd>
        <dt>Size</dt>
        <dd>{formatKb(save.sizeOnCard)}</dd>
        <dt>Protection</dt>
        <dd>{PROTECTION_LABEL[save.protection]}</dd>
        <dt>Modified</dt>
        <dd>{formatTod(save.entry.modified)}</dd>
        <dt>Created</dt>
        <dd>{formatTod(save.entry.created)}</dd>
        {save.hidden && (
          <>
            <dt>Hidden</dt>
            <dd>Yes</dd>
          </>
        )}
        {save.iconSys && (
          <>
            <dt>Icons</dt>
            <dd className="icon-states">
              {(['normal', 'copy', 'delete'] as const).map((kind) => (
                <div key={kind}>
                  <span className="state">{kind}</span> <span className="mono">{save.iconSys!.icons[kind]}</span>
                  {kind !== 'normal' && onPreview && (
                    <button type="button" className="link-button" onClick={() => onPreview(kind)}>
                      ▶ Preview
                    </button>
                  )}
                </div>
              ))}
            </dd>
          </>
        )}
        {save.iconSysError && (
          <>
            <dt>icon.sys</dt>
            <dd>{save.iconSysError}</dd>
          </>
        )}
      </dl>

      {isDirectory && files.length > 0 && (
        <table className="files">
          <thead>
            <tr>
              <th>File</th>
              <th className="num">Size</th>
              <th>Modified</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr
                key={f.name}
                className={openFile === f.name ? 'active' : undefined}
                onClick={() => setOpenFile(openFile === f.name ? null : f.name)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    setOpenFile(openFile === f.name ? null : f.name);
                  }
                }}
              >
                <td className="mono">{f.name}</td>
                <td className="num">{formatBytes(f.length)}</td>
                <td>{formatTod(f.modified)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {fileBytes instanceof CardError && <p className="warning">Can't read this file: {fileBytes.message}</p>}
      {fileBytes instanceof Uint8Array && (
        <section>
          <h3 className="hex-title">{openFile ?? save.name}</h3>
          <HexDump key={openFile ?? save.name} bytes={fileBytes} />
        </section>
      )}
      {isDirectory && !openFile && files.length > 0 && <p className="hint">Select a file to see its contents.</p>}
    </aside>
  );
}
