'use client';
import { useEffect, useRef, useState } from 'react';
import type { PublicSite } from '@resuto/contracts';
import { Notice } from '@resuto/ui';
import { documentAllowsStudioCanvas } from '@/lib/csp';
import { useT } from '@/lib/i18n/client';
import { CANVAS_PATH, CANVAS_SANDBOX, CANVAS_WIDTHS, readFromCanvas, toCanvas, type CanvasDevice, type CanvasTarget } from '@/lib/studio-canvas';

/**
 * The canvas: the draft rendered by the site renderer in a sandboxed iframe (lib/studio-canvas.ts explains the
 * isolation). The frame is laid out at the device's real width (desktop 1280, tablet 820, phone 390 px) and scaled
 * down to fit the pane, so the page reflows exactly as it will for guests.
 */
export function Canvas({ site, locale, device, selected, onSelect, compare, label }: {
  site: PublicSite; locale: 'en' | 'ar'; device: CanvasDevice; selected: CanvasTarget | null; onSelect: (id: CanvasTarget | null) => void;
  compare: 'before' | 'after' | null; label: string;
}) {
  const { t } = useT();
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const latest = useRef({ site, locale, selected, compare });
  latest.current = { site, locale, selected, compare };

  // A document keeps the CSP it was loaded with: one opened on a guest page and navigated here client-side has
  // frame-src 'none', so it reloads once to get the staff policy (frame-src 'self').
  useEffect(() => {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (documentAllowsStudioCanvas(entry?.name ?? window.location.href)) return;
    setBlocked(true);
    try {
      if (!sessionStorage.getItem('studio-canvas-reload')) { sessionStorage.setItem('studio-canvas-reload', '1'); window.location.reload(); }
    } catch { /* storage unavailable: the notice below offers the reload */ }
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = readFromCanvas(e, frame.current?.contentWindow ?? null);
      if (!m) return;
      if (m.type === 'ready') {
        setReady(true);
        const v = latest.current;
        frame.current?.contentWindow?.postMessage(toCanvas.render(v.site, v.locale, v.selected, v.compare), '*');
      } else onSelect(m.id);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onSelect]);

  // The frame's origin is opaque, so it cannot be named as the target: "*" (the frame's address is fixed; see the protocol).
  useEffect(() => {
    if (ready) frame.current?.contentWindow?.postMessage(toCanvas.render(site, locale, selected, compare), '*');
  }, [ready, site, locale, selected, compare]);

  // Run-time geometry: the device width scaled to the pane (CSS custom properties set here, read by website.css).
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => {
      const width = CANVAS_WIDTHS[device];
      const scale = Math.min(1, el.clientWidth / width);
      el.style.setProperty('--ws-frame-width', `${width}px`);
      el.style.setProperty('--ws-frame-scale', String(scale));
      el.style.setProperty('--ws-frame-height', `${Math.round(el.clientHeight / scale)}px`);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [device]);

  if (blocked) {
    return <div className="ws-pane-pad"><Notice tone="warn">{t('studio.ws.canvasReload')}</Notice><button type="button" className="btn mbs-12" onClick={() => window.location.reload()}>{t('action.retry')}</button></div>;
  }
  return (
    <div ref={stage} className="ws-stage" data-device={device}>
      <iframe ref={frame} className="ws-frame" src={CANVAS_PATH} sandbox={CANVAS_SANDBOX} title={label} referrerPolicy="no-referrer" />
    </div>
  );
}
