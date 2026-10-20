'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { UiStyles } from './styles';

export type UiLocale = 'en' | 'ar';
const L = {
  en: { close: 'Close', cancel: 'Cancel', confirm: 'Confirm', tooShort: 'Enter at least {n} characters.' },
  ar: { close: 'إغلاق', cancel: 'إلغاء', confirm: 'تأكيد', tooShort: 'أدخل {n} أحرف على الأقل.' },
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

export interface PromptOptions {
  title: ReactNode;
  body?: ReactNode;
  label: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  /** Minimum length after trimming (the confirm button stays disabled until it is met). */
  minLength?: number;
  maxLength?: number;
  multiline?: boolean;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  tone?: 'danger' | 'default';
}

/** Accessible text prompt in a styled dialog (replaces window.prompt): labelled field, length check, Enter submits. */
export function PromptDialog({ open, onSubmit, onCancel, locale = 'en', ...o }: PromptOptions & {
  open: boolean; onSubmit: (value: string) => void; onCancel: () => void; locale?: UiLocale;
}) {
  const ref = useDialog(open);
  const [value, setValue] = useState(o.defaultValue ?? '');
  useEffect(() => { if (open) setValue(o.defaultValue ?? ''); }, [open, o.defaultValue]);
  const min = o.minLength ?? 1;
  const ok = value.trim().length >= min;
  const fieldProps = {
    className: o.multiline ? 'textarea' : 'input', value, placeholder: o.placeholder, maxLength: o.maxLength, autoFocus: true,
    'aria-describedby': o.body ? 'rui-prompt-body' : undefined,
  };
  return (
    <>
      <UiStyles />
      <dialog ref={ref} className="rui-confirm" aria-labelledby="rui-prompt-title" onClose={onCancel}>
        <form method="dialog" onSubmit={(e) => { e.preventDefault(); if (ok) onSubmit(value.trim()); }}>
          <h2 id="rui-prompt-title">{o.title}</h2>
          {o.body && <p id="rui-prompt-body">{o.body}</p>}
          <label className="field" style={{ marginBlockStart: 14 }}>
            <span>{o.label}</span>
            {o.multiline
              ? <textarea {...fieldProps} rows={3} onChange={(e) => setValue(e.target.value)} />
              : <input {...fieldProps} onChange={(e) => setValue(e.target.value)} />}
            {!ok && value.length > 0 && min > 1 && <small>{L[locale].tooShort.replace('{n}', String(min))}</small>}
          </label>
          <div className="rui-actions">
            <button type="button" className="btn" onClick={onCancel}>{o.cancelLabel ?? L[locale].cancel}</button>
            <button type="submit" className={o.tone === 'danger' ? 'btn btn-ember' : 'btn btn-primary'} disabled={!ok}>{o.confirmLabel ?? L[locale].confirm}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}

/**
 * Promise-based text prompt: `const [prompt, dialog] = usePrompt(locale)`; render `{dialog}` once, then
 * `const reason = await prompt({ title, label, minLength: 2 })` (null when cancelled).
 */
export function usePrompt(locale: UiLocale = 'en'): [(o: PromptOptions) => Promise<string | null>, ReactNode] {
  const [state, setState] = useState<(PromptOptions & { resolve: (v: string | null) => void }) | null>(null);
  const prompt = useCallback((o: PromptOptions) => new Promise<string | null>((resolve) => setState({ ...o, resolve })), []);
  const done = (v: string | null) => { state?.resolve(v); setState(null); };
  const dialog = (
    <PromptDialog open={!!state} locale={locale} title={state?.title ?? ''} body={state?.body} label={state?.label ?? ''}
      defaultValue={state?.defaultValue} placeholder={state?.placeholder} minLength={state?.minLength} maxLength={state?.maxLength}
      multiline={state?.multiline} confirmLabel={state?.confirmLabel} cancelLabel={state?.cancelLabel} tone={state?.tone}
      onSubmit={(v) => done(v)} onCancel={() => done(null)} />
  );
  return [prompt, dialog];
}
