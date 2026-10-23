'use client';
import { useCallback, useEffect, useState } from 'react';

/** Legacy #toast: one short message at a time, gone after five seconds. */
export function useToast() {
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);
  const show = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const node = toast ? <div role="status" className={`gx-toast${toast.error ? ' is-error' : ''}`}>{toast.text}</div> : null;
  return { show, node };
}
