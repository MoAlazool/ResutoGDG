'use client';
// Guest-site ad Pixels (INT-20 Meta; INT-23 TikTok and Snap). Pages mount it with one line; everything else (config,
// consent prompt, Pixels, browser ids, the consented order context and the deduplicated Purchase) lives here. Renders
// nothing when the restaurant does not measure ads, which is the case for every demo restaurant. One prompt covers
// every connected platform and names them; nothing loads before the guest allows it.
import { useEffect, useRef, useState } from 'react';
import { api, API_URL } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { ensureBrowserIds, installPixel, pixelTrack, purchaseEventId, readConsent, readCookie, writeConsent, type Consent } from './meta';
import { hasAnyPixel, partnersOf, type TrackingConfig } from './partners';

// TikTok and Snap code loads only for a restaurant that connected them and a guest who allowed it, so guest pages
// without those Pixels (every demo restaurant) do not carry it.
type TiktokModule = typeof import('./tiktok');
type SnapModule = typeof import('./snap');
let tiktok: TiktokModule | null = null;
let snap: SnapModule | null = null;

const hasAny = hasAnyPixel;

/** Standard events in each platform's vocabulary. */
const TIKTOK_EVENT: Record<string, string> = { ViewContent: 'ViewContent', AddToCart: 'AddToCart', InitiateCheckout: 'InitiateCheckout' };
const SNAP_EVENT: Record<string, string> = { ViewContent: 'VIEW_CONTENT', AddToCart: 'ADD_CART', InitiateCheckout: 'START_CHECKOUT' };

/** The restaurant's Pixels once the guest agreed on this device; null otherwise. Module state, shared by the helpers below. */
let active: { slug: string; cfg: TrackingConfig; consentVersion: string } | null = null;
const configs = new Map<string, Promise<TrackingConfig | null>>();

function loadConfig(slug: string) {
  if (!configs.has(slug)) configs.set(slug, api<TrackingConfig>(`/public/tracking/${encodeURIComponent(slug)}`).catch(() => null));
  return configs.get(slug)!;
}

const session = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* blocked storage: only this page's URL counts */ } },
};

async function activate(slug: string, cfg: TrackingConfig) {
  if (!hasAny(cfg)) return;
  const first = active?.slug !== slug;
  if (cfg.meta) { ensureBrowserIds(); installPixel(cfg.meta.pixelId); }
  const [tt, sc] = await Promise.all([
    cfg.tiktok ? (tiktok ??= await import('./tiktok')) : null,
    cfg.snap ? (snap ??= await import('./snap')) : null,
  ]);
  if (cfg.tiktok && tt) {
    tt.installTiktokPixel(cfg.tiktok.pixelId);
    const click = tt.ttclidFromSearch(location.search); if (click) session.set('resuto.ttclid', click);
  }
  if (cfg.snap && sc) {
    sc.installSnapPixel(cfg.snap.pixelId);
    const click = sc.scClickIdFromSearch(location.search); if (click) session.set('resuto.sccid', click);
  }
  active = { slug, cfg, consentVersion: cfg.consentVersion };
  if (first && cfg.meta) pixelTrack('PageView');
}

/** A standard event from the site (AddToCart, InitiateCheckout, …) to every allowed Pixel. No-op without consent. */
export function metaTrack(slug: string, event: string, data: Record<string, unknown> = {}) {
  if (active?.slug !== slug) return;
  const id = `${event}.${crypto.randomUUID?.() ?? Date.now()}`;
  if (active.cfg.meta) pixelTrack(event, data, id);
  if (active.cfg.tiktok && TIKTOK_EVENT[event]) tiktok?.tiktokTrack(TIKTOK_EVENT[event]!, data, id);
  if (active.cfg.snap && SNAP_EVENT[event]) snap?.snapTrack(SNAP_EVENT[event]!, id);
}

/**
 * A web order was placed: hand the API what the guest agreed to share for it (browser ids and this page's URL; the API
 * adds the IP address and user agent it sees). `keepalive` lets it finish while the page moves on to payment.
 */
