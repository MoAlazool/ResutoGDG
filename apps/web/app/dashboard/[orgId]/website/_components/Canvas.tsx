'use client';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { PublicSite } from '@resuto/contracts';
import { Notice } from '@resuto/ui';
import { LocaleProvider, useT } from '@/lib/i18n/client';
import { formatMessage } from '@/lib/i18n/format-message';
import { CANVAS_SANDBOX, CANVAS_SRCDOC, CANVAS_WIDTHS, syncStyles, targetOf, type CanvasDevice, type CanvasTarget } from '@/lib/studio-canvas';
import { SiteView } from '@/app/r/[slug]/_components/SiteView';
import './canvas-frame.css';

type Messages = Record<string, string>;
let messagesOnce: Promise<{ en: Messages; ar: Messages }> | null = null;
/** Both languages of the site copy, fetched once per editor session (app/api/studio/site-messages). */
function loadMessages() {
  messagesOnce ??= fetch('/api/studio/site-messages', { credentials: 'same-origin' }).then((r) => {
    if (!r.ok) throw new Error(`site copy ${r.status}`);
    return r.json() as Promise<{ en: Messages; ar: Messages }>;
  }).catch((e) => { messagesOnce = null; throw e; });
  return messagesOnce;
}

/**
 * The canvas: the draft rendered by the site renderer inside a script-free, same-origin iframe (lib/studio-canvas.ts
 * explains why and how). The frame is laid out at the device's real width (desktop 1280, tablet 820, phone 390 px) and
 * scaled down to fit the pane, so the page reflows exactly as it will for guests (its media queries see that width).
 */
export function Canvas({ site, locale, device, selected, onSelect, compare, label, onDocument }: {
  site: PublicSite; locale: 'en' | 'ar'; device: CanvasDevice; selected: CanvasTarget | null; onSelect: (id: CanvasTarget | null) => void;
  compare: 'before' | 'after' | null; label: string;
  /** The rendered canvas document, for checks that read the real page (heading outline, image alt text). */
  onDocument?: (doc: Document | null) => void;
}) {
  const { t } = useT();
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [messages, setMessages] = useState<{ en: Messages; ar: Messages } | null>(null);
  const [copyError, setCopyError] = useState(false);

  const fetchCopy = useCallback(() => {
    setCopyError(false);
    loadMessages().then(setMessages, () => setCopyError(true));
  }, []);
  useEffect(fetchCopy, [fetchCopy]);

  // The frame document exists once srcdoc has loaded; from then on the editor owns it.
  const attach = useCallback(() => {
    const d = frame.current?.contentDocument;
    if (!d?.body) return;
    d.body.className = 'canvas-body';
    syncStyles(document, d);
    setDoc(d);
  }, []);
  useEffect(() => {
    // Already loaded before React attached onLoad (fast srcdoc): attach now.
    if (frame.current?.contentDocument?.readyState === 'complete' && frame.current.contentDocument.body) attach();
  }, [attach]);

  // Route CSS arrives as <link> elements while chunks load: keep the canvas's copy in step with the editor's head.
  useEffect(() => {
    if (!doc) return;
    const mo = new MutationObserver(() => syncStyles(document, doc));
    mo.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [doc]);

  useEffect(() => {
    if (!doc) return;
    doc.documentElement.lang = locale;
    doc.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [doc, locale]);

  useEffect(() => { onDocument?.(doc && messages ? doc : null); }, [doc, messages, onDocument]);

  // Mark and reveal the selected section (no smooth scrolling: the canvas never animates).
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    el.querySelectorAll('[data-selected]').forEach((n) => n.removeAttribute('data-selected'));
    el.querySelectorAll<HTMLElement>('[data-sid]').forEach((n) => { n.tabIndex = 0; });
    if (selected && selected !== 'site') {
      const target = el.querySelector(`[data-sid="${CSS.escape(selected)}"]`);
      target?.setAttribute('data-selected', '');
      target?.scrollIntoView({ block: 'nearest' });
    }
  });

  // Run-time geometry: the device width scaled to the pane (CSS custom properties set here, read by website.css).
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => {
      const width = CANVAS_WIDTHS[device];
      const scale = Math.min(1, el.clientWidth / width);
      el.style.setProperty('--ws-frame-width', `${width}px`);
      el.style.setProperty('--ws-frame-scale', String(scale));
      el.style.setProperty('--ws-frame-height', `${Math.max(1, Math.round(el.clientHeight / scale))}px`);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [device]);

  // Nothing in the canvas navigates or runs the page's own controls (language switch, forms): a click selects what it
  // landed on. Stopping the event in the capture phase keeps it from reaching the renderer's handlers.
  const onClick = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); onSelect(targetOf(e.target)); };
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && (e.target as Element).matches?.('[data-sid]')) { e.preventDefault(); onSelect(targetOf(e.target)); }
  };

  const dict = messages?.[locale];
  const tr = useCallback((key: string, vars?: Record<string, string | number>) =>
    formatMessage(dict?.[key] ?? messages?.en[key] ?? key, locale, vars), [dict, messages, locale]);

  return (
    <div ref={stage} className="ws-stage" data-device={device} data-ready={doc && messages ? '' : undefined}>
      {copyError && <div className="ws-stage-note"><Notice tone="danger">{t('studio.ws.canvasCopyError')}</Notice>
        <button type="button" className="btn btn-sm mbs-12" onClick={fetchCopy}>{t('action.retry')}</button></div>}
      <iframe ref={frame} className="ws-frame" srcDoc={CANVAS_SRCDOC} sandbox={CANVAS_SANDBOX} title={label} onLoad={attach} />
      {doc && messages && createPortal(
        <LocaleProvider locale={locale} messages={dict}>
          <div ref={root} className="canvas-root" lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'} data-compare={compare ?? undefined}
            data-site-selected={selected === 'site' || undefined} onClickCapture={onClick} onSubmitCapture={(e) => e.preventDefault()} onKeyDown={onKeyDown}>
            <SiteView site={site} locale={locale} t={tr} preview />
          </div>
        </LocaleProvider>,
        doc.body,
      )}
    </div>
  );
}
