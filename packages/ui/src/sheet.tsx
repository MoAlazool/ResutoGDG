'use client';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useUiLocale } from './locale';
import type { UiLocale } from './overlays';

const L = { en: { close: 'Close' }, ar: { close: 'إغلاق' } };

/**
 * Keeps a native <dialog> open while `open` is true: showModal() gives the focus trap, Escape, the inert page and the
 * top layer; focus returns to the element that opened it.
 */
export function useModalDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<Element | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnFocus.current = document.activeElement;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
    if (!open && returnFocus.current) {
      (returnFocus.current as HTMLElement).focus?.();
      returnFocus.current = null;
    }
  }, [open]);
  return ref;
}

export type SheetSide = 'end' | 'start' | 'bottom';
export type SheetSize = 'sm' | 'md' | 'lg' | 'xl';

/**
 * Sheet: a modal panel that slides in from the reading end (`side="end"`: right in English, left in Arabic), the
 * reading start, or the bottom (phones, quick actions). Native <dialog> (focus trap, Escape, inert background).
 * Use it instead of Modal for long forms and inspectors. The body scrolls; the header and footer stay put.
 */
export function Sheet({ open, onClose, title, description, children, footer, side = 'end', size = 'md', labels, locale, closeOnBackdrop = true, className }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode;
  side?: SheetSide; size?: SheetSize; labels?: Partial<typeof L.en>; locale?: UiLocale; closeOnBackdrop?: boolean; className?: string;
}) {
  const ref = useModalDialog(open);
  const id = useId();
  const ctx = useUiLocale();
  const t = { ...L[locale ?? ctx], ...labels };
  return (
    <dialog ref={ref} className={['rui-sheet', className].filter(Boolean).join(' ')} data-side={side} data-size={size}
      aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-desc` : undefined}
      onClose={() => { if (open) onClose(); }}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) onClose(); }}>
      <div className="rui-sheet-panel">
        <header className="rui-sheet-head">
          <div className="rui-sheet-titles">
            <h2 id={`${id}-title`}>{title}</h2>
            {description && <p id={`${id}-desc`}>{description}</p>}
          </div>
          <button type="button" className="btn btn-ghost btn-sm rui-sheet-close" onClick={onClose} aria-label={t.close}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </header>
        <div className="rui-sheet-body">{open ? children : null}</div>
        {footer && <footer className="rui-sheet-foot">{footer}</footer>}
      </div>
    </dialog>
  );
}