export function metaOrderPlaced(slug: string, publicRef: string) {
  if (active?.slug !== slug) return;
  const { fbp, fbc } = active.cfg.meta ? ensureBrowserIds() : { fbp: null, fbc: null };
  const ok = (v: string | null, re: RegExp) => (v && re.test(v) ? v : null);
  const ids = {
    ...(active.cfg.tiktok ? { ttp: ok(readCookie('_ttp'), /^[A-Za-z0-9._-]{8,200}$/), ttclid: ok(session.get('resuto.ttclid'), /^[A-Za-z0-9._-]{8,500}$/) } : {}),
    ...(active.cfg.snap ? { scid: ok(readCookie('_scid'), /^[A-Za-z0-9-]{8,100}$/), scClickId: ok(session.get('resuto.sccid'), /^[A-Za-z0-9._-]{8,500}$/) } : {}),
  };
  void fetch(`${API_URL}/v1/public/tracking/${encodeURIComponent(slug)}/orders/${encodeURIComponent(publicRef)}/context`, {
    method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ consentVersion: active.consentVersion, fbp, fbc, pageUrl: location.href.split('#')[0]!.slice(0, 1000), ...ids }),
  }).catch(() => undefined);
}

/** Loads the restaurant's tracking config, asks for consent once per prompt version, then runs the Pixel. */
export function MetaPixel({ slug, view }: { slug: string; view?: 'ViewContent' }) {
  const { t, tn } = useT();
  const [ask, setAsk] = useState<TrackingConfig | null>(null);
  useEffect(() => {
    let live = true;
    void loadConfig(slug).then((cfg) => {
      if (!live || !hasAny(cfg)) return;
      const c = readConsent(slug, cfg.consentVersion);
      if (c === 'granted') void activate(slug, cfg).then(() => { if (view) metaTrack(slug, view); });
      else if (c === null) setAsk(cfg);
    });
    return () => { live = false; };
  }, [slug, view]);
  if (!ask) return null;
  const answer = (c: Consent) => {
    writeConsent(slug, ask.consentVersion, c);
    if (c === 'granted') void activate(slug, ask).then(() => { if (view) metaTrack(slug, view); });
    setAsk(null);
  };
  return (
    <div role="dialog" aria-modal="false" aria-labelledby="ad-consent-title" className="g-card card" data-testid="ad-consent"
      style={{ position: 'fixed', insetInline: 12, bottom: 88, zIndex: 60, maxWidth: 520, marginInline: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,.18)' }}>
      <strong id="ad-consent-title">{t('marketing.consent.title')}</strong>
      <p className="fine" style={{ margin: '6px 0 10px' }}>{tn('marketing.consent.bodyPartners', { partners: <bdi dir="ltr">{partnersOf(ask)}</bdi> })}</p>
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
      if (!hasAny(cfg) || readConsent(slug, cfg.consentVersion) !== 'granted') return;
      await activate(slug, cfg);
      const key = `resuto.adPurchase.${await purchaseEventId(orderRef)}`;
      try { if (localStorage.getItem(key)) return; } catch { /* storage blocked: the server event still counts */ }
      const d = await api<{ fire: boolean; eventId?: string; valueMinor?: number; currency?: string; pixels?: Array<'meta' | 'tiktok' | 'snap'> }>(
        `/public/tracking/${encodeURIComponent(slug)}/orders/${encodeURIComponent(orderRef)}/purchase`).catch(() => null);
      if (!d?.fire || !d.eventId) return;
      // Same event id as the server events of every platform (each deduplicates its own pair). Without `pixels` only Meta fires.
      const pixels = new Set(d.pixels ?? ['meta']);
      const value = (d.valueMinor ?? 0) / 100;
      if (pixels.has('meta') && cfg.meta) pixelTrack('Purchase', { value, currency: d.currency }, d.eventId);
      if (pixels.has('tiktok') && cfg.tiktok) tiktok?.tiktokTrack('CompletePayment', { value, currency: d.currency, content_type: 'product' }, d.eventId);
      if (pixels.has('snap') && cfg.snap) snap?.snapPurchase(value, d.currency ?? '', d.eventId);
      try { localStorage.setItem(key, '1'); } catch { /* ignore */ }
    })();
  }, [slug, orderRef, ready]);
  return <MetaPixel slug={slug} />;
}
