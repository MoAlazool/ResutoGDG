'use client';
// First-party funnel beacons from the guest pages (21-CRM, plan §6.7): page_view (1 in 4 tab sessions), qr_scan,
// add_to_cart and checkout_started go to POST /v1/public/funnel/beacon with navigator.sendBeacon (fetch keepalive when
// it is missing or refuses). No dependency and a few hundred bytes: the guest bundle budget (170 kB) holds.
//
// What is sent: the event, the page group, the restaurant's public slug, the branch the page shows and a random tab id
// kept in sessionStorage (gone when the tab closes; no cookie, no localStorage, no fingerprint). Never a name, phone,
// customer id, URL or referrer. These are aggregate operational counts for the restaurant, not advertising: they go to
// Resuto only, so they do not wait for the ad-measurement prompt (lib/tracking/MetaPixel.tsx), which still gates every
// third-party Pixel. Basis and retention: docs/security/FUNNEL_BEACONS.md.
import { useEffect } from 'react';
import { FUNNEL_SESSION_ID, funnelPageViewSampled, type FunnelBeaconEvent, type FunnelSurface } from '@resuto/contracts/lite';
import { API_URL } from './api';

const KEY = 'resuto.fsid';
let memoryId: string | null = null;
/** Events already sent from this page load (each counts once per page: the report counts distinct tab sessions). */
const sent = new Set<string>();

function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63];
  return s;
}

/** The random per-tab id (sessionStorage; an in-memory one when storage is blocked). */
export function funnelTabId(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeSession()): string {
  try {
    const v = storage?.getItem(KEY);
    if (v && FUNNEL_SESSION_ID.test(v)) return v;
    const id = newId();
    storage?.setItem(KEY, id);
    return id;
  } catch {
    return (memoryId ??= newId());
  }
}

function safeSession(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}

/** The body of one beacon, or null when nothing should be sent (page view outside the sample, missing slug). */
export function beaconBody(e: FunnelBeaconEvent, s: FunnelSurface, slug: string | null | undefined, branchId: string | null | undefined, sid: string): string | null {
  if (!slug || !/^[a-z0-9-]{1,60}$/.test(slug)) return null;
  if (e === 'page_view' && !funnelPageViewSampled(sid)) return null;
  return JSON.stringify({ e, s, o: slug, ...(branchId && /^[0-9a-f-]{36}$/i.test(branchId) ? { b: branchId } : {}), sid });
}

/** Sends one funnel event, at most once per page load for each (event, page group, restaurant). Never throws. */
export function funnelBeacon(e: FunnelBeaconEvent, s: FunnelSurface, slug: string | null | undefined, branchId?: string | null): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const once = `${e}:${s}:${slug}`;
  if (sent.has(once)) return false;
  const body = beaconBody(e, s, slug, branchId, funnelTabId());
  if (!body) return false;
  sent.add(once);
  const url = `${API_URL}/v1/public/funnel/beacon`;
  try {
    // A string body goes as text/plain: no CORS preflight, and it survives the page being closed or navigated away.
    if (navigator.sendBeacon?.(url, body)) return true;
  } catch { /* fall through */ }
  try {
    void fetch(url, { method: 'POST', body, keepalive: true, mode: 'no-cors', credentials: 'omit', headers: { 'Content-Type': 'text/plain' } }).catch(() => undefined);
  } catch { /* offline or blocked: the count is a lower bound */ }
  return true;
}

/**
 * The page's funnel events: a page view (and a QR scan on QR pages) once the restaurant is known; `added()` when the
 * guest adds to the cart and `checkout()` when they open the checkout or send the order (each once per page load).
 */
export function useFunnel(surface: FunnelSurface, slug: string | null | undefined, opts: { branchId?: string | null; qr?: boolean } = {}) {
  const { branchId, qr } = opts;
  useEffect(() => {
    if (!slug) return;
    funnelBeacon('page_view', surface, slug, branchId);
    if (qr) funnelBeacon('qr_scan', surface, slug, branchId);
  }, [surface, slug, branchId, qr]);
  return {
    added: () => funnelBeacon('add_to_cart', surface, slug, branchId),
    checkout: () => funnelBeacon('checkout_started', surface, slug, branchId),
  };
}

/** The cart with add / addMany reporting add_to_cart (a cart restored from the tab's storage is not an add). */
export function trackedCart<C extends { add: (...a: never[]) => void; addMany: (...a: never[]) => void }>(cart: C, added: () => void): C {
  return {
    ...cart,
    add: ((...a: Parameters<C['add']>) => { (cart.add as (...x: unknown[]) => void)(...a); added(); }) as C['add'],
    addMany: ((...a: Parameters<C['addMany']>) => { (cart.addMany as (...x: unknown[]) => void)(...a); added(); }) as C['addMany'],
  };
}

/** For tests: forget what this page load already sent. */
export function resetFunnelBeacons() { sent.clear(); memoryId = null; }
