// @vitest-environment jsdom
import { FUNNEL_PAGE_VIEW_WEIGHT, FUNNEL_SESSION_ID, funnelBeacon as schema, funnelPageViewSampled } from '@resuto/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beaconBody, funnelBeacon, funnelTabId, resetFunnelBeacons, trackedCart } from './funnel-beacon';

// 21-CRM: the guest pages' funnel beacon helper. Tiny body with no personal data, page views sampled per tab session,
// sendBeacon first with a fetch keepalive fallback, once per page load, never a third-party call.

const BRANCH = '0b5a3c7e-1f2d-4c3b-9a8e-7d6c5b4a3f21';
const sampled = (want: boolean) => { for (let i = 0; ; i++) { const s = `tab-session-${i}-abcdef`; if (funnelPageViewSampled(s) === want) return s; } };

beforeEach(() => { resetFunnelBeacons(); sessionStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('beacon body', () => {
  it('carries only the event, page group, slug, branch and tab id, and passes the API schema', () => {
    const sid = sampled(true);
    const body = beaconBody('page_view', 'm', 'olive-room', BRANCH, sid)!;
    expect(JSON.parse(body)).toEqual({ e: 'page_view', s: 'm', o: 'olive-room', b: BRANCH, sid });
    expect(schema.parse(JSON.parse(body))).toBeTruthy();
    expect(body.length).toBeLessThan(160);
    // Nothing identifying.
    expect(body).not.toMatch(/phone|email|name|customer|url|href|referr|cookie|ua/i);
  });

  it('samples page views per tab session (about 1 in 4), never the other events', () => {
    expect(beaconBody('page_view', 'r', 'olive', null, sampled(false))).toBeNull();
    expect(beaconBody('page_view', 'r', 'olive', null, sampled(true))).not.toBeNull();
    expect(beaconBody('qr_scan', 't', 'olive', null, sampled(false))).not.toBeNull();
    expect(beaconBody('add_to_cart', 'order', 'olive', null, sampled(false))).not.toBeNull();
    const ids = Array.from({ length: 2000 }, (_, i) => `tab-${i}-${Math.random().toString(36).slice(2, 14)}`);
    const share = ids.filter(funnelPageViewSampled).length / ids.length;
    expect(share).toBeGreaterThan(1 / FUNNEL_PAGE_VIEW_WEIGHT - 0.04);
    expect(share).toBeLessThan(1 / FUNNEL_PAGE_VIEW_WEIGHT + 0.04);
  });

  it('drops a malformed slug and a branch that is not an id', () => {
    expect(beaconBody('qr_scan', 't', 'Not A Slug', null, 'x'.repeat(20))).toBeNull();
    expect(beaconBody('qr_scan', 't', null, null, 'x'.repeat(20))).toBeNull();
    expect(JSON.parse(beaconBody('qr_scan', 't', 'olive', '<script>', 'x'.repeat(20))!)).not.toHaveProperty('b');
  });
});

describe('tab id', () => {
  it('is random, kept for the tab in sessionStorage (never localStorage or a cookie)', () => {
    const a = funnelTabId();
    expect(a).toMatch(FUNNEL_SESSION_ID);
    expect(funnelTabId()).toBe(a);
    expect(sessionStorage.getItem('resuto.fsid')).toBe(a);
    expect(Object.keys(localStorage)).toEqual([]);
    expect(document.cookie).toBe('');
    sessionStorage.clear();
    expect(funnelTabId()).not.toBe(a);
  });

  it('falls back to an in-memory id when storage is blocked', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const id = funnelTabId(blocked);
    expect(id).toMatch(FUNNEL_SESSION_ID);
    expect(funnelTabId(blocked)).toBe(id);
  });
});

describe('sending', () => {
  it('uses navigator.sendBeacon with a text body, once per page load', () => {
    const send = vi.fn(() => true);
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: send });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(funnelBeacon('qr_scan', 't', 'olive', BRANCH)).toBe(true);
    expect(funnelBeacon('qr_scan', 't', 'olive', BRANCH)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, body] = send.mock.calls[0] as unknown as [string, string];
    expect(url).toMatch(/\/v1\/public\/funnel\/beacon$/);
    expect(typeof body).toBe('string');
    expect(JSON.parse(body)).toMatchObject({ e: 'qr_scan', s: 't', o: 'olive', b: BRANCH });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to fetch keepalive (no credentials, text/plain) when sendBeacon is missing or refuses', () => {
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: () => false });
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchSpy);
    funnelBeacon('checkout_started', 'order', 'olive');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' } });
  });

  it('never throws, even when both transports fail', () => {
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: () => { throw new Error('nope'); } });
    vi.stubGlobal('fetch', () => { throw new Error('offline'); });
    expect(() => funnelBeacon('add_to_cart', 'v', 'olive')).not.toThrow();
  });

  it('does not depend on, or touch, the ad-measurement Pixels', () => {
    const fbq = vi.fn();
    (window as unknown as { fbq: typeof fbq }).fbq = fbq;
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: vi.fn(() => true) });
    funnelBeacon('qr_scan', 'v', 'olive');
    expect(fbq).not.toHaveBeenCalled();
    expect(document.querySelectorAll('script').length).toBe(0);
    delete (window as unknown as { fbq?: unknown }).fbq;
  });

  it('reports add_to_cart from cart writes only (a cart restored from the tab is not an add)', () => {
    const added = vi.fn();
    const cart = { items: [], count: 0, add: vi.fn(), addMany: vi.fn(), clear: vi.fn() };
    const tracked = trackedCart(cart, added);
    tracked.add('p1' as never);
    tracked.addMany([] as never);
    expect(cart.add).toHaveBeenCalledWith('p1');
    expect(added).toHaveBeenCalledTimes(2);
    tracked.clear();
    expect(added).toHaveBeenCalledTimes(2);
  });
});
