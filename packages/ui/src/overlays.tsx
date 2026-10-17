'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { UiStyles } from './styles';

export type UiLocale = 'en' | 'ar';
const L = {
  en: { close: 'Close', cancel: 'Cancel', confirm: 'Confirm' },
  ar: { close: 'إغلاق', cancel: 'إلغاء', confirm: 'تأكيد' },
};

/** Opens/closes a native <dialog> in sync with `open` (focus trap + Escape come from the browser). */
function useDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<Element | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnFocus.current = document.activeElement;
      d.showModal();
    }
    if (!open && d.open) {
      d.close();
      (returnFocus.current as HTMLElement | null)?.focus?.();
    }
  }, [open]);
  return ref;
}

/** Side sheet for details and forms. `side="end"` is the right edge in LTR and the left edge in RTL. */
export function Drawer({ open, onClose, title, children, footer, side = 'end', locale = 'en', width }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; side?: 'start' | 'end'; locale?: UiLocale; width?: number;
}) {
  const ref = useDialog(open);
  return (
    <>
      <UiStyles />
      <dialog ref={ref} className="rui-drawer" data-side={side} onClose={onClose} aria-labelledby="rui-drawer-title"
        style={width ? { width: `min(${width}px, 100vw)` } : undefined}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="rui-drawer-head">
          <h2 id="rui-drawer-title">{title}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label={L[locale].close}>✕</button>
        </div>
        <div className="rui-drawer-body">{open ? children : null}</div>
        {footer && <div className="rui-drawer-foot">{footer}</div>}
      </dialog>
    </>
  );
}

export interface ConfirmOptions {
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  tone?: 'danger' | 'default';
}

/** Accessible confirmation dialog (replaces window.confirm). */
export function ConfirmDialog({ open, onConfirm, onCancel, pending, locale = 'en', ...o }: ConfirmOptions & {
  open: boolean; onConfirm: () => void; onCancel: () => void; pending?: boolean; locale?: UiLocale;
}) {
  const ref = useDialog(open);
  return (
    <>
      <UiStyles />
      <dialog ref={ref} className="rui-confirm" role="alertdialog" aria-labelledby="rui-confirm-title" aria-describedby="rui-confirm-body" onClose={onCancel}>
        <h2 id="rui-confirm-title">{o.title}</h2>
        {o.body && <p id="rui-confirm-body">{o.body}</p>}
        <div className="rui-actions">
          <button type="button" className="btn" onClick={onCancel} autoFocus>{o.cancelLabel ?? L[locale].cancel}</button>
          <button type="button" className={o.tone === 'danger' ? 'btn btn-ember' : 'btn btn-primary'} disabled={pending} onClick={onConfirm}>
            {o.confirmLabel ?? L[locale].confirm}
          </button>
        </div>
      </dialog>
    </>
  );
}

/**
 * Promise-based confirmation: `const [confirm, dialog] = useConfirm(locale)`;
 * render `{dialog}` once, then `if (await confirm({ title })) …`.
 */
export function useConfirm(locale: UiLocale = 'en'): [(o: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const done = (v: boolean) => { state?.resolve(v); setState(null); };
  const dialog = (
    <ConfirmDialog open={!!state} locale={locale} title={state?.title ?? ''} body={state?.body} confirmLabel={state?.confirmLabel}
      cancelLabel={state?.cancelLabel} tone={state?.tone} onConfirm={() => done(true)} onCancel={() => done(false)} />
  );
  return [confirm, dialog];
}
