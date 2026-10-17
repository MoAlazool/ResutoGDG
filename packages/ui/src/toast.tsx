'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { UiStyles } from './styles';

export type ToastTone = 'info' | 'ok' | 'warn' | 'danger';
export interface ToastInput { message: ReactNode; tone?: ToastTone; action?: { label: ReactNode; onClick: () => void }; durationMs?: number }
interface ToastItem extends ToastInput { id: number }
interface ToastApi { show(t: ToastInput): number; dismiss(id: number): void }

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Notifications region. Polite toasts for confirmations, assertive for errors.
 * Wrap a page (or the app) once; call `useToast().show({ message, tone })`.
 */
export function ToastProvider({ children, closeLabel = 'Dismiss' }: { children: ReactNode; closeLabel?: string }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback((t: ToastInput) => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
    return id;
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastContext.Provider value={api}>
      <UiStyles />
      {children}
      <div className="rui-toasts" role="region" aria-label="Notifications">
        <div aria-live="polite" aria-atomic="false" style={{ display: 'grid', gap: 10 }}>
          {items.filter((t) => t.tone !== 'danger').map((t) => <Toast key={t.id} item={t} onDismiss={dismiss} closeLabel={closeLabel} />)}
        </div>
        <div aria-live="assertive" style={{ display: 'grid', gap: 10 }}>
          {items.filter((t) => t.tone === 'danger').map((t) => <Toast key={t.id} item={t} onDismiss={dismiss} closeLabel={closeLabel} />)}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ item, onDismiss, closeLabel }: { item: ToastItem; onDismiss: (id: number) => void; closeLabel: string }) {
  useEffect(() => {
    const ms = item.durationMs ?? (item.tone === 'danger' ? 9000 : 5000);
    if (ms <= 0) return;
    const timer = setTimeout(() => onDismiss(item.id), ms);
    return () => clearTimeout(timer);
  }, [item, onDismiss]);
  return (
    <div className="rui-toast" data-tone={item.tone ?? 'info'} role={item.tone === 'danger' ? 'alert' : 'status'}>
      <p>{item.message}</p>
      {item.action && <button type="button" onClick={() => { item.action!.onClick(); onDismiss(item.id); }}>{item.action.label}</button>}
      <button type="button" onClick={() => onDismiss(item.id)} aria-label={closeLabel}>✕</button>
    </div>
  );
}

/** Falls back to a console-free no-op outside a provider so components stay usable in isolation. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? { show: () => 0, dismiss: () => undefined };
}
