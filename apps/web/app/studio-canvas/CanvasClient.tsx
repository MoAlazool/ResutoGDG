'use client';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { PublicSite } from '@resuto/contracts';
import { formatMessage } from '@/lib/i18n/format-message';
import { fromCanvas, readToCanvas, type CanvasTarget } from '@/lib/studio-canvas';
import { SiteView } from '../r/[slug]/_components/SiteView';
import './canvas.css';

type Messages = Record<string, string>;
interface View { site: PublicSite; locale: 'en' | 'ar'; selected: CanvasTarget | null; compare: 'before' | 'after' | null }

/** Posts to the editor (the parent window at the app's own origin); a canvas opened on its own talks to nobody. */
function post(msg: ReturnType<typeof fromCanvas.select> | ReturnType<typeof fromCanvas.ready>) {
  if (window.parent !== window) window.parent.postMessage(msg, window.location.origin);
}

export function CanvasClient({ messages }: { messages: { en: Messages; ar: Messages } }) {
  const [view, setView] = useState<View | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = readToCanvas(e, window.parent, window.location.origin);
      if (!m) return;
      if (m.type === 'render') setView({ site: m.site, locale: m.locale, selected: m.selected, compare: m.compare });
      else setView((v) => (v ? { ...v, selected: m.id } : v));
    };
    window.addEventListener('message', onMessage);
    post(fromCanvas.ready());
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Mark and reveal the selected section (no smooth scrolling: the canvas follows reduced motion by never animating).
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    el.querySelectorAll('[data-selected]').forEach((n) => n.removeAttribute('data-selected'));
    if (view?.selected && view.selected !== 'site') {
      const target = el.querySelector(`[data-sid="${CSS.escape(view.selected)}"]`);
      target?.setAttribute('data-selected', '');
      target?.scrollIntoView({ block: 'nearest' });
    }
    el.querySelectorAll<HTMLElement>('[data-sid]').forEach((n) => { n.tabIndex = 0; });
  }, [view]);

  const pick = useCallback((target: EventTarget | null) => {
    const node = target instanceof Element ? target : null;
    const block = node?.closest<HTMLElement>('[data-sid]');
    post(fromCanvas.select(block?.dataset.sid ?? (node?.closest('header, footer') ? 'site' : null)));
  }, []);

  // Nothing in the canvas navigates: links and forms are inert, a click selects what it landed on.
  const onClick = (e: MouseEvent) => { e.preventDefault(); pick(e.target); };
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && (e.target as Element).matches?.('[data-sid]')) { e.preventDefault(); pick(e.target); }
  };

  if (!view) return <div className="canvas-wait" aria-busy="true" />;
  const dict = messages[view.locale];
  const t = (key: string, vars?: Record<string, string | number>) => formatMessage(dict[key] ?? messages.en[key] ?? key, view.locale, vars);
  return (
    <div ref={root} className="canvas-root" lang={view.locale} dir={view.locale === 'ar' ? 'rtl' : 'ltr'} data-compare={view.compare ?? undefined}
      data-site-selected={view.selected === 'site' || undefined} onClickCapture={onClick} onSubmitCapture={(e) => e.preventDefault()} onKeyDown={onKeyDown}>
      <SiteView site={view.site} locale={view.locale} t={t} preview />
    </div>
  );
}
