'use client';
// Guest-site Meta Pixel (INT-20). Pages mount it with one line; everything else (config, consent prompt, Pixel, browser
// ids, the consented order context and the deduplicated Purchase) lives here. Renders nothing when the restaurant does
// not measure with Meta, which is the case for every demo restaurant.
import { useEffect, useRef, useState } from 'react';
import { api, API_URL } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { ensureBrowserIds, installPixel, pixelTrack, purchaseEventId, readConsent, writeConsent, type Consent } from './meta';

interface TrackingConfig { meta: { pixelId: string; testMode: boolean } | null; consentVersion: string }

/** The restaurant's Pixel once the guest agreed on this device; null otherwise. Module state, shared by the helpers below. */
let active: { slug: string; pixelId: string; consentVersion: string } | null = null;
const configs = new Map<string, Promise<TrackingConfig | null>>();

function loadConfig(slug: string) {
  if (!configs.has(slug)) configs.set(slug, api<TrackingConfig>(`/public/tracking/${encodeURIComponent(slug)}`).catch(() => null));
  return configs.get(slug)!;
}

function activate(slug: string, cfg: TrackingConfig) {
  if (!cfg.meta) return;
  ensureBrowserIds();
  installPixel(cfg.meta.pixelId);
  const first = active?.slug !== slug;
  active = { slug, pixelId: cfg.meta.pixelId, consentVersion: cfg.consentVersion };
  if (first) pixelTrack('PageView');
}

/** A standard event from the site (AddToCart, InitiateCheckout, …). No-op without consent. */
export function metaTrack(slug: string, event: string, data: Record<string, unknown> = {}) {
  if (active?.slug !== slug) return;
  pixelTrack(event, data, `${event}.${crypto.randomUUID?.() ?? Date.now()}`);
}

/**
 * A web order was placed: hand the API what the guest agreed to share for it (browser ids and this page's URL; the API
 * adds the IP address and user agent it sees). `keepalive` lets it finish while the page moves on to payment.
 */
export function metaOrderPlaced(slug: string, publicRef: string) {
  if (active?.slug !== slug) return;
  const { fbp, fbc } = ensureBrowserIds();
  void fetch(`${API_URL}/v1/public/tracking/${encodeURIComponent(slug)}/orders/${encodeURIComponent(publicRef)}/context`, {
    method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ consentVersion: active.consentVersion, fbp, fbc, pageUrl: location.href.split('#')[0]!.slice(0, 1000) }),
  }).catch(() => undefined);
}

/** Loads the restaurant's tracking config, asks for consent once per prompt version, then runs the Pixel. */
export function MetaPixel({ slug, view }: { slug: string; view?: 'ViewContent' }) {
  const { t } = useT();
  const [ask, setAsk] = useState<TrackingConfig | null>(null);
  useEffect(() => {
    let live = true;
    void loadConfig(slug).then((cfg) => {
      if (!live || !cfg?.meta) return;
      const c = readConsent(slug, cfg.consentVersion);
      if (c === 'granted') { activate(slug, cfg); if (view) metaTrack(slug, view); }
      else if (c === null) setAsk(cfg);
    });
    return () => { live = false; };
  }, [slug, view]);
  if (!ask) return null;
  const answer = (c: Consent) => {
    writeConsent(slug, ask.consentVersion, c);
    if (c === 'granted') { activate(slug, ask); if (view) metaTrack(slug, view); }
    setAsk(null);
  };
  return (
    <div role="dialog" aria-modal="false" aria-labelledby="ad-consent-title" className="g-card" data-testid="ad-consent"
      style={{ position: 'fixed', insetInline: 12, bottom: 88, zIndex: 60, maxWidth: 520, marginInline: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,.18)' }}>
      <strong id="ad-consent-title">{t('marketing.consent.title')}</strong>
      <p className="fine" style={{ margin: '6px 0 10px' }}>{t('marketing.consent.body')}</p>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => answer('granted')}>{t('marketing.consent.allow')}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => answer('denied')}>{t('marketing.consent.deny')}</button>
      </div>
    </div>
  );
}

/**
 * Order tracking page: once the order counts as a Purchase (the API decides, with the same policy and event id as the
 * server event), fire it from the browser too; Meta keeps one of the two. Fired at most once per order per device.
 */
export function MetaPurchase({ slug, orderRef, ready }: { slug: string; orderRef: string; ready: boolean }) {
  const asked = useRef(false);
  useEffect(() => {
    if (!ready || asked.current) return;
    asked.current = true;
    void (async () => {
      const cfg = await loadConfig(slug);
      if (!cfg?.meta || readConsent(slug, cfg.consentVersion) !== 'granted') return;
      activate(slug, cfg);
      const key = `resuto.adPurchase.${await purchaseEventId(orderRef)}`;
      try { if (localStorage.getItem(key)) return; } catch { /* storage blocked: the server event still counts */ }
      const d = await api<{ fire: boolean; eventId?: string; valueMinor?: number; currency?: string }>(
        `/public/tracking/${encodeURIComponent(slug)}/orders/${encodeURIComponent(orderRef)}/purchase`).catch(() => null);
      if (!d?.fire || !d.eventId) return;
      pixelTrack('Purchase', { value: (d.valueMinor ?? 0) / 100, currency: d.currency }, d.eventId);
      try { localStorage.setItem(key, '1'); } catch { /* ignore */ }
    })();
  }, [slug, orderRef, ready]);
  return <MetaPixel slug={slug} />;
}
