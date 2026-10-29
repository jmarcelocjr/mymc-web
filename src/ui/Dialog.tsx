import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface DialogAction {
  label: string;
  value: string;
  kind?: 'primary' | 'danger' | undefined;
}

export interface DialogSpec {
  title: string;
  body: ReactNode;
  actions: DialogAction[];
}

interface Open extends DialogSpec {
  resolve: (value: string | null) => void;
}

/**
 * A modal question. `ask` resolves with the chosen action's value, or null
 * when the dialog is dismissed (Escape or the backdrop).
 */
export function useDialog(): { dialog: ReactNode; ask: (spec: DialogSpec) => Promise<string | null>; isOpen: boolean } {
  const [open, setOpen] = useState<Open | null>(null);
  const ask = useCallback(
    (spec: DialogSpec) =>
      new Promise<string | null>((resolve) => {
        setOpen({
          ...spec,
          resolve: (value) => {
            setOpen(null);
            resolve(value);
          },
        });
      }),
    [],
  );
  return { dialog: open ? <Dialog spec={open} onClose={open.resolve} /> : null, ask, isOpen: open !== null };
}

function Dialog({ spec, onClose }: { spec: DialogSpec; onClose: (value: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    (root?.querySelector<HTMLButtonElement>('button.primary-action') ?? root?.querySelector('button'))?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose(null)}>
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">{spec.title}</h2>
        <div className="dialog-body">{spec.body}</div>
        <div className="dialog-actions">
          {spec.actions.map((a) => (
            <button
              key={a.value}
              type="button"
              className={a.kind === 'primary' ? 'primary-action' : a.kind === 'danger' ? 'danger-action' : undefined}
              onClick={() => onClose(a.value)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
