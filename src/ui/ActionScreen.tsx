import { useCallback, useEffect, useState, type ReactNode } from 'react';

export interface ScreenOption {
  label: string;
  value: string;
  /** Why the option can't be picked; shown dimmed with this as its tooltip. */
  disabled?: string | undefined;
}

/**
 * The PS2's save menu: the save's icon sits large on the left (drawn by the
 * grid), its details and a short list of choices on the right.
 */
export interface ScreenSpec {
  /** Where the save is: "Memory Card (PS2)", or the file being imported. */
  source: string;
  title: string[];
  date?: string | undefined;
  size?: string | undefined;
  /** Yellow heading above the question, e.g. "Delete". */
  heading?: string | undefined;
  prompt?: string | undefined;
  notes?: ReactNode;
  options: ScreenOption[];
  /** Yes/No sit side by side; menus are a column. */
  row?: boolean | undefined;
  initial?: string | undefined;
}

interface Shown extends ScreenSpec {
  /** Each question gets a fresh screen, starting from its default choice. */
  id: number;
  resolve?: ((value: string | null) => void) | undefined;
  /** Shown instead of the options while something happens ("Deleting…"). */
  working?: string | undefined;
}

/**
 * `show` puts up a screen and resolves with the chosen option's value, or
 * null for Back (Escape). The screen stays up until the next `show`,
 * `working` or `close`, so a sequence of screens doesn't flicker.
 */
export function useActionScreen() {
  const [shown, setShown] = useState<Shown | null>(null);
  const show = useCallback(
    (spec: ScreenSpec) =>
      new Promise<string | null>((resolve) => {
        setShown((s) => ({
          ...spec,
          id: (s?.id ?? 0) + 1,
          resolve: (value) => {
            setShown((s) => s && { ...s, resolve: undefined });
            resolve(value);
          },
        }));
      }),
    [],
  );
  const working = useCallback((text: string) => setShown((s) => s && { ...s, resolve: undefined, working: text }), []);
  const close = useCallback(() => setShown(null), []);
  return {
    screen: shown ? <ActionScreen key={shown.id} spec={shown} /> : null,
    show,
    working,
    close,
    isOpen: shown !== null,
  };
}

function ActionScreen({ spec }: { spec: Shown }) {
  const enabled = spec.options.filter((o) => !o.disabled);
  const first = enabled.find((o) => o.value === spec.initial) ?? enabled[0];
  const [current, setCurrent] = useState(first?.value);
  const { resolve, options, row } = spec;

  useEffect(() => {
    if (!resolve) return;
    const onKey = (e: KeyboardEvent) => {
      // Dialogs on top (e.g. about unreadable saves) take the keys.
      if (document.querySelector('.dialog-backdrop')) return;
      if ((e.target as HTMLElement).closest?.('input, select, textarea')) return;
      const choices = options.filter((o) => !o.disabled);
      const at = choices.findIndex((o) => o.value === current);
      const back = row ? 'ArrowLeft' : 'ArrowUp';
      const forward = row ? 'ArrowRight' : 'ArrowDown';
      if (e.key === back || e.key === forward) {
        const next = choices[(at + (e.key === forward ? 1 : choices.length - 1)) % choices.length];
        if (next) setCurrent(next.value);
      } else if (e.key === 'Enter' || e.key === ' ') {
        if (current !== undefined) resolve(current);
      } else if (e.key === 'Escape' || e.key === 'Backspace') {
        resolve(null);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [resolve, options, row, current]);

  return (
    <div className="action-screen" role="dialog" aria-modal="true" aria-label={spec.heading ?? spec.title.join(' ')}>
      <div className="action-info">
        <div className="action-source">{spec.source}</div>
        <div className="action-title">
          {spec.title.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
        {spec.date && <div className="action-meta">{spec.date}</div>}
        {spec.size && <div className="action-meta">{spec.size}</div>}
        {spec.notes && <div className="action-notes">{spec.notes}</div>}
        {spec.heading && <div className="action-heading">{spec.heading}</div>}
        {spec.prompt && <div className="action-prompt">{spec.prompt}</div>}
        {spec.working ? (
          <div className="action-working" role="status">
            {spec.working}
          </div>
        ) : (
          <div className={row ? 'action-options action-row' : 'action-options'} role="menu">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="menuitem"
                className={o.value === current ? 'action-option current' : 'action-option'}
                disabled={!!o.disabled || !resolve}
                title={o.disabled}
                onMouseEnter={() => !o.disabled && setCurrent(o.value)}
                onClick={() => resolve?.(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="action-hints">
        <button type="button" className="hint-button" disabled={!resolve} onClick={() => current !== undefined && resolve?.(current)}>
          <span className="btn-cross">✕</span> Enter
        </button>
        <button type="button" className="hint-button" disabled={!resolve} onClick={() => resolve?.(null)}>
          <span className="btn-circle">○</span> Back
        </button>
      </div>
    </div>
  );
}
